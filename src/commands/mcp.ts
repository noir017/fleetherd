import { createInterface } from 'node:readline';
import { PassThrough, type Readable } from 'node:stream';
import { encode } from '@toon-format/toon';
import { callDaemon, clientTimeoutFor, parseEnvTimeout } from '../ipc/client.js';
import type { IpcAction, IpcResponse } from '../ipc/protocol.js';
import { findNativeTool, NATIVE_TOOLS, toolAction, toolInputSchema } from '../ipc/tools.js';
import { friendlyError, normalizeActionPaths, renderResult } from './reverse.js';
import { envOf } from '../legacy-name.js';

/**
 * `fleetherd mcp` — an MCP server on stdio that gives an agent `send_file`, `schedule` and `skills`
 * as native tools (see ipc/tools.ts for why those three). The daemon lists it in `session/new`'s
 * `mcpServers` for every ACP session, and the harness starts one per session as its own child.
 *
 * It is a reverse command with a different front door: a tool call becomes the IpcAction the same
 * command would build from a shell (`toolAction`, the spec's own `build`), goes over the same socket
 * with the same session token, and answers with the same TOON a shell would print (`renderResult`).
 * The trust boundary does not move — the daemon validates the request exactly as it validates one
 * from the CLI.
 *
 * Everything it needs comes from the environment the daemon wrote into the server's ACP entry,
 * never from config.yaml: a harness may start MCP servers with an environment of its own choosing
 * (codex passes a short allowlist plus what the entry names), so neither the daemon's variables nor
 * the `${VAR}`s config.yaml expands can be assumed to be there.
 *  - FLEETHERD_TURN_TOKEN — the session's token (read by callDaemon).
 *  - FLEETHERD_SOCKET — the daemon's socket.
 *  - FLEETHERD_CWD — the session's working directory, which relative paths are resolved
 *    against. Not this process's CWD: ACP's stdio entry has no `cwd`, so where the harness starts
 *    the server is up to the harness.
 *
 * Hand-rolled rather than built on @modelcontextprotocol/sdk. The surface is four methods with no
 * state (initialize, ping, tools/list, tools/call), and doing it here keeps the message handling a
 * pure function the tests can drive, with nothing between it and the wire to version-skew.
 *
 * stdout is the protocol stream and nothing else: one JSON-RPC message per line. Anything meant
 * for a human goes to stderr, which the harness keeps out of the stream.
 *
 * An agent on a remote host gets the same server without a process of its own: the host's shim
 * carries `fleetherd mcp` back to the gateway, and the daemon serves it in-process (`mcpSession`)
 * instead of spawning this CLI. That is the gateway's memory, not a convenience. A spawned server
 * lives as long as its session — an hour past the last message, by `session.idleTimeoutMs` — and
 * each one cost about 60 MB of its own (measured 2026-11-15 in the gateway's container: two
 * sessions, Pss_Anon 60 MB apiece next to a 187 MB daemon, under a 1 GB limit). Every remote
 * session holding one, a handful of sub-agents was enough to fill the container.
 */

/** MCP revisions this server can answer in, newest first. The tool surface used is the same in all. */
export const MCP_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;

type JsonRpcId = string | number | null;

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface McpDeps {
  /** Send one action to the daemon. */
  call(action: IpcAction): Promise<IpcResponse>;
  /** The session's working directory: relative paths resolve against it. */
  cwd: string;
  /** What `~` means; unset, the CLI's own answer (normalizeActionPaths). */
  home?: string;
  /** The daemon's socket, named in connection errors. */
  socket: string;
  /** This CLI's version, reported as serverInfo. */
  version: string;
}

/** JSON-RPC error codes this server answers with (the spec's reserved range). */
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

const fail = (id: JsonRpcId, code: number, message: string): JsonRpcResponse => ({
  jsonrpc: '2.0',
  id,
  error: { code, message },
});

/**
 * Answer one incoming JSON-RPC message, or return undefined when it wants no answer — a
 * notification (`notifications/initialized`, `notifications/cancelled`), or a response to a request
 * this server never sends.
 */
