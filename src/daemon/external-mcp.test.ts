import { afterEach, describe, expect, it } from 'vitest';
import type { Config } from '../config/schema.js';
import type { ExternalAction } from '../ipc/external-tools.js';
import { ExternalMcp, MAX_BODY_BYTES, type ExternalCaller } from './external-mcp.js';

/**
 * The external MCP entrance over real HTTP on a loopback port: who gets in (a bearer token per
 * caller, compared whole; nobody without one), what each caller sees (its own tools), and the parts
 * of Streamable HTTP it answers. What a call then does is external-calls.ts's, faked here.
 */

const TOKEN_A = 'a'.repeat(32);
const TOKEN_B = 'b'.repeat(32);
const WEB_SECRET = 'w'.repeat(32);

const servers: ExternalMcp[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop();
});

function settings(over: Partial<NonNullable<Config['mcp']>> = {}): NonNullable<Config['mcp']> {
  return {
    host: '127.0.0.1',
    port: 0,
    callers: [
      { name: 'gem', tokenEnv: 'TOK_A', tools: ['skills', 'tasks'] },
      { name: 'reader', tokenEnv: 'TOK_B', tools: ['skills'] },
    ],
    ...over,
  };
}

async function start(opts: { env?: NodeJS.ProcessEnv; mcp?: NonNullable<Config['mcp']> } = {}) {
  const calls: Array<{ caller: ExternalCaller; action: ExternalAction }> = [];
  let mcp: Config['mcp'] = opts.mcp ?? settings();
  const env: NodeJS.ProcessEnv = opts.env ?? { TOK_A: TOKEN_A, TOK_B: TOKEN_B };
  const server = new ExternalMcp({
    settings: () => mcp,
    env: () => env,
    reserved: () => [WEB_SECRET],
    call: async (caller, action) => {
      calls.push({ caller, action });
      return `done: ${action.kind}`;
    },
    libraryLine: () => 'In the library: ops: deploy-check.',
    version: '9.9.9',
  });
  servers.push(server);
  await server.configure();
  const url = (): string => `http://127.0.0.1:${server.port()}/mcp`;
  /** `token: null` sends no Authorization header at all. */
  const post = (body: unknown, headers: Record<string, string> = {}, token: string | null = TOKEN_A) =>
    fetch(url(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  return {
    server,
    calls,
    env,
    url,
    post,
    setMcp: (next: Config['mcp']) => {
      mcp = next;
    },
  };
}

/** `id: null` makes it a notification. */
const rpc = (method: string, params?: unknown, id: number | null = 1) => ({
  jsonrpc: '2.0',
  ...(id !== null ? { id } : {}),
  method,
  ...(params !== undefined ? { params } : {}),
});

describe('ExternalMcp: who gets in', () => {
  it('lets a caller in by its own token, and nobody without one', async () => {
    const s = await start();
    const ok = await s.post(rpc('ping'));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ jsonrpc: '2.0', id: 1, result: {} });

    for (const token of [null, 'wrong', `${TOKEN_A}x`, TOKEN_A.slice(1)]) {
      const r = await s.post(rpc('ping'), {}, token);
      expect(r.status).toBe(401);
      expect(r.headers.get('www-authenticate')).toMatch(/^Bearer/);
    }
    const basic = await s.post(rpc('ping'), { authorization: `Basic ${TOKEN_A}` }, null);
    expect(basic.status).toBe(401);
  });

  it('refuses a caller whose token is unset, short, or the web UI login secret', async () => {
    const s = await start({ env: { TOK_A: 'short', TOK_B: WEB_SECRET } });
    expect((await s.post(rpc('ping'), {}, 'short')).status).toBe(401);
    expect((await s.post(rpc('ping'), {}, WEB_SECRET)).status).toBe(401);
    const unset = await start({ env: {} });
    expect((await unset.post(rpc('ping'), {}, '')).status).toBe(401);
  });

  it('revokes at once: a caller taken out of the settings, or its variable unset, is refused on the next call', async () => {
    const s = await start();
    expect((await s.post(rpc('ping'))).status).toBe(200);
    delete s.env.TOK_A;
    expect((await s.post(rpc('ping'))).status).toBe(401);
    s.env.TOK_A = TOKEN_A;
    s.setMcp(settings({ callers: [{ name: 'reader', tokenEnv: 'TOK_B', tools: ['skills'] }] }));
    expect((await s.post(rpc('ping'))).status).toBe(401);
    expect((await s.post(rpc('ping'), {}, TOKEN_B)).status).toBe(200);
  });

  it('refuses a browser, another path, and every method but POST', async () => {
    const s = await start();
    expect((await s.post(rpc('ping'), { origin: 'http://evil.example' })).status).toBe(403);
    const get = await fetch(s.url(), { headers: { authorization: `Bearer ${TOKEN_A}` } });
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST');
    const other = await fetch(s.url().replace('/mcp', '/'), { method: 'POST', headers: { authorization: `Bearer ${TOKEN_A}` } });
    expect(other.status).toBe(404);
  });
});

