import { createInterface } from 'node:readline';
import { PassThrough, type Readable } from 'node:stream';
import { encode } from '@toon-format/toon';
import { callDaemon, clientTimeoutFor, parseEnvTimeout } from '../ipc/client.js';
import {
  answerMcpMessage,
  answerMcpPayload,
  PARSE_ERROR,
  rpcError,
  type JsonRpcResponse,
  type McpServer,
  type McpTool,
  type McpToolText,
} from '../ipc/mcp-rpc.js';
import type { IpcAction, IpcResponse } from '../ipc/protocol.js';
import { findNativeTool, libraryLine, NATIVE_TOOLS, PRIVATE_NO_SKILLS, toolAction, toolInputSchema } from '../ipc/tools.js';
import { friendlyError, normalizeActionPaths, renderResult } from './reverse.js';
import { envOf } from '../legacy-name.js';

export { MCP_PROTOCOL_VERSIONS, type JsonRpcResponse } from '../ipc/mcp-rpc.js';
export { LIBRARY_NAMES_MAX, libraryLine } from '../ipc/tools.js';

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
 * The JSON-RPC half is ipc/mcp-rpc.ts, shared with the external entrance over HTTP
 * (daemon/external-mcp.ts); this file is the tools an agent's own session gets, and the stdio.
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

/**
 * Answer one incoming JSON-RPC message, or return undefined when it wants no answer — a
 * notification, or a response to a request this server never sends (ipc/mcp-rpc.ts).
 */
export function handleMcpMessage(msg: unknown, deps: McpDeps): Promise<JsonRpcResponse | undefined> {
  return answerMcpMessage(msg, nativeServer(deps));
}

/** The native tools as one MCP server, calling the daemon through `deps`. */
function nativeServer(deps: McpDeps): McpServer {
  return {
    version: deps.version,
    listTools: () => listTools(deps),
    callTool: (name, args) => callTool(name, args, deps),
  };
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
async function listTools(deps: McpDeps): Promise<McpTool[]> {
  let library = '';
  let noSkills = false;
  try {
    const res = await Promise.race([
      deps.call({ kind: 'skills', action: 'categories' }),
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 3000).unref?.()),
    ]);
    if (res?.ok) library = libraryLine(res.data);
    else if (res && res.error === PRIVATE_NO_SKILLS) noSkills = true;
  } catch {
    // no daemon, or no answer: the tool still works, its description just says less
  }
  const tools = noSkills ? NATIVE_TOOLS.filter((t) => t.name !== 'skills') : NATIVE_TOOLS;
  return tools.map((t) => ({
    name: t.name,
    description: t.name === 'skills' && library ? `${t.description} ${library}` : t.description,
    inputSchema: toolInputSchema(t),
    _meta: ALWAYS_LOAD,
  }));
}

/**
 * Claude Code defers MCP tools behind ToolSearch, so the first turn would see neither these tools nor
 * the library line; it loads a tool up front when `_meta["anthropic/alwaysLoad"] === true` (2.1.330,
 * measured). Every native tool is one an agent must know of before it starts (ipc/tools.ts).
 */
const ALWAYS_LOAD: Readonly<Record<string, unknown>> = { 'anthropic/alwaysLoad': true };

/**
 * tools/call. An unknown tool is a protocol error (the spec's -32602), but everything after that
 * is a tool result with `isError` — bad arguments, a daemon that refused — because those are for
 * the model to read and correct, and a protocol error is what a harness shows to nobody.
 */
async function callTool(name: string, args: unknown, deps: McpDeps): Promise<McpToolText | undefined> {
  const tool = findNativeTool(name);
  if (!tool) return undefined;
  let action: IpcAction;
  try {
    action = normalizeActionPaths(toolAction(tool, args), deps.cwd, deps.home);
  } catch (e) {
    return { text: encode({ error: e instanceof Error ? e.message : String(e) }), isError: true };
  }
  const resp = await deps.call(action);
  if (!resp.ok) return { text: encode(friendlyError(resp.error, deps.socket)), isError: true };
  const out = renderResult(action, resp.data);
  return { text: [out.stdout, out.stderr].filter(Boolean).join('\n') };
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
  const server = nativeServer(deps);
  // Calls are answered as they finish, not in arrival order: a slow upload must not hold up a ping.
  const inFlight = new Set<Promise<void>>();
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      send(rpcError(null, PARSE_ERROR, 'Parse error'));
      continue;
    }
    const answer = answerMcpPayload(msg, server).then((r) => {
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