export async function handleMcpMessage(msg: unknown, deps: McpDeps): Promise<JsonRpcResponse | undefined> {
  if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) return fail(null, INVALID_REQUEST, 'Invalid Request');
  const m = msg as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
  const id = typeof m.id === 'string' || typeof m.id === 'number' ? m.id : null;
  if (typeof m.method !== 'string') return undefined; // a response, or noise: nothing to answer
  if (m.id === undefined) return undefined; // a notification
  if (m.jsonrpc !== '2.0') return fail(id, INVALID_REQUEST, 'Invalid Request: jsonrpc must be "2.0"');
  try {
    const result = await dispatch(m.method, m.params, deps);
    return 'error' in result ? { jsonrpc: '2.0', id, error: result.error } : { jsonrpc: '2.0', id, result: result.ok };
  } catch (e) {
    return fail(id, INTERNAL_ERROR, e instanceof Error ? e.message : String(e));
  }
}

type Outcome = { ok: unknown } | { error: { code: number; message: string } };

async function dispatch(method: string, params: unknown, deps: McpDeps): Promise<Outcome> {
  switch (method) {
    case 'initialize':
      return { ok: initializeResult(params, deps.version) };
    case 'ping':
      return { ok: {} };
    case 'tools/list':
      return { ok: { tools: await listTools(deps) } };
    case 'tools/call':
      return callTool(params, deps);
    default:
      return { error: { code: METHOD_NOT_FOUND, message: `Method not found: ${method}` } };
  }
}

/**
 * The tools, with the `skills` tool's description ending in what the library holds — the names of
 * its skills by category, or how many each category has once there are too many names. That line
 * is what tells a model the library is worth a look before it starts on something: a description
 * alone says a library exists, not that it has a skill about the CLI it is about to configure.
 * Asked of the daemon once per session (a harness lists tools at start); a daemon that does not
 * answer in time leaves the description as written.
 *
 * Names, not counts, since 2026-11-07: with only `In the library: 协作 3, other 4.` the four skills
 * the review had written in two days were read twice in all, and an agent spent a turn on agy's
 * context accounting with `antigravity-config` in the library, never searching for it — six
 * searches in 19 hours, across every conversation. A name costs a few tokens on every request;
 * past LIBRARY_NAMES_MAX the line goes back to counts, so a large library does not grow the tool.
 */
async function listTools(deps: McpDeps): Promise<Array<{ name: string; description: string; inputSchema: unknown }>> {
  let library = '';
  try {
    const res = await Promise.race([
      deps.call({ kind: 'skills', action: 'categories' }),
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 3000).unref?.()),
    ]);
    if (res?.ok) library = libraryLine(res.data);
  } catch {
    // no daemon, or no answer: the tool still works, its description just says less
  }
  return NATIVE_TOOLS.map((t) => ({
    name: t.name,
    description: t.name === 'skills' && library ? `${t.description} ${library}` : t.description,
    inputSchema: toolInputSchema(t),
  }));
}

/** How many library skills the `skills` tool's description names before it falls back to counts. */
export const LIBRARY_NAMES_MAX = 40;

/**
 * From the daemon's `skills categories` answer: `In the library: 协作: grilling, siyuan-notes;
 * other: email-reader.` — the library skills that reach this agent, by category — or
 * `In the library: 运维 6, 开发 2, other 3.` past LIBRARY_NAMES_MAX names, or from a daemon that
 * does not send names. Empty when the library has nothing for this agent.
 */
export function libraryLine(result: unknown): string {
  const r = result as { library?: number; categories?: Array<{ name: string; count: number; library?: unknown }> } | undefined;
  if (!r?.library || !Array.isArray(r.categories) || r.categories.length === 0) return '';
  const named = r.categories.map((c) => ({
    name: c.name,
    skills: Array.isArray(c.library) ? c.library.filter((n): n is string => typeof n === 'string') : undefined,
  }));
  if (named.every((c) => c.skills !== undefined)) {
    const total = named.reduce((n, c) => n + c.skills!.length, 0);
    if (total === 0) return '';
    if (total <= LIBRARY_NAMES_MAX) {
      return `In the library: ${named
        .filter((c) => c.skills!.length > 0)
        .map((c) => `${c.name}: ${c.skills!.join(', ')}`)
        .join('; ')}.`;
    }
  }
  return `In the library: ${r.categories.map((c) => `${c.name} ${c.count}`).join(', ')}.`;
}

