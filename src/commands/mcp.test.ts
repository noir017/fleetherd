import { describe, expect, it } from 'vitest';
import { decode } from '@toon-format/toon';
import type { IpcAction, IpcResponse } from '../ipc/protocol.js';
import { MCP_PROTOCOL_VERSIONS, handleMcpMessage, type JsonRpcResponse, type McpDeps } from './mcp.js';

/**
 * The MCP server as a harness drives it: one JSON-RPC message in, one answer (or none) out. The
 * daemon is faked at the IpcAction boundary — what reaches it is exactly what the CLI would send,
 * which is the whole contract.
 */

function deps(reply: IpcResponse = { ok: true, data: { messageId: 'm1' } }): McpDeps & { sent: IpcAction[] } {
  const sent: IpcAction[] = [];
  return {
    sent,
    cwd: '/work/project',
    socket: '/run/aa.sock',
    version: '9.9.9',
    call: (action) => {
      sent.push(action);
      return Promise.resolve(reply);
    },
  };
}

const req = (method: string, params?: unknown, id: number | string = 1) => ({ jsonrpc: '2.0', id, method, params });

async function result(msg: unknown, d = deps()): Promise<Record<string, unknown>> {
  const r = (await handleMcpMessage(msg, d)) as JsonRpcResponse;
  expect(r.error).toBeUndefined();
  return r.result as Record<string, unknown>;
}

const text = (r: Record<string, unknown>) => (r.content as { type: string; text: string }[])[0]!.text;

describe('initialize', () => {
  it('answers in the client\'s revision when it knows it', async () => {
    const r = await result(req('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't' } }));
    expect(r.protocolVersion).toBe('2025-06-18');
    expect(r.capabilities).toEqual({ tools: { listChanged: false } });
    expect(r.serverInfo).toEqual({ name: 'talkcode', version: '9.9.9' });
  });

  it('offers its newest revision for one it does not know', async () => {
    const r = await result(req('initialize', { protocolVersion: '2099-01-01' }));
    expect(r.protocolVersion).toBe(MCP_PROTOCOL_VERSIONS[0]);
  });

  it('sends no instructions — a harness would put them in the system prompt', async () => {
    expect(await result(req('initialize', {}))).not.toHaveProperty('instructions');
  });
});

describe('tools/list', () => {
  it('lists the two native tools with their schemas', async () => {
    const r = await result(req('tools/list'));
    const tools = r.tools as { name: string; inputSchema: { type: string } }[];
    expect(tools.map((t) => t.name)).toEqual(['send_file', 'schedule']);
    for (const t of tools) expect(t.inputSchema.type).toBe('object');
  });
});

describe('tools/call', () => {
  it('sends the action the CLI would, with a relative path resolved against the SESSION directory', async () => {
    const d = deps();
    const r = await result(req('tools/call', { name: 'send_file', arguments: { path: 'out/chart.png' } }), d);
    // Not this process's CWD: a harness starts its MCP servers wherever it likes.
    expect(d.sent).toEqual([{ kind: 'send-file', path: '/work/project/out/chart.png', name: undefined, caption: undefined, channelId: undefined }]);
    expect(r.isError).toBeUndefined();
    expect(decode(text(r))).toEqual({ ok: true, messageId: 'm1' });
  });

  it('answers with the same TOON the shell command prints', async () => {
    const task = { id: 'k3x9', name: 'brief', state: 'active' };
    const r = await result(req('tools/call', { name: 'schedule', arguments: { action: 'add', cron: '0 8 * * *', prompt: 'brief' } }), deps({ ok: true, data: { task } }));
    const out = decode(text(r)) as { task: unknown; help: string[] };
    expect(out.task).toEqual(task);
    // Worded for both front doors: no shell syntax in a reply a tool caller reads.
    expect(out.help[0]).toMatch(/Manage it by its id \(k3x9\): pause, resume, run \(now, once\) or rm/);
  });

  it('reports bad arguments as a tool error the model can read and correct', async () => {
    const d = deps();
    const r = await result(req('tools/call', { name: 'schedule', arguments: { action: 'pause' } }), d);
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/needs a task id/);
    expect(d.sent).toEqual([]); // refused before anything reached the daemon
  });

  it('reports a daemon refusal as a tool error, with the recovery hint for a dead socket', async () => {
    const r = await result(
      req('tools/call', { name: 'send_file', arguments: { path: '/a.png' } }),
      deps({ ok: false, error: 'connect ECONNREFUSED /run/aa.sock' })
    );
    expect(r.isError).toBe(true);
    expect(decode(text(r))).toMatchObject({ error: expect.stringContaining('cannot reach the daemon') as unknown });
  });

  it('treats an unknown tool as a protocol error, per the spec', async () => {
    const r = (await handleMcpMessage(req('tools/call', { name: 'rm_rf', arguments: {} }), deps()))!;
    expect(r.error).toEqual({ code: -32602, message: 'Unknown tool: rm_rf' });
  });
});

describe('the rest of JSON-RPC', () => {
  it('answers ping', async () => {
    expect(await result(req('ping'))).toEqual({});
  });

  it('answers nothing to notifications and to responses', async () => {
    expect(await handleMcpMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, deps())).toBeUndefined();
    expect(await handleMcpMessage({ jsonrpc: '2.0', id: 7, result: {} }, deps())).toBeUndefined();
  });

  it('refuses methods it does not serve, keeping the request id', async () => {
    const r = (await handleMcpMessage(req('resources/list', undefined, 'abc'), deps()))!;
    expect(r).toEqual({ jsonrpc: '2.0', id: 'abc', error: { code: -32601, message: 'Method not found: resources/list' } });
  });

  it('refuses a message that is not a JSON-RPC 2.0 request', async () => {
    expect((await handleMcpMessage('hello', deps()))!.error!.code).toBe(-32600);
    expect((await handleMcpMessage({ jsonrpc: '1.0', id: 1, method: 'ping' }, deps()))!.error!.code).toBe(-32600);
  });
});
