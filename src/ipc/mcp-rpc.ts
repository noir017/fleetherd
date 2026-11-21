/**
 * The MCP server's JSON-RPC half, shared by both of the gateway's MCP front doors: `fleetherd mcp`
 * on stdio, which an agent's harness starts (commands/mcp.ts), and the external entrance over HTTP
 * (daemon/external-mcp.ts). What differs between them is which tools there are and how a call
 * reaches the daemon; the methods, the version negotiation and the error shapes are this file's, so
 * the two cannot drift into answering the same request differently.
 *
 * Hand-rolled rather than built on @modelcontextprotocol/sdk. The surface is four methods with no
 * state (initialize, ping, tools/list, tools/call), and doing it here keeps the message handling a
 * pure function the tests can drive, with nothing between it and the wire to version-skew.
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

/** MCP ToolAnnotations hints carried on `tools/list` so clients can distinguish read-only tools. */
export interface McpToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/** One tool as `tools/list` carries it. */
export interface McpTool {
  name: string;
  description: string;
  inputSchema: unknown;
  annotations?: McpToolAnnotations;
}

/** A tool call's answer: text for the model, flagged when the call did not happen. */
export interface McpToolText {
  text: string;
  isError?: boolean;
}

/** What one server offers. */
export interface McpServer {
  /** Reported as serverInfo. */
  version: string;
  listTools(): Promise<McpTool[]>;
  /**
   * One tools/call. Undefined for a tool this server does not have — the protocol error the spec
   * gives that case — and a text with `isError` for everything after it (bad arguments, a refusal),
   * because those are for the model to read and correct.
   */
  callTool(name: string, args: unknown): Promise<McpToolText | undefined>;
}

/** JSON-RPC error codes this server answers with (the spec's reserved range). */
export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

export const rpcError = (id: JsonRpcId, code: number, message: string): JsonRpcResponse => ({
  jsonrpc: '2.0',
  id,
  error: { code, message },
});

/**
 * Answer one incoming JSON-RPC message, or return undefined when it wants no answer — a
 * notification (`notifications/initialized`, `notifications/cancelled`), or a response to a request
 * this server never sends.
 */
export async function answerMcpMessage(msg: unknown, server: McpServer): Promise<JsonRpcResponse | undefined> {
  if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) return rpcError(null, INVALID_REQUEST, 'Invalid Request');
  const m = msg as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
  const id = typeof m.id === 'string' || typeof m.id === 'number' ? m.id : null;
  if (typeof m.method !== 'string') return undefined; // a response, or noise: nothing to answer
  if (m.id === undefined) return undefined; // a notification
  if (m.jsonrpc !== '2.0') return rpcError(id, INVALID_REQUEST, 'Invalid Request: jsonrpc must be "2.0"');
  try {
    const result = await dispatch(m.method, m.params, server);
    return 'error' in result ? { jsonrpc: '2.0', id, error: result.error } : { jsonrpc: '2.0', id, result: result.ok };
  } catch (e) {
    return rpcError(id, INTERNAL_ERROR, e instanceof Error ? e.message : String(e));
  }
}

/**
 * Answer one parsed payload: a message, or a batch (allowed by revisions before 2025-06-18), which
 * is answered as one array — or not at all when nothing in it wanted an answer.
 */
export async function answerMcpPayload(
  payload: unknown,
  server: McpServer
): Promise<JsonRpcResponse | JsonRpcResponse[] | undefined> {
  if (!Array.isArray(payload)) return answerMcpMessage(payload, server);
  const rs = await Promise.all(payload.map((one) => answerMcpMessage(one, server)));
  const answered = rs.filter((r): r is JsonRpcResponse => r !== undefined);
  return answered.length ? answered : undefined;
}

type Outcome = { ok: unknown } | { error: { code: number; message: string } };

async function dispatch(method: string, params: unknown, server: McpServer): Promise<Outcome> {
  switch (method) {
    case 'initialize':
      return { ok: initializeResult(params, server.version) };
    case 'ping':
      return { ok: {} };
    case 'tools/list':
      return { ok: { tools: await server.listTools() } };
    case 'tools/call': {
      const p = (params ?? {}) as { name?: unknown; arguments?: unknown };
      const answer = typeof p.name === 'string' ? await server.callTool(p.name, p.arguments) : undefined;
      if (!answer) return { error: { code: INVALID_PARAMS, message: `Unknown tool: ${String(p.name)}` } };
      return { ok: { content: [{ type: 'text', text: answer.text }], ...(answer.isError ? { isError: true } : {}) } };
    }
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
  return {
    protocolVersion: negotiatedVersion(asked),
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: 'fleetherd', version },
  };
}

/** The revision to answer in: the one asked for when this server knows it, else its newest. */
export function negotiatedVersion(asked: unknown): string {
  return (MCP_PROTOCOL_VERSIONS as readonly unknown[]).includes(asked) ? (asked as string) : MCP_PROTOCOL_VERSIONS[0];
}
