import http from 'node:http';
import { gzipSync } from 'node:zlib';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AgentDefSchema } from '../config/schema.js';
import { harnessRelay, openLocalRelay, relayEnv, type RelaySpec } from './relay.js';

/**
 * The local relay against a stand-in upstream on loopback: what an agent on this machine gets. The
 * relay on a remote host is talkcode-remote's (remote/relay_test.go, and the contract test in
 * remote.integration.test.ts).
 */

let upstream: http.Server;
let base = '';
let release: () => void = () => {};
const seen: Array<{ path: string; acceptEncoding?: string; host?: string; auth?: string }> = [];

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    seen.push({ path: req.url ?? '', acceptEncoding: req.headers['accept-encoding'], host: req.headers.host, auth: req.headers.authorization });
    if (req.url?.startsWith('/v1internal:streamGenerateContent')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: one\n\n');
      release = () => res.end('data: two\n\n');
      return;
    }
    if (req.url === '/v1internal:fetchAvailableModels') {
      const body = Buffer.from('{"limit":"256000"}');
      // Compressed when the client allows it, as Google's front end does.
      if (String(req.headers['accept-encoding'] ?? '').includes('gzip')) {
        res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
        res.end(gzipSync(body));
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(body);
      }
      return;
    }
    if (req.url === '/big') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(Buffer.alloc((8 << 20) + 10, 'x'));
      return;
    }
    let body = '';
    req.on('data', (d: Buffer) => (body += d.toString()));
    req.on('end', () => res.end(`${req.method} ${req.url} ${body}`));
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
});

afterAll(() => upstream.close());

const spec = (over: Partial<RelaySpec> = {}): RelaySpec => ({
  id: 'test.relay',
  upstream: base,
  paths: ['/v1internal:fetchAvailableModels', '/big'],
  transform: (_p, body) => Buffer.from(body.toString().replace('256000', '900000')),
  ...over,
});

describe('the local relay', () => {
  it('forwards a request as the agent made it, to the upstream host', async () => {
    const url = await openLocalRelay(spec());
    const res = await fetch(`${url}/v1internal:loadCodeAssist?x=1`, { method: 'POST', body: '{}', headers: { authorization: 'Bearer tok' } });
    expect(await res.text()).toBe('POST /v1internal:loadCodeAssist?x=1 {}');
    const last = seen.at(-1)!;
    expect(last.host).toBe(base.slice('http://'.length));
    expect(last.auth).toBe('Bearer tok');
  });

  it('streams: the first event arrives while the upstream still holds the second', async () => {
    const url = await openLocalRelay(spec());
    const res = await fetch(`${url}/v1internal:streamGenerateContent?alt=sse`);
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(Buffer.from(first.value!).toString()).toBe('data: one\n\n');
    release();
    let rest = '';
    for (let r = await reader.read(); !r.done; r = await reader.read()) rest += Buffer.from(r.value).toString();
    expect(rest).toBe('data: two\n\n');
  });

  it('shows a named path to the transform uncompressed, and serves what it returns', async () => {
    const url = await openLocalRelay(spec());
    const res = await fetch(`${url}/v1internal:fetchAvailableModels`, { headers: { 'accept-encoding': 'gzip' } });
    expect(await res.text()).toBe('{"limit":"900000"}');
    expect(res.headers.get('content-length')).toBe(String('{"limit":"900000"}'.length));
    expect(seen.at(-1)!.acceptEncoding).toBeUndefined();
  });

  it('serves the original when the transform declines or throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const transform of [() => undefined, () => { throw new Error('boom'); }]) {
      const url = await openLocalRelay(spec({ id: `test.decline${seen.length}`, transform }));
      const res = await fetch(`${url}/v1internal:fetchAvailableModels`);
      expect(await res.text()).toBe('{"limit":"256000"}');
    }
    warn.mockRestore();
  });

  it('passes on a named response too big to hold, whole', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const transform = vi.fn(() => Buffer.from('never'));
    const url = await openLocalRelay(spec({ id: 'test.big', transform }));
    const body = Buffer.from(await (await fetch(`${url}/big`)).arrayBuffer());
    expect(body.length).toBe((8 << 20) + 10);
    expect(transform).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('keeps one listener per spec, and a changed spec gets a new one', async () => {
    const a = await openLocalRelay(spec({ id: 'test.same' }));
    expect(await openLocalRelay(spec({ id: 'test.same' }))).toBe(a);
    expect(await openLocalRelay(spec({ id: 'test.same', paths: ['/other'] }))).not.toBe(a);
  });

  it('refuses plain http to anywhere but loopback', async () => {
    await expect(openLocalRelay(spec({ id: 'test.bad', upstream: 'http://example.com' }))).rejects.toThrow(/https/);
  });
});

describe('relayEnv', () => {
  it('points an agy agent with a contextBudget at its relay, and leaves every other agent alone', async () => {
    const env = await relayEnv(AgentDefSchema.parse({ id: 'ag', harness: 'agy', contextBudget: 900_000, env: { CLOUD_CODE_URL: base } }));
    expect(env.CLOUD_CODE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(await relayEnv(AgentDefSchema.parse({ id: 'ag2', harness: 'agy' }))).toEqual({});
    expect(harnessRelay(AgentDefSchema.parse({ id: 'cc', harness: 'claude' }))).toBeUndefined();
  });

  it('starts the agent without one, and says why, when the relay cannot be opened', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const def = AgentDefSchema.parse({ id: 'ag3', harness: 'agy', contextBudget: 900_000, env: { CLOUD_CODE_URL: 'http://example.com' } });
    expect(await relayEnv(def)).toEqual({});
    expect(warn.mock.calls[0]?.[0]).toMatch(/could not open its relay/);
    warn.mockRestore();
  });
});
