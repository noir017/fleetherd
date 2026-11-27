import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { InboundMessage } from '../../../types.js';
import { WebuiConfigSchema } from '../../../config/platform-schemas.js';
import { loadAssets } from '../assets.js';
import { WebAuth } from '../auth.js';
import type { WebEvent } from '../protocol.js';
import { TopicStore, WebRoom, type WebuiInstance } from '../room.js';
import { createWebServer, type WebServer } from '../server.js';
import { TerminalSessions } from '../terminal-sessions.js';
import { normalizePluginRoutePath, PluginHostManager } from './host.js';
import { loadPlugins } from './loader.js';

let tmpDir: string;
const runningServers: WebServer[] = [];
const runningManagers: PluginHostManager[] = [];

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetherd-plugin-host-'));
});

afterEach(async () => {
  while (runningManagers.length > 0) {
    await runningManagers.pop()!.dispose();
  }
  while (runningServers.length > 0) {
    await runningServers.pop()!.stop();
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (!addr || typeof addr === 'string') {
        srv.close();
        reject(new Error('no port'));
        return;
      }
      const { port } = addr;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function writeServerPlugin(
  dir: string,
  manifest: Record<string, unknown>,
  serverCode?: string,
  extraFiles: Record<string, string> = {}
): string {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'fleetherd-plugin.json'), JSON.stringify(manifest), 'utf8');
  if (serverCode !== undefined && typeof manifest.server === 'string') {
    const serverPath = path.join(dir, manifest.server);
    fs.mkdirSync(path.dirname(serverPath), { recursive: true });
    fs.writeFileSync(serverPath, serverCode, 'utf8');
  }
  for (const [rel, content] of Object.entries(extraFiles)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
  return dir;
}

async function setupHarness(entries: Array<{ path: string; config?: unknown }>) {
  const port = await freePort();
  const instance: WebuiInstance = {
    ...WebuiConfigSchema.parse({ type: 'webui', token: 'open-sesame', plugins: entries }),
    id: 'webui',
    host: '127.0.0.1',
    port,
  };
  const topics = new TopicStore(path.join(tmpDir, `topics-${port}.json`));
  const initialTopic = topics.current();
  const room = new WebRoom(instance, topics);
  const sessions = new TerminalSessions();
  room.useTerminalSessions(sessions);

  const logs: string[] = [];
  const loaded = loadPlugins(instance.plugins, { log: (m) => logs.push(m) });
  const storageDir = path.join(tmpDir, `storage-${port}`);
  const manager = new PluginHostManager({
    room,
    plugins: loaded,
    storageDir,
    log: (m) => logs.push(m),
  });
  await manager.activateAll();
  runningManagers.push(manager);

  const server = createWebServer(
    room,
    new WebAuth({ token: instance.token }),
    instance,
    { enabled: false, socket: '/nonexistent.sock', sessions },
    undefined,
    undefined,
    loadAssets(path.join(tmpDir, `no-assets-${port}`)),
    loaded,
    manager
  );
  await server.start();
  runningServers.push(server);

  const base = `http://127.0.0.1:${port}`;
  const loginRes = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'open-sesame' }),
  });
  const cookie = (loginRes.headers.get('set-cookie') ?? '').split(';')[0] ?? '';

  return { base, cookie, room, manager, storageDir, logs, initialTopic };
}

describe('normalizePluginRoutePath', () => {
  it('normalizes valid paths and rejects traversal or invalid characters', () => {
    expect(normalizePluginRoutePath('')).toBe('/');
    expect(normalizePluginRoutePath('/')).toBe('/');
    expect(normalizePluginRoutePath('ping')).toBe('/ping');
    expect(normalizePluginRoutePath('/ping/')).toBe('/ping');
    expect(normalizePluginRoutePath('/a/b/c')).toBe('/a/b/c');

    expect(normalizePluginRoutePath('../secret')).toBeNull();
    expect(normalizePluginRoutePath('/a/../b')).toBeNull();
    expect(normalizePluginRoutePath('/./a')).toBeNull();
    expect(normalizePluginRoutePath('a\\b')).toBeNull();
    expect(normalizePluginRoutePath('/a\0b')).toBeNull();
    expect(normalizePluginRoutePath('/a?x=1')).toBeNull();
    expect(normalizePluginRoutePath('/a#frag')).toBeNull();
  });
});