/**
 * Version negotiation per the spec: answer in the client's revision when this server knows it,
 * otherwise in the newest one it knows and let the client decide whether it can live with that.
 *
 * No `instructions`: the field exists, and Claude Code puts it into the system prompt — which is
 * exactly the kind of text from the gateway this server exists to avoid.
 */
function initializeResult(params: unknown, version: string): unknown {
  const asked = (params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
  const protocolVersion = (MCP_PROTOCOL_VERSIONS as readonly unknown[]).includes(asked)
    ? (asked as string)
    : MCP_PROTOCOL_VERSIONS[0];
  return {
    protocolVersion,
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: 'fleetherd', version },
  };
}

/** A tool result the model reads: text, flagged as an error when the call did not happen. */
const toolText = (text: string, isError = false): Outcome => ({
  ok: { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) },
});

/**
 * tools/call. An unknown tool is a protocol error (the spec's -32602), but everything after that
 * is a tool result with `isError` — bad arguments, a daemon that refused — because those are for
 * the model to read and correct, and a protocol error is what a harness shows to nobody.
 */
async function callTool(params: unknown, deps: McpDeps): Promise<Outcome> {
  const p = (params ?? {}) as { name?: unknown; arguments?: unknown };
  const tool = typeof p.name === 'string' ? findNativeTool(p.name) : undefined;
  if (!tool) return { error: { code: INVALID_PARAMS, message: `Unknown tool: ${String(p.name)}` } };

  let action: IpcAction;
  try {
    action = normalizeActionPaths(toolAction(tool, p.arguments), deps.cwd, deps.home);
  } catch (e) {
    return toolText(encode({ error: e instanceof Error ? e.message : String(e) }), true);
  }
  const resp = await deps.call(action);
  if (!resp.ok) return toolText(encode(friendlyError(resp.error, deps.socket)), true);
  const out = renderResult(action, resp.data);
  return toolText([out.stdout, out.stderr].filter(Boolean).join('\n'));
}

/** Entry point for `fleetherd mcp`: serve stdin → stdout until stdin closes. */
export async function runMcp(version: string): Promise<void> {
  const socket = envOf('SOCKET') ?? '';
  const deps: McpDeps = {
    socket,
    version,
    cwd: envOf('CWD') || process.cwd(),
    call: (action) =>
      socket
        ? callDaemon(socket, action, undefined, clientTimeoutFor(action))
        : Promise.resolve({
            ok: false,
            error: 'FLEETHERD_SOCKET is not set: this server is started by a fleetherd session, not by hand',
          }),
  };
  await serveMcp(process.stdin, (line) => process.stdout.write(line), deps);
}

/**
 * Answer the JSON-RPC lines read from `input` until it ends, each answer one line handed to `write`.
 * Resolves once the input has ended and every call in flight has been answered.
 */
export async function serveMcp(input: Readable, write: (line: string) => void, deps: McpDeps): Promise<void> {
  const send = (r: JsonRpcResponse | JsonRpcResponse[]): void => write(`${JSON.stringify(r)}\n`);
  // Calls are answered as they finish, not in arrival order: a slow upload must not hold up a ping.
  const inFlight = new Set<Promise<void>>();
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      send(fail(null, PARSE_ERROR, 'Parse error'));
      continue;
    }
    const answer = Array.isArray(msg)
      ? Promise.all(msg.map((one) => handleMcpMessage(one, deps))).then((rs) => {
          // A batch (allowed by revisions before 2025-06-18) is answered as one array, or not at all.
          const answered = rs.filter((r): r is JsonRpcResponse => r !== undefined);
          if (answered.length) send(answered);
        })
      : handleMcpMessage(msg, deps).then((r) => {
          if (r) send(r);
        });
    const tracked = answer.catch((e: unknown) => console.error('[mcp]', e instanceof Error ? e.message : e));
    inFlight.add(tracked);
    void tracked.finally(() => inFlight.delete(tracked));
  }
  await Promise.allSettled(inFlight);
}

