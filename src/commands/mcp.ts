import { createInterface } from 'node:readline';
import { encode } from '@toon-format/toon';
import { callDaemon } from '../ipc/client.js';
import type { IpcAction, IpcResponse } from '../ipc/protocol.js';
import { findNativeTool, NATIVE_TOOLS, toolAction, toolInputSchema } from '../ipc/tools.js';
import { friendlyError, normalizeActionPaths, renderResult } from './reverse.js';

/**
 * `talkcode mcp` — an MCP server on stdio that gives an agent `send_file` and `schedule` as
 * native tools (see ipc/tools.ts for why those two). The daemon lists it in `session/new`'s
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
 *  - TALKCODE_TURN_TOKEN — the session's token (read by callDaemon).
 *  - TALKCODE_SOCKET — the daemon's socket.
 *  - TALKCODE_CWD — the session's working directory, which relative paths are resolved
 *    against. Not this process's CWD: ACP's stdio entry has no `cwd`, so where the harness starts
 *    the server is up to the harness.
 *
 * Hand-rolled rather than built on @modelcontextprotocol/sdk. The surface is four methods with no
 * state (initialize, ping, tools/list, tools/call), and doing it here keeps the message handling a
 * pure function the tests can drive, with nothing between it and the wire to version-skew.
 *
 * stdout is the protocol stream and nothing else: one JSON-RPC message per line. Anything meant
 * for a human goes to stderr, which the harness keeps out of the stream.
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
      return {
        ok: { tools: NATIVE_TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: toolInputSchema(t) })) },
      };
    case 'tools/call':
      return callTool(params, deps);
    default:
      return { error: { code: METHOD_NOT_FOUND, message: `Method not found: ${method}` } };
  }
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
    serverInfo: { name: 'talkcode', version },
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
    action = normalizeActionPaths(toolAction(tool, p.arguments), deps.cwd);
  } catch (e) {
    return toolText(encode({ error: e instanceof Error ? e.message : String(e) }), true);
  }
  const resp = await deps.call(action);
  if (!resp.ok) return toolText(encode(friendlyError(resp.error, deps.socket)), true);
  const out = renderResult(action, resp.data);
  return toolText([out.stdout, out.stderr].filter(Boolean).join('\n'));
}

/** Entry point for `talkcode mcp`: serve stdin → stdout until stdin closes. */
export async function runMcp(version: string): Promise<void> {
  const socket = process.env.TALKCODE_SOCKET ?? '';
  const deps: McpDeps = {
    socket,
    version,
    cwd: process.env.TALKCODE_CWD || process.cwd(),
    call: (action) =>
      socket
        ? callDaemon(socket, action)
        : Promise.resolve({
            ok: false,
            error: 'TALKCODE_SOCKET is not set: this server is started by a talkcode session, not by hand',
          }),
  };
  const write = (r: JsonRpcResponse | JsonRpcResponse[]): void => {
    process.stdout.write(`${JSON.stringify(r)}\n`);
  };
  // Calls are answered as they finish, not in arrival order: a slow upload must not hold up a ping.
  const inFlight = new Set<Promise<void>>();
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      write(fail(null, PARSE_ERROR, 'Parse error'));
      continue;
    }
    const answer = Array.isArray(msg)
      ? Promise.all(msg.map((one) => handleMcpMessage(one, deps))).then((rs) => {
          // A batch (allowed by revisions before 2025-06-18) is answered as one array, or not at all.
          const answered = rs.filter((r): r is JsonRpcResponse => r !== undefined);
          if (answered.length) write(answered);
        })
      : handleMcpMessage(msg, deps).then((r) => {
          if (r) write(r);
        });
    const tracked = answer.catch((e: unknown) => console.error('[mcp]', e instanceof Error ? e.message : e));
    inFlight.add(tracked);
    void tracked.finally(() => inFlight.delete(tracked));
  }
  await Promise.allSettled(inFlight);
}