describe('PluginHostManager', () => {
  it('activates server plugins, isolates broken plugins, and rolls back partial registrations', async () => {
    const brokenDir = writeServerPlugin(
      path.join(tmpDir, 'plugins', 'broken'),
      { id: 'broken-mod', name: 'Broken', version: '1.0.0', server: 'server.mjs' },
      `
      export function activate(host) {
        host.routes.get('/leaked', (_req, res) => {
          res.writeHead(200);
          res.end('should-not-exist');
        });
        host.events.on('topic', () => { throw new Error('should-not-run'); });
        throw new Error('boom during activate');
      }
      `
    );

    const healthyDir = writeServerPlugin(
      path.join(tmpDir, 'plugins', 'healthy'),
      { id: 'healthy-mod', name: 'Healthy', version: '1.0.0', server: 'server.mjs' },
      `
      export function activate(host) {
        host.log('activated with greeting=' + host.config.greeting);
        host.routes.get('/hello', (_req, res) => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id: host.id, greeting: host.config.greeting }));
        });
      }
      `
    );

    const feOnlyDir = writeServerPlugin(
      path.join(tmpDir, 'plugins', 'fe-only'),
      { id: 'fe-only', name: 'FE', version: '1.0.0', client: 'client.js' },
      undefined,
      { 'client.js': 'export const x = 1;' }
    );

    const { base, cookie, manager, logs } = await setupHarness([
      { path: brokenDir },
      { path: healthyDir, config: { greeting: 'hi-there' } },
      { path: feOnlyDir },
    ]);

    expect(manager.activePluginIds).toEqual(['healthy-mod']);
    expect(logs.some((l) => l.includes('[webui:plugin:broken-mod]') && l.includes('boom during activate'))).toBe(true);
    expect(logs.some((l) => l.includes('[webui:plugin:healthy-mod] activated with greeting=hi-there'))).toBe(true);

    // Rolled-back route from broken plugin returns 404
    const leaked = await fetch(`${base}/api/plugins/broken-mod/leaked`, { headers: { cookie } });
    expect(leaked.status).toBe(404);

    // Healthy plugin serves its route normally
    const ok = await fetch(`${base}/api/plugins/healthy-mod/hello`, { headers: { cookie } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ id: 'healthy-mod', greeting: 'hi-there' });
  });

  it('dispatches GET/POST under /api/plugins/<id>/, enforces auth/same-origin, preserves built-in routes, and catches route errors without leaking stack', async () => {
    const dir = writeServerPlugin(
      path.join(tmpDir, 'plugins', 'router-test'),
      { id: 'router-test', name: 'Router', version: '1.0.0', server: 'server.mjs' },
      `
      export function activate(host) {
        host.routes.get('/', (_req, res) => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ root: true }));
        });
        host.routes.post('/echo', async (req, res) => {
          const chunks = [];
          for await (const c of req) chunks.push(c);
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ echoed: body.msg }));
        });
        host.routes.get('/crash', () => {
          throw new Error('SECRET_INTERNAL_CRASH_DETAILS');
        });
      }
      `
    );

    const { base, cookie, logs } = await setupHarness([{ path: dir }]);

    // Unauthenticated requests are rejected with 401
    expect((await fetch(`${base}/api/plugins/router-test/`)).status).toBe(401);
    expect((await fetch(`${base}/api/plugins/router-test/echo`, { method: 'POST' })).status).toBe(401);

    // Cross-origin POST is rejected with 403
    const crossOrigin = await fetch(`${base}/api/plugins/router-test/echo`, {
      method: 'POST',
      headers: { cookie, origin: 'https://evil.example', 'content-type': 'application/json' },
      body: JSON.stringify({ msg: 'no' }),
    });
    expect(crossOrigin.status).toBe(403);

    // Authenticated GET root and POST subpath succeed
    const rootRes = await fetch(`${base}/api/plugins/router-test/`, { headers: { cookie } });
    expect(rootRes.status).toBe(200);
    expect(await rootRes.json()).toEqual({ root: true });

    const postRes = await fetch(`${base}/api/plugins/router-test/echo`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ msg: 'hello-post' }),
    });
    expect(postRes.status).toBe(200);
    expect(await postRes.json()).toEqual({ echoed: 'hello-post' });

    // Unknown route, wrong method, traversal return 404
    expect((await fetch(`${base}/api/plugins/router-test/missing`, { headers: { cookie } })).status).toBe(404);
    expect((await fetch(`${base}/api/plugins/router-test/echo`, { headers: { cookie } })).status).toBe(404);
    expect((await fetch(`${base}/api/plugins/unknown-id/`, { headers: { cookie } })).status).toBe(404);
    expect((await fetch(`${base}/api/plugins/router-test/..%2f..%2fetc`, { headers: { cookie } })).status).toBe(404);

    // Built-in routes remain untouched
    const builtin = await fetch(`${base}/api/topics`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Built-in OK' }),
    });
    expect(builtin.status).toBe(201);

    // Handler exception returns 500 without leaking error message or stack trace
    const crashRes = await fetch(`${base}/api/plugins/router-test/crash`, { headers: { cookie } });
    expect(crashRes.status).toBe(500);
    const crashBody = await crashRes.text();
    expect(crashBody).not.toContain('SECRET_INTERNAL_CRASH_DETAILS');
    expect(crashBody).not.toContain('at ');
    expect(JSON.parse(crashBody)).toEqual({ error: 'plugin route failed' });
    expect(logs.some((l) => l.includes('SECRET_INTERNAL_CRASH_DETAILS'))).toBe(true);
  });

  it('exposes topics.list, topics.get, and topics.send with visible [plugin:<id>] attribution', async () => {
    const dir = writeServerPlugin(
      path.join(tmpDir, 'plugins', 'topic-mod'),
      { id: 'topic-mod', name: 'Topic Mod', version: '1.0.0', server: 'server.mjs' },
      `
      export function activate(host) {
        host.routes.get('/topics', (_req, res) => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ids: host.topics.list().map((t) => t.id) }));
        });
        host.routes.post('/send', async (req, res) => {
          const chunks = [];
          for await (const c of req) chunks.push(c);
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          try {
            await host.topics.send(body.topicId, body.text);
            const snap = host.topics.get(body.topicId);
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true, count: snap?.messages.length ?? 0 }));
          } catch (e) {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: e.message }));
          }
        });
      }
      `
    );

    const { base, cookie, room, initialTopic } = await setupHarness([{ path: dir }]);
    const inbound: InboundMessage[] = [];
    room.onMessage((m) => inbound.push(m));

    // topics.list
    const listRes = await fetch(`${base}/api/plugins/topic-mod/topics`, { headers: { cookie } });
    expect(listRes.status).toBe(200);
    expect(await listRes.json()).toEqual({ ids: [initialTopic.id] });

    // topics.send: visible in transcript AND attributed identically in agent inbound message
    const sendRes = await fetch(`${base}/api/plugins/topic-mod/send`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ topicId: initialTopic.id, text: 'deploy finished' }),
    });
    expect(sendRes.status).toBe(200);
    expect(await sendRes.json()).toEqual({ ok: true, count: 1 });

    expect(inbound).toHaveLength(1);
    expect(inbound[0]?.content).toBe('[plugin:topic-mod] deploy finished');

    const snap = room.snapshot(initialTopic.id);
    expect(snap?.messages).toHaveLength(1);
    expect(snap?.messages[0]?.html).toContain('[plugin:topic-mod] deploy finished');

    // Empty text and unknown topic are rejected
    const emptyRes = await fetch(`${base}/api/plugins/topic-mod/send`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ topicId: initialTopic.id, text: '   ' }),
    });
    expect(emptyRes.status).toBe(400);

    const missingRes = await fetch(`${base}/api/plugins/topic-mod/send`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ topicId: 'deadbeef', text: 'hello' }),
    });
    expect(missingRes.status).toBe(400);
  });

  it('delivers room events with fault isolation and pushes plugin:<id>:<type> over SSE', async () => {
    const dir = writeServerPlugin(
      path.join(tmpDir, 'plugins', 'events-mod'),
      { id: 'events-mod', name: 'Events', version: '1.0.0', server: 'server.mjs' },
      `
      export function activate(host) {
        const seen = [];
        const subTopic = host.events.on('topic', (e) => seen.push({ kind: 'topic', e }));
        host.events.on('message', (e) => {
          seen.push({ kind: 'message', topicId: e.topicId, text: e.text });
        });
        host.events.on('turn', (e) => seen.push({ kind: 'turn', phase: e.phase }));
        host.events.on('turn', () => {
          throw new Error('listener boom');
        });
        host.routes.get('/seen', (_req, res) => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ seen }));
        });
        host.routes.post('/unsub-topic', (_req, res) => {
          subTopic.dispose();
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        });
        host.routes.post('/push', async (req, res) => {
          const chunks = [];
          for await (const c of req) chunks.push(c);
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          host.events.push(body.type, body.data);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        });
      }
      `
    );

    const { base, cookie, room, initialTopic, logs } = await setupHarness([{ path: dir }]);
    const sseEvents: WebEvent[] = [];
    const unsubSse = room.subscribe(initialTopic.id, (_id, ev) => sseEvents.push(ev));

    try {
      // Trigger topic, message, and turn events
      const created = room.createTopic('Second');
      room.post(created.id, { own: false, html: '<p>hi</p>' }, 'hi');
      room.setTyping(created.id, true);
      room.setTyping(created.id, false);

      const seenRes = await fetch(`${base}/api/plugins/events-mod/seen`, { headers: { cookie } });
      const { seen } = (await seenRes.json()) as { seen: Array<{ kind: string; phase?: string; text?: string }> };
      expect(seen.some((s) => s.kind === 'topic')).toBe(true);
      expect(seen.some((s) => s.kind === 'message' && s.text === 'hi')).toBe(true);
      expect(seen.filter((s) => s.kind === 'turn').map((s) => s.phase)).toEqual(['start', 'end']);
      expect(logs.some((l) => l.includes('listener boom'))).toBe(true);

      // Unsubscribe topic listener and verify it stops firing
      await fetch(`${base}/api/plugins/events-mod/unsub-topic`, { method: 'POST', headers: { cookie } });
      const beforeCount = seen.filter((s) => s.kind === 'topic').length;
      room.createTopic('Third');
      const seenAfter = (await (await fetch(`${base}/api/plugins/events-mod/seen`, { headers: { cookie } })).json()) as {
        seen: Array<{ kind: string }>;
      };
      expect(seenAfter.seen.filter((s) => s.kind === 'topic').length).toBe(beforeCount);

      // Push custom SSE event
      const pushRes = await fetch(`${base}/api/plugins/events-mod/push`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'tick', data: { count: 42 } }),
      });
      expect(pushRes.status).toBe(200);

      const pluginEv = sseEvents.find((e) => e.t === 'plugin:events-mod:tick');
      expect(pluginEv).toEqual({
        t: 'plugin:events-mod:tick',
        plugin: 'events-mod',
        type: 'tick',
        data: { count: 42 },
      });
    } finally {
      unsubSse();
    }
  });

  it('persists plugin storage atomically to <storageDir>/<id>.json with 0600 mode and cleans up on dispose()', async () => {
    const markerFile = path.join(tmpDir, 'deactivated.txt');
    const dir = writeServerPlugin(
      path.join(tmpDir, 'plugins', 'store-mod'),
      { id: 'store-mod', name: 'Store', version: '1.0.0', server: 'server.mjs' },
      `
      import fs from 'node:fs';
      let calls = 0;
      export function activate(host) {
        host.events.on('topic', () => { calls += 1; });
        host.routes.get('/state', async (_req, res) => {
          const value = await host.storage.read();
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ value: value ?? null, calls }));
        });
        host.routes.post('/state', async (req, res) => {
          const chunks = [];
          for await (const c of req) chunks.push(c);
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          await host.storage.write(body);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        });
      }
      export function deactivate() {
        fs.writeFileSync(${JSON.stringify(markerFile)}, 'bye', 'utf8');
      }
      `
    );

    const { base, cookie, room, manager, storageDir } = await setupHarness([{ path: dir }]);

    // Initially empty -> null
    const initial = await (await fetch(`${base}/api/plugins/store-mod/state`, { headers: { cookie } })).json();
    expect(initial).toEqual({ value: null, calls: 0 });

    // Write and read back
    const writeRes = await fetch(`${base}/api/plugins/store-mod/state`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ count: 7, nested: { ok: true } }),
    });
    expect(writeRes.status).toBe(200);

    const afterWrite = await (await fetch(`${base}/api/plugins/store-mod/state`, { headers: { cookie } })).json();
    expect(afterWrite).toEqual({ value: { count: 7, nested: { ok: true } }, calls: 0 });

    // Verify file location, mode 0600, and no leftover temp files
    const targetFile = path.join(storageDir, 'store-mod.json');
    expect(fs.existsSync(targetFile)).toBe(true);
    if (process.platform !== 'win32') {
      expect(fs.statSync(targetFile).mode & 0o777).toBe(0o600);
    }
    const leftovers = fs.readdirSync(storageDir).filter((f) => f.endsWith('.tmp'));
    expect(leftovers).toEqual([]);

    // Dispose cleans up routes, subscriptions, and runs deactivate()
    await manager.dispose();
    expect(manager.activePluginIds).toEqual([]);
    expect(fs.readFileSync(markerFile, 'utf8')).toBe('bye');

    const afterDispose = await fetch(`${base}/api/plugins/store-mod/state`, { headers: { cookie } });
    expect(afterDispose.status).toBe(404);

    // Room events after dispose do not throw or leak
    expect(() => room.createTopic('After dispose')).not.toThrow();
  });
});