describe('ExternalMcp: the protocol', () => {
  it('negotiates a version, and refuses a version header it does not speak', async () => {
    const s = await start();
    const init = await (await s.post(rpc('initialize', { protocolVersion: '2025-06-18' }))).json();
    expect(init.result).toMatchObject({ protocolVersion: '2025-06-18', serverInfo: { name: 'fleetherd', version: '9.9.9' } });
    expect((await s.post(rpc('ping'), { 'mcp-protocol-version': '2025-03-26' })).status).toBe(200);
    expect((await s.post(rpc('ping'), { 'mcp-protocol-version': '1999-01-01' })).status).toBe(400);
  });

  it('answers a notification with 202 and no body, a batch with an array, and bad bodies with an error', async () => {
    const s = await start();
    const note = await s.post(rpc('notifications/initialized', undefined, null));
    expect(note.status).toBe(202);
    expect(await note.text()).toBe('');
    const batch = await (await s.post([rpc('ping', undefined, 1), rpc('ping', undefined, 2)])).json();
    expect(batch).toEqual([
      { jsonrpc: '2.0', id: 1, result: {} },
      { jsonrpc: '2.0', id: 2, result: {} },
    ]);
    const parse = await s.post('{not json');
    expect(parse.status).toBe(400);
    expect((await parse.json()).error.code).toBe(-32700);
    expect((await s.post(rpc('ping'), { 'content-type': 'text/plain' })).status).toBe(415);
    expect((await s.post(JSON.stringify({ pad: 'x'.repeat(MAX_BODY_BYTES) }))).status).toBe(413);
  });

  it('lists a caller its own tools only, with the library on the skills description', async () => {
    const s = await start();
    const all = await (await s.post(rpc('tools/list'))).json();
    expect(all.result.tools.map((t: { name: string }) => t.name)).toEqual(['skills', 'tasks']);
    expect(all.result.tools[0].description).toMatch(/In the library: ops: deploy-check\.$/);
    const reader = await (await s.post(rpc('tools/list'), {}, TOKEN_B)).json();
    expect(reader.result.tools.map((t: { name: string }) => t.name)).toEqual(['skills']);
  });

  it('runs a call as the caller it came from, and a tool it was not given does not exist for it', async () => {
    const s = await start();
    const r = await (await s.post(rpc('tools/call', { name: 'tasks', arguments: { action: 'open', title: 'Trip' } }))).json();
    expect(r.result).toEqual({ content: [{ type: 'text', text: 'done: open' }] });
    expect(s.calls).toEqual([{ caller: { name: 'gem', tools: ['skills', 'tasks'] }, action: { kind: 'open', title: 'Trip' } }]);

    const refused = await (await s.post(rpc('tools/call', { name: 'tasks', arguments: { action: 'open' } }), {}, TOKEN_B)).json();
    expect(refused.error).toEqual({ code: -32602, message: 'Unknown tool: tasks' });
    expect(s.calls).toHaveLength(1);
  });

  it('answers arguments it refuses as a tool error the model can read, without calling anything', async () => {
    const s = await start();
    const r = await (
      await s.post(rpc('tools/call', { name: 'skills', arguments: { action: 'patch', name: 'x' } }))
    ).json();
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toMatch(/action must be one of search, show/);
    expect(s.calls).toEqual([]);
  });

  it('preserves caller.agents across HTTP bearer authentication', async () => {
    const s = await start({
      mcp: settings({
        callers: [{ name: 'gem', tokenEnv: 'TOK_A', tools: ['skills', 'tasks'], agents: ['gemini-task'] }],
      }),
    });
    const res = await s.post(rpc('tools/call', { name: 'tasks', arguments: { action: 'list', topic: 'web:main/aaaaaaaa' } }));
    expect(res.status).toBe(200);
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]?.caller).toEqual({ name: 'gem', tools: ['skills', 'tasks'], agents: ['gemini-task'] });
  });
});

describe('ExternalMcp: the listener', () => {
  it('stops when the block goes, and binds again when it comes back', async () => {
    const s = await start();
    expect(s.server.port()).toBeGreaterThan(0);
    s.setMcp(undefined);
    await s.server.configure();
    expect(s.server.port()).toBeUndefined();
    s.setMcp(settings());
    await s.server.configure();
    expect((await s.post(rpc('ping'))).status).toBe(200);
  });
});