/**
 * The longest line an in-process session reads before giving up on it. A spawned server had no
 * limit and needed none — what it buffered was its own memory, and the kernel's to reclaim when it
 * died; in-process the line would sit in the daemon. Generous on purpose: the daemon refuses any
 * request over 1 MiB itself (ipc/server.ts MAX_LINE_BYTES), so nothing this cuts could have gone
 * through, and a tool call is JSON-escaped once more than the request it becomes.
 */
export const MAX_SESSION_LINE_BYTES = 4 << 20;

/** One remote session's server, as the daemon serves it in-process (see the header). */
export interface McpSessionOptions {
  /** The session's turn token, which every call carries: the daemon checks it like any other. */
  token: string;
  socket: string;
  cwd: string;
  /** The host's home, which `~` means. */
  home: string;
  version: string;
  /** The caller's FLEETHERD_IPC_TIMEOUT_MS, which a spawned server would have read itself. */
  ipcTimeoutMs?: string;
}

/**
 * Serve one session in this process. The shapes are remote/host.ts's `CliIO` and `CliSession`,
 * restated rather than imported because commands/ does not reach into remote/ (AGENTS.md
 * Layering); TypeScript holds them to it structurally where daemon/remote-hosts.ts passes this on.
 *
 * Killed, it answers nothing more and exits at once, as a killed process would. A call already on
 * its way to the daemon is not called back — it runs to its own timeout and its answer is dropped.
 */
export function mcpSession(
  opts: McpSessionOptions,
  io: { out(fd: 1 | 2, data: Buffer): void; exit(code: number): void }
): { write(data: Buffer): void; end(): void; kill(): void } {
  const callerTimeout = parseEnvTimeout(opts.ipcTimeoutMs);
  const deps: McpDeps = {
    socket: opts.socket,
    version: opts.version,
    cwd: opts.cwd,
    home: opts.home,
    call: (action) => {
      // The same bound callDaemon works out from its environment, with the caller's variable in
      // place of this process's: the larger of the two for a blocking call, the caller's otherwise.
      const own = clientTimeoutFor(action);
      return callDaemon(opts.socket, action, opts.token, own !== undefined ? Math.max(callerTimeout ?? 0, own) : callerTimeout);
    },
  };
  const input = new PassThrough();
  let closed = false;
  let pending = 0;
  const finish = (code: number): void => {
    if (closed) return;
    closed = true;
    io.exit(code);
  };
  const stop = (code: number): void => {
    finish(code);
    input.destroy();
  };
  serveMcp(input, (line) => (closed ? undefined : io.out(1, Buffer.from(line))), deps).then(
    () => finish(0),
    (e: unknown) => {
      console.error('[mcp]', e instanceof Error ? e.message : e);
      finish(1);
    }
  );
  return {
    write: (data) => {
      if (closed) return;
      pending = lineTail(data, pending);
      if (pending > MAX_SESSION_LINE_BYTES) {
        io.out(2, Buffer.from(`fleetherd mcp: a message longer than ${MAX_SESSION_LINE_BYTES} bytes; closing\n`));
        stop(1);
        return;
      }
      input.write(data);
    },
    end: () => input.end(),
    kill: () => stop(1),
  };
}

/**
 * The length of the line still open after `data`, given `pending` bytes of it before; Infinity as
 * soon as any line in it runs past the limit, so a long line in the middle of a chunk counts too.
 */
function lineTail(data: Buffer, pending: number): number {
  let open = pending;
  let from = 0;
  for (;;) {
    const nl = data.indexOf(0x0a, from);
    open += (nl === -1 ? data.length : nl) - from;
    if (open > MAX_SESSION_LINE_BYTES) return Infinity;
    if (nl === -1) return open;
    open = 0;
    from = nl + 1;
  }
}
