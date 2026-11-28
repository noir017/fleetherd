import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decode } from '@toon-format/toon';
import type { IpcAction, IpcRequest, IpcResponse } from '../ipc/protocol.js';
import { PRIVATE_NO_SKILLS } from '../ipc/tools.js';
import {
  LIBRARY_NAMES_MAX,
  MAX_SESSION_LINE_BYTES,
  MCP_PROTOCOL_VERSIONS,
  handleMcpMessage,
  libraryLine,
  mcpSession,
  type JsonRpcResponse,
  type McpDeps,
} from './mcp.js';

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
    expect(r.serverInfo).toEqual({ name: 'fleetherd', version: '9.9.9' });
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
  it('lists the three native tools with their schemas', async () => {
    const r = await result(req('tools/list'));
    const tools = r.tools as { name: string; inputSchema: { type: string } }[];
    expect(tools.map((t) => t.name)).toEqual(['send_file', 'schedule', 'skills']);
    for (const t of tools) expect(t.inputSchema.type).toBe('object');
  });

  it('marks every native tool to load up front, not behind Claude Code\'s ToolSearch', async () => {
    const r = await result(req('tools/list'));
    const tools = r.tools as { name: string; _meta?: Record<string, unknown> }[];
    for (const t of tools) expect(t._meta, t.name).toEqual({ 'anthropic/alwaysLoad': true });
    // Survives the wire as JSON, where a harness reads it.
    const wire = JSON.parse(JSON.stringify(await handleMcpMessage(req('tools/list'), deps()))) as JsonRpcResponse;
    expect((wire.result as { tools: { _meta: unknown }[] }).tools[2]!._meta).toEqual({ 'anthropic/alwaysLoad': true });
  });

  it('ends the skills tool\'s description with what the library holds, asked of the daemon', async () => {
    const d = deps({ ok: true, data: { total: 9, library: 7, categories: [{ name: '运维', count: 6 }, { name: 'other', count: 3 }] } });
    const r = await result(req('tools/list'), d);
    const skills = (r.tools as { name: string; description: string }[]).find((t) => t.name === 'skills')!;
    expect(skills.description).toMatch(/In the library: 运维 6, other 3\.$/);
    expect(d.sent).toEqual([{ kind: 'skills', action: 'categories' }]);
  });

  it('names the library skills by category when the daemon sends names', async () => {
    const d = deps({
      ok: true,
      data: {
        total: 6,
        library: 4,
        categories: [
          { name: '运维', count: 3, library: ['easytier-edge-join'] },
          { name: '开发', count: 1, library: [] },
          { name: 'other', count: 2, library: ['antigravity-config', 'email-reader'] },
        ],
      },
    });
    const r = await result(req('tools/list'), d);
    const skills = (r.tools as { name: string; description: string }[]).find((t) => t.name === 'skills')!;
    expect(skills.description).toMatch(/In the library: 运维: easytier-edge-join; other: antigravity-config, email-reader\.$/);
  });

  it('keeps the description as written when the daemon cannot say', async () => {
    const d = deps({ ok: false, error: 'no daemon' });
    const r = await result(req('tools/list'), d);
    const skills = (r.tools as { name: string; description: string }[]).find((t) => t.name === 'skills')!;
    expect(skills.description).not.toMatch(/In the library/);
  });

  it("leaves the skills tool out of a private agent's session, the daemon's refusal being the sign", async () => {
    const r = await result(req('tools/list'), deps({ ok: false, error: PRIVATE_NO_SKILLS }));
    expect((r.tools as { name: string }[]).map((t) => t.name)).toEqual(['send_file', 'schedule']);
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

describe('libraryLine', () => {
  const named = (n: number) => ({
    total: n,
    library: n,
    categories: [{ name: 'other', count: n, library: Array.from({ length: n }, (_, i) => `s-${i}`) }],
  });

  it('goes back to counts past the name limit, so a large library does not grow the tool', () => {
    expect(libraryLine(named(LIBRARY_NAMES_MAX))).toMatch(/^In the library: other: s-0, s-1, /);
    expect(libraryLine(named(LIBRARY_NAMES_MAX + 1))).toBe(`In the library: other ${LIBRARY_NAMES_MAX + 1}.`);
  });

  it('says nothing when no library skill reaches this agent', () => {
    expect(libraryLine({ total: 2, library: 1, categories: [{ name: '运维', count: 2, library: [] }] })).toBe('');
  });

  it('takes a lower name limit from a caller with less room, and 0 for counts alone', () => {
    expect(libraryLine(named(3), 2)).toBe('In the library: other 3.');
    expect(libraryLine(named(3), 0)).toBe('In the library: other 3.');
    expect(libraryLine(named(0), 0)).toBe('');
  });
});

/**
 * A remote session's server as the daemon serves it in-process. The daemon is a real socket here,
 * not a fake `call`: what this path must keep is that every call still goes over the socket with
 * the session's token, so the daemon checks it exactly as it checks a spawned server's.
 */
describe('mcpSession', () => {
  const cleanup: (() => void)[] = [];
  afterEach(() => {
    for (const c of cleanup.splice(0)) c();
  });

  /** A daemon socket that records each request and answers it — or holds it, when `hold` is set. */
  async function daemon(hold = false): Promise<{ socket: string; got: IpcRequest[]; release: () => void }> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fh-mcp-'));
    const socket = path.join(dir, 'd.sock');
    const got: IpcRequest[] = [];
    const held: net.Socket[] = [];
    const reply = (c: net.Socket) => c.end(`${JSON.stringify({ ok: true, data: { messageId: 'm1' } })}\n`);
    const server = net.createServer((c) => {
      let buf = '';
      c.on('data', (d) => {
        buf += d.toString();
        if (!buf.includes('\n')) return;
        got.push(JSON.parse(buf.slice(0, buf.indexOf('\n'))) as IpcRequest);
        if (hold) held.push(c);
        else reply(c);
      });
    });
    await new Promise<void>((r) => server.listen(socket, r));
    cleanup.push(() => {
      server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });
    return { socket, got, release: () => held.splice(0).forEach(reply) };
  }

  function open(socket: string) {
    const out: string[] = [];
    const err: string[] = [];
    const exits: number[] = [];
    let exited: (code: number) => void = () => {};
    const done = new Promise<number>((r) => (exited = r));
    const s = mcpSession(
      { token: 'tok', socket, cwd: '/work/project', home: '/home/agent', version: '9.9.9' },
      {
        out: (fd, d) => (fd === 1 ? out : err).push(d.toString()),
        exit: (code) => {
          exits.push(code);
          exited(code);
        },
      }
    );
    const send = (...msgs: unknown[]) => s.write(Buffer.from(msgs.map((m) => `${JSON.stringify(m)}\n`).join('')));
    return { s, out, err, exits, done, send };
  }

  const sendFile = (id: number, p: string) => req('tools/call', { name: 'send_file', arguments: { path: p } }, id);

  it('answers on fd 1 and carries the session token to the daemon, with ~ as the host home', async () => {
    const d = await daemon();
    const m = open(d.socket);
    m.send(req('initialize', {}, 1), sendFile(2, '~/out.png'), sendFile(3, 'rel.png'));
    m.s.end();
    expect(await m.done).toBe(0);
    const answers = m.out.join('').trim().split('\n').map((l) => JSON.parse(l) as JsonRpcResponse);
    expect(answers.map((a) => a.id).sort()).toEqual([1, 2, 3]);
    expect(answers.every((a) => a.error === undefined)).toBe(true);
    expect(d.got.map((r) => r.token)).toEqual(['tok', 'tok']);
    expect(d.got.map((r) => (r.action as { path: string }).path).sort()).toEqual(['/home/agent/out.png', '/work/project/rel.png']);
  });

  it('gives up on a line past the limit, even one sent in pieces, and forwards none of it', async () => {
    const d = await daemon();
    const m = open(d.socket);
    const half = Buffer.alloc(MAX_SESSION_LINE_BYTES / 2 + 1, 0x61);
    m.s.write(half);
    m.s.write(half);
    expect(await m.done).toBe(1);
    expect(m.err.join('')).toContain('longer than');
    m.send(sendFile(1, '/x'));
    m.s.end();
    await new Promise((r) => setTimeout(r, 20));
    expect(d.got).toEqual([]);
    expect(m.out).toEqual([]);
    expect(m.exits).toEqual([1]);
  });

  it('is gone the moment it is killed: exits once, and an answer still on its way is dropped', async () => {
    const d = await daemon(true);
    const m = open(d.socket);
    m.send(sendFile(1, '/x'));
    await vi.waitFor(() => expect(d.got).toHaveLength(1));
    m.s.kill();
    expect(await m.done).toBe(1);
    d.release();
    await new Promise((r) => setTimeout(r, 50));
    expect(m.out).toEqual([]);
    expect(m.exits).toEqual([1]);
  });
});

