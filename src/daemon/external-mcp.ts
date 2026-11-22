import { createHash, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { encode } from '@toon-format/toon';
import type { Config } from '../config/schema.js';
import {
  externalAction,
  externalToolDefinition,
  type ExternalAction,
  type ExternalToolName,
} from '../ipc/external-tools.js';
import {
  answerMcpPayload,
  INVALID_REQUEST,
  MCP_PROTOCOL_VERSIONS,
  PARSE_ERROR,
  rpcError,
  type McpServer,
} from '../ipc/mcp-rpc.js';

/**
 * The external MCP entrance: an MCP server over HTTP (Streamable HTTP, JSON responses only) for
 * callers outside the gateway — a web agent reached through an MCP proxy — to search the skills and
 * propose sub-tasks (docs/external-mcp.md). Off unless config.yaml has an `mcp:` block.
 *
 * ── A trust boundary of its own ──────────────────────────────────────────────────────────────────
 * Everything else that reaches the daemon is either a person (a platform, the web UI behind its
 * login) or an agent the gateway started (the IPC socket, with that session's token). A caller here
 * is neither: it is a program somewhere else that reads untrusted pages and mail, so what it asks
 * for may have been written by whoever wrote those. What holds it (AGENTS.md security invariant 11):
 *  - its own bearer token, per caller, named in config by the environment variable that holds it
 *    and compared in constant time; never the web UI's login secret, which a token equal to it is
 *    refused for (a caller holding that would also hold the web UI);
 *  - the tools listed for it, and only two exist: `skills` reads, and `tasks` ends on a card a
 *    person has to tap (daemon/delegation.ts handleExternal, ipc/external-tools.ts);
 *  - the topics it opened: it sees and stops only sub-tasks under those (daemon.ts, external-topics.ts).
 *
 * ── Streamable HTTP, the small part of it ────────────────────────────────────────────────────────
 * POST /mcp with one JSON-RPC message or a batch; the answer is `application/json`, or 202 with no
 * body when nothing in it wanted one. No session (`Mcp-Session-Id`): every call is whole on its own,
 * which is what the four stateless methods need. No server-to-client stream, so GET is 405 as the
 * spec allows. A request with an `Origin` header is refused: no browser has a reason to call this,
 * and the spec asks a server to guard against DNS rebinding, which a browser request is.
 */

/** One configured caller, as the server sees it after its token was matched. */
export interface ExternalCaller {
  name: string;
  tools: ExternalToolName[];
  /** Agents whose own topics this caller may propose sub-tasks in directly. */
  agents?: string[];
}

export interface ExternalMcpDeps {
  /** The live `mcp:` block, read on every request: a reload swaps it in place. */
  settings(): Config['mcp'];
  /** The variables tokens are read from (process.env, after `.env`), read on every request. */
  env(): NodeJS.ProcessEnv;
  /** Secrets a caller's token must not equal: the web UI's login secrets. */
  reserved(): string[];
  /** Carry out one call; the answer is the text the model reads. Throws a message for the model. */
  call(caller: ExternalCaller, action: ExternalAction): Promise<string>;
  /** What the library holds, appended to the `skills` description (ipc/tools.ts libraryLine). */
  libraryLine?(caller: ExternalCaller): string;
  version: string;
}

/** The most a request body may be: what the IPC socket allows a request, and far beyond any tool call. */
export const MAX_BODY_BYTES = 1 << 20;

/**
 * The least a token may be. A token that short is one a person typed, and a caller's token is the
 * only thing between the network and the operator's sub-agent cards.
 */
export const MIN_TOKEN_CHARS = 24;

/** How often one remote address's refused logins are logged. */
const REFUSAL_LOG_MS = 60_000;

export class ExternalMcp {
  private server?: http.Server;
  /** `host:port` the server is bound to, to tell a reload that moved it. */
  private bound?: string;
  /** Problems with a caller's token already logged, so a request does not log them again. */
  private readonly warned = new Set<string>();
  private readonly refusedAt = new Map<string, number>();

  constructor(private readonly deps: ExternalMcpDeps) {}

  /**
   * Bring the listener in line with the settings: start it, stop it, or bind it again where a reload
   * moved it. Callers need nothing here — they are read per request.
   */
  async configure(): Promise<void> {
    const s = this.deps.settings();
    const want = s ? `${s.host}:${s.port}` : undefined;
    if (want === this.bound && this.server) return;
    await this.stop();
    if (!s) return;
    this.warned.clear();
    const server = http.createServer((req, res) => void this.serve(req, res));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(s.port, s.host, () => {
        server.off('error', reject);
        resolve();
      });
    });
    server.on('error', (e) => console.warn('[external-mcp] server error:', e.message));
    this.server = server;
    this.bound = want;
    const names = s.callers.map((c) => `${c.name} (${c.tools.join(', ')})`).join(', ') || 'no callers';
    console.log(`[external-mcp] listening on http://${want}/mcp — ${names}`);
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.bound = undefined;
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }

  /** The port actually bound (port 0 in tests), or undefined when not listening. */
  port(): number | undefined {
    const a = this.server?.address();
    return a && typeof a === 'object' ? (a as AddressInfo).port : undefined;
  }

  private async serve(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      await this.route(req, res);
    } catch (e) {
      console.warn('[external-mcp] request failed:', e instanceof Error ? e.message : e);
      if (!res.headersSent) send(res, 500, { error: 'internal error' });
      else res.end();
    }
  }

  private async route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const path = (req.url ?? '').split('?')[0];
    if (path !== '/mcp') return send(res, 404, { error: 'not found; the endpoint is /mcp' });
    if (req.headers.origin !== undefined) return send(res, 403, { error: 'requests from a browser are refused' });
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return send(res, 405, { error: 'POST only: this server offers no stream' });
    }
    const caller = this.authenticate(req);
    if (!caller) {
      res.setHeader('WWW-Authenticate', 'Bearer realm="fleetherd"');
      return send(res, 401, { error: 'unauthorized' });
    }
    const version = req.headers['mcp-protocol-version'];
    if (typeof version === 'string' && !(MCP_PROTOCOL_VERSIONS as readonly string[]).includes(version)) {
      return send(res, 400, rpcError(null, INVALID_REQUEST, `unsupported MCP-Protocol-Version ${version}; this server speaks ${MCP_PROTOCOL_VERSIONS.join(', ')}`));
    }
    if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
      return send(res, 415, rpcError(null, INVALID_REQUEST, 'Content-Type must be application/json'));
    }
    const body = await readBody(req);
    if (body === undefined) return send(res, 413, rpcError(null, INVALID_REQUEST, `a request is at most ${MAX_BODY_BYTES} bytes`));
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      return send(res, 400, rpcError(null, PARSE_ERROR, 'Parse error'));
    }
    const answer = await answerMcpPayload(payload, this.serverFor(caller));
    if (answer === undefined) {
      res.writeHead(202).end();
      return;
    }
    send(res, 200, answer);
  }

  /**
   * The caller whose token this request carries, or undefined. Every usable caller is compared,
   * whichever matched, so how long a refusal takes says nothing about which token came close; the
   * digests make every comparison the same length, so it says nothing about a token's length either.
   */
  private authenticate(req: http.IncomingMessage): ExternalCaller | undefined {
    const header = req.headers.authorization ?? '';
    const m = /^Bearer\s+(\S+)\s*$/i.exec(header);
    const given = m?.[1] ? digest(m[1]) : undefined;
    let match: ExternalCaller | undefined;
    for (const c of this.usableCallers()) {
      if (given && timingSafeEqual(given, c.digest) && !match) {
        const { digest: _digest, ...caller } = c;
        match = caller;
      }
    }
    if (!match) this.logRefusal(req, m ? 'a token no caller has' : 'no bearer token');
    return match;
  }

  /**
   * The callers whose token can be used now. A caller without one — its variable unset, too short,
   * or equal to a web UI login secret — is left out and logged once: refused, never let in on a
   * weaker check.
   */
  private usableCallers(): Array<ExternalCaller & { digest: Buffer }> {
    const s = this.deps.settings();
    if (!s) return [];
    const env = this.deps.env();
    const reserved = new Set(this.deps.reserved());
    const out: Array<ExternalCaller & { digest: Buffer }> = [];
    for (const c of s.callers) {
      const token = env[c.tokenEnv];
      const problem =
        token === undefined || token === ''
          ? `${c.tokenEnv} is not set`
          : token.length < MIN_TOKEN_CHARS
            ? `${c.tokenEnv} is shorter than ${MIN_TOKEN_CHARS} characters`
            : reserved.has(token)
              ? `${c.tokenEnv} holds the web UI's login secret, which a caller must not share`
              : undefined;
      if (problem) {
        const key = `${c.name}:${problem}`;
        if (!this.warned.has(key)) {
          this.warned.add(key);
          console.warn(`[external-mcp] caller "${c.name}" is refused: ${problem}`);
        }
        continue;
      }
      out.push({ name: c.name, tools: [...c.tools], ...(c.agents?.length ? { agents: [...c.agents] } : {}), digest: digest(token!) });
    }
    return out;
  }

  private logRefusal(req: http.IncomingMessage, why: string): void {
    const from = req.socket.remoteAddress ?? 'unknown';
    const now = Date.now();
    if (now - (this.refusedAt.get(from) ?? 0) < REFUSAL_LOG_MS) return;
    this.refusedAt.set(from, now);
    console.warn(`[external-mcp] refused a request from ${from}: ${why}`);
  }

  /** The MCP server one caller sees: only its own tools. */
  private serverFor(caller: ExternalCaller): McpServer {
    return {
      version: this.deps.version,
      listTools: async () =>
        caller.tools.map((name) => {
          const def = externalToolDefinition(name);
          const library = name === 'skills' ? (this.deps.libraryLine?.(caller) ?? '') : '';
          return library ? { ...def, description: `${def.description} ${library}` } : def;
        }),
      callTool: async (name, args) => {
        // A tool this caller was not given does not exist for it: the same answer as a name nobody has.
        if (!(caller.tools as string[]).includes(name)) return undefined;
        try {
          const action = externalAction(name as ExternalToolName, args);
          console.log(`[external-mcp] ${caller.name}: ${name} ${describe(action)}`);
          return { text: await this.deps.call(caller, action) };
        } catch (e) {
          return { text: encode({ error: e instanceof Error ? e.message : String(e) }), isError: true };
        }
      },
    };
  }
}

/** What a call was, for the log: the action, never its text. */
function describe(a: ExternalAction): string {
  switch (a.kind) {
    case 'skills':
      return a.action.action;
    case 'sessions':
      return a.action.kind;
    case 'open':
      return 'open';
    case 'topics':
      return 'list';
    case 'task':
      return a.in ? `${a.action.kind} in ${a.in}` : a.action.kind;
    default: {
      const _exhaustive: never = a;
      return String(_exhaustive);
    }
  }
}

function digest(s: string): Buffer {
  return createHash('sha256').update(s, 'utf8').digest();
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

/** The body as text, or undefined once it runs past MAX_BODY_BYTES (the rest is not read). */
function readBody(req: http.IncomingMessage): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on('data', (chunk: Buffer) => {
      if (over) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        over = true;
        resolve(undefined);
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!over) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}
