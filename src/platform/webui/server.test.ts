import fs from 'node:fs';
import { createSign, generateKeyPairSync, randomBytes } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { brotliDecompressSync, createGunzip, gunzipSync, inflateSync } from 'node:zlib';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';

import { WebuiConfigSchema } from '../config-schemas.js';
import type {
  FilesPanel,
  InstructionsPanel,
  ReviewPanelEntry,
  SchedulePanel,
  SchedulePanelEdit,
  SchedulePanelFormContext,
  SchedulePanelTask,
  SchedulePanelTaskDetail,
  SkillPanelEntry,
} from '../adapter.js';
import { WebAuth } from './auth.js';
import { loadAssets, type WebAssets } from './assets.js';
import { diskUploadStore } from './index.js';
import { PluginHostManager } from './plugins/host.js';
import { loadPlugins, type LoadedPluginEntry } from './plugins/loader.js';
import { MAX_READ_BYTES } from './reading.js';
import { WebRoom, type WebuiInstance } from './room.js';
import { createWebServer, type PluginRouteDispatcher, type WebServer } from './server.js';
import { WebSso, type SsoOptions } from './sso.js';
import { TerminalSessions } from './terminal-sessions.js';
import { TopicStore } from './topics.js';
import { WebPush } from './webpush.js';

/**
 * These run a real server on a real (ephemeral, loopback) port.
 *
 * Worth the loop rather than asserting against a fake `req`/`res`: what is checked here is
 * header behaviour, status codes, that a compressed stream actually delivers events one at a
 * time, and that shutdown terminates — every one of which is a property of `node:http` and
 * `node:zlib` rather than of the handler a mock could stand in for.
 */
const running: WebServer[] = [];
let dir = '';
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webui-server-'));
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(running.splice(0).map((s) => s.stop()));
  fs.rmSync(dir, { recursive: true, force: true });
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const addr = probe.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

interface Booted {
  room: WebRoom;
  server: WebServer;
  base: string;
  port: number;
  topic: string;
  instance: WebuiInstance;
  sessions: TerminalSessions;
}

async function boot(
  over: Partial<WebuiInstance> = {},
  terminal: { enabled: boolean; socket: string; endCommand?: string[] } = {
    enabled: false,
    socket: '/nonexistent.sock',
  },
  sso?: WebSso,
  push?: WebPush,
  assets?: WebAssets,
  plugins: readonly LoadedPluginEntry[] = [],
  pluginHost?: PluginRouteDispatcher
): Promise<Booted> {
  const port = await freePort();
  const instance: WebuiInstance = {
    ...WebuiConfigSchema.parse({ type: 'webui', token: 'open-sesame' }),
    id: 'webui',
    host: '127.0.0.1',
    port,
    ...over,
  };
  const topics = new TopicStore(path.join(dir, `${port}.json`));
  const topic = topics.current().id;
  const room = new WebRoom(instance, topics);
  const sessions = new TerminalSessions(terminal.endCommand);
  room.useTerminalSessions(sessions);
  const server = createWebServer(
    room,
    new WebAuth({ token: instance.token }),
    instance,
    { enabled: terminal.enabled, socket: terminal.socket, sessions },
    sso,
    push,
    // A test that does not hand in a build gets an empty one, not whatever the developer's last
    // `npm run build` left in dist: the page's CODEVIEW and the route's answers are then the same
    // on every machine, and this file does not read outside its own temp directory.
    assets ?? loadAssets(path.join(dir, `no-assets-${port}`)),
    plugins,
    pluginHost
  );
  await server.start();
  running.push(server);
  return { room, server, base: `http://127.0.0.1:${port}`, port, topic, instance, sessions };
}

const JSON_HEADERS = { 'content-type': 'application/json' };

/** What the page hands its script: the `boot-config` JSON page.ts writes in place of an inline script. */
function bootOf(html: string): Record<string, unknown> {
  const json = /<script type="application\/json" id="boot-config">([^<]*)<\/script>/.exec(html)?.[1];
  if (json === undefined) throw new Error('the page has no boot-config');
  return JSON.parse(json) as Record<string, unknown>;
}

/**
 * Spin until something becomes true, or give up loudly.
 *
 * For facts that land on a socket event rather than in the response: a peer's close reaches
 * this process some turns after the client destroyed its end, and how many is `node:net`'s
 * business. A fixed sleep here would be a test that passes until the machine is busy.
 */
async function until(ok: () => boolean, what = 'condition'): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (ok()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`never happened: ${what}`);
}

async function signIn(base: string, token = 'open-sesame'): Promise<string> {
  const res = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ token }),
  });
  return (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
}

/** Open an event stream with raw `node:http`, so compression is visible instead of undone. */
function openStream(
  port: number,
  topic: string,
  cookie: string,
  lastEventId?: string,
  query = ''
): Promise<{ res: http.IncomingMessage; next: () => Promise<string>; close: () => void }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: `/api/events?t=${topic}${query}`,
        headers: {
          cookie,
          'accept-encoding': 'gzip',
          ...(lastEventId ? { 'last-event-id': lastEventId } : {}),
        },
      },
      (res) => {
        const out = res.headers['content-encoding'] === 'gzip' ? res.pipe(createGunzip()) : res;
        const pending: string[] = [];
        let waiting: ((chunk: string) => void) | null = null;
        out.on('data', (chunk: Buffer) => {
          const text = chunk.toString('utf8');
          if (waiting) {
            const fn = waiting;
            waiting = null;
            fn(text);
          } else pending.push(text);
        });
        resolve({
          res,
          next: () =>
            new Promise<string>((done) => {
              const ready = pending.shift();
              if (ready !== undefined) done(ready);
              else waiting = done;
            }),
          close: () => req.destroy(),
        });
      }
    );
    req.once('error', reject);
    req.end();
  });
}

describe('webui server: the page', () => {
  it('serves the page without a session, since the page is how you get one', async () => {
    const { base } = await boot();
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('<title>Chat</title>');
    expect(html).not.toMatch(/(src|href)="https?:/);
  });

  it('escapes the configured title instead of letting config.yaml write markup', async () => {
    const { base } = await boot({ title: '</title><script>alert(1)</script>' });
    const html = await fetch(`${base}/`).then((r) => r.text());
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;/title&gt;');
  });

  it('compresses it, because the page is the largest thing on the wire', async () => {
    const { port } = await boot();
    const res = await rawGet(port, '/', { 'accept-encoding': 'gzip' });
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(res.headers.vary).toBe('Accept-Encoding');
    expect(gunzipSync(res.body).toString('utf8')).toContain('<title>Chat</title>');
  });

  it('answers a browser that already holds this page with a 304, and an upgraded page with the page', async () => {
    const { port } = await boot();
    const first = await rawGet(port, '/', { 'accept-encoding': 'gzip' });
    const etag = String(first.headers.etag);
    // Kept and asked about every time, never used unasked: no-cache is what makes an upgrade show
    // at the next load. private, because the answer may carry a renewed session cookie.
    expect(first.headers['cache-control']).toBe('private, no-cache');
    expect(etag).toMatch(/^W\/"[\w-]+"$/);
    const again = await rawGet(port, '/', { 'accept-encoding': 'gzip', 'if-none-match': etag });
    expect(again.status).toBe(304);
    expect(again.body.length).toBe(0);
    expect(again.headers.etag).toBe(etag);
    // A list, and the strong spelling of the same tag, are the same question.
    const listed = await rawGet(port, '/', { 'if-none-match': `"x", ${etag.slice(2)}` });
    expect(listed.status).toBe(304);
    // A page the browser holds from another build — here, another render of it — is not this one.
    const stale = await rawGet(port, '/', { 'if-none-match': 'W/"from-before-the-upgrade"' });
    expect(stale.status).toBe(200);
    expect(stale.body.toString('utf8')).toContain('<title>Chat</title>');
  });

  it('hashes what it renders, so anything that changes the page changes its validator', async () => {
    const a = await boot();
    const b = await boot({ title: 'Another' });
    const c = await boot({}, { enabled: true, socket: '/nonexistent.sock' });
    const tags = await Promise.all([a, b, c].map(async (x) => (await rawGet(x.port, '/')).headers.etag));
    expect(new Set(tags).size).toBe(3);
    // And the browser holding a's page is given b's whole, not told it is current.
    expect((await rawGet(b.port, '/', { 'if-none-match': String(tags[0]) })).status).toBe(200);
  });

  it('serves the same validator compressed or not, for the same page', async () => {
    const { port } = await boot();
    const plain = await rawGet(port, '/');
    const zipped = await rawGet(port, '/', { 'accept-encoding': 'gzip' });
    expect(plain.headers['content-encoding']).toBeUndefined();
    expect(plain.headers.vary).toBe('Accept-Encoding');
    expect(zipped.headers.etag).toBe(plain.headers.etag);
    expect(gunzipSync(zipped.body).equals(plain.body)).toBe(true);
  });

  it('serves brotli to a client that takes it, once it has been made, and gzip until then', async () => {
    // Quality 11 is ~18% smaller than gzip and takes about a second, so it is made once, off the
    // event loop, the first time someone could use it — never per request.
    const { port } = await boot();
    const plain = await rawGet(port, '/');
    const first = await rawGet(port, '/', { 'accept-encoding': 'gzip, br' });
    expect(first.headers['content-encoding']).toBe('gzip');
    let br = first;
    for (let i = 0; i < 100 && br.headers['content-encoding'] !== 'br'; i++) {
      await new Promise((r) => setTimeout(r, 50));
      br = await rawGet(port, '/', { 'accept-encoding': 'gzip, deflate, br' });
    }
    expect(br.headers['content-encoding']).toBe('br');
    expect(br.headers.vary).toBe('Accept-Encoding');
    expect(br.headers.etag).toBe(plain.headers.etag);
    expect(brotliDecompressSync(br.body).equals(plain.body)).toBe(true);
    expect(br.body.length).toBeLessThan(first.body.length);
    // A client that says no to br, or never mentions it, is not sent it.
    expect((await rawGet(port, '/', { 'accept-encoding': 'gzip, br;q=0' })).headers['content-encoding']).toBe('gzip');
    expect((await rawGet(port, '/', { 'accept-encoding': 'gzip' })).headers['content-encoding']).toBe('gzip');
    // The event stream stays gzip whatever the client takes: it is flushed per event.
    const { base } = await boot();
    const cookie = await signIn(base);
    const ev = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: Number(new URL(base).port), path: '/api/events', headers: { cookie, 'accept-encoding': 'br, gzip' } },
        resolve
      );
      req.once('error', reject);
      req.end();
    });
    expect(ev.headers['content-encoding']).toBe('gzip');
    ev.destroy();
  });

  it('still renews a live session cookie on a 304', async () => {
    const { base, port } = await boot();
    const cookie = await signIn(base);
    const { headers } = await rawGet(port, '/');
    const res = await rawGet(port, '/', { cookie, 'if-none-match': String(headers.etag) });
    expect(res.status).toBe(304);
    expect(String(res.headers['set-cookie']).split(';')[0]).toBe(cookie);
  });

  it('names its build in a HEAD, and the page it serves carries the same one', async () => {
    // How a page left open through a restart learns whether the daemon now serves another page:
    // one round trip, no body, compared with the BUILD its script reads from the boot config.
    const { port } = await boot();
    const head = await rawGet(port, '/', {}, 'HEAD');
    expect(head.status).toBe(200);
    expect(head.body.length).toBe(0);
    const page = await rawGet(port, '/');
    expect(head.headers.etag).toBe(page.headers.etag);
    const build = /^W\/"(.+)"$/.exec(String(page.headers.etag))?.[1] ?? '';
    expect(build).not.toBe('');
    expect(bootOf(page.body.toString('utf8')).build).toBe(build);
  });
});

/** A GET with raw `node:http`, so compression and a 304 are visible instead of undone by fetch. */
function rawGet(
  port: number,
  path: string,
  headers: Record<string, string> = {},
  method = 'GET'
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, headers, method }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.once('error', reject);
    req.end();
  });
}

describe('webui server: installing it as an app', () => {
  it('serves the manifest and both icons without a session', async () => {
    // The browser fetches all three while deciding whether the site can be installed, which is
    // before anyone has signed in. A 401 here reads as "not installable", with no error to see.
    const { base } = await boot();

    const manifest = await fetch(`${base}/manifest.webmanifest`);
    expect(manifest.status).toBe(200);
    expect(manifest.headers.get('content-type')).toContain('application/manifest+json');

    const svg = await fetch(`${base}/icon.svg`);
    expect(svg.status).toBe(200);
    expect(svg.headers.get('content-type')).toBe('image/svg+xml');

    const png = await fetch(`${base}/icon.png`);
    expect(png.status).toBe(200);
    expect(png.headers.get('content-type')).toBe('image/png');
    // The PNG signature. Proves the base64 in manifest.ts survived whatever edited it, which
    // is the one way these bytes can rot without anything else noticing.
    const bytes = Buffer.from(await png.arrayBuffer());
    expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([192, 192]);
    // The bottom row must not be blank white — headless Chrome cropped the viewport at 105px
    // when --window-size=192,192 counted window decorations, leaving the rest unpainted.
    const idatPos = bytes.indexOf('IDAT');
    const idatLen = bytes.readUInt32BE(idatPos - 4);
    const raw = inflateSync(bytes.subarray(idatPos + 4, idatPos + 4 + idatLen));
    const stride = 1 + 192 * 4;
    const lastRow = raw.subarray(raw.length - stride + 1);
    expect(lastRow.some((b) => b !== 255)).toBe(true);
  });

  it('names the app after the configured title', async () => {
    const { base } = await boot({ title: 'Ops box' });
    const m = await fetch(`${base}/manifest.webmanifest`).then((r) => r.json());
    expect(m.name).toBe('Ops box');
    expect(m.short_name).toBe('Ops box');
    expect(m.display).toBe('standalone');
  });

  it('keeps every manifest URL relative, so a sub-path mount still resolves', async () => {
    // Same rule the page follows for api/events. An absolute "/" would walk out of a prefix a
    // reverse proxy put the daemon under, and the installed app would open on the proxy's root.
    const { base } = await boot();
    const m = await fetch(`${base}/manifest.webmanifest`).then((r) => r.json());
    for (const url of [m.start_url, m.scope, ...m.icons.map((i: { src: string }) => i.src)]) {
      expect(url.startsWith('/')).toBe(false);
      expect(url).not.toMatch(/^https?:/);
    }
  });

  it('lets the page reach its own manifest and icons through the CSP', async () => {
    // default-src is 'none', and manifest-src/img-src both fall back to it — so without these
    // two the browser blocks the very files that make the site installable, and the only
    // symptom is a console warning nobody is watching on a phone.
    const { base } = await boot();
    const csp = (await fetch(`${base}/`)).headers.get('content-security-policy') ?? '';
    expect(csp).toContain("manifest-src 'self'");
    expect(csp).toContain("img-src 'self' data:");
  });
});

/**
 * A built asset directory as `scripts/build-webui-assets.mjs` leaves one: hashed names, with a
 * manifest naming the page's script and stylesheet and the code view's entry. Written per test
 * under the file's own temp directory.
 */
function buildAssets(files: Record<string, string>): WebAssets {
  const at = fs.mkdtempSync(path.join(dir, 'assets-'));
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(at, name), body);
  const named = (prefix: string): string | null => Object.keys(files).find((n) => n.startsWith(prefix)) ?? null;
  fs.writeFileSync(
    path.join(at, 'manifest.json'),
    JSON.stringify({ app: named('app-'), boot: named('boot-'), style: named('style-'), codeview: named('codeview-') })
  );
  return loadAssets(at);
}

describe('webui server: the page’s own script and stylesheet', () => {
  const app = 'app-abc123.js';
  const bootScript = 'boot-112233.js';
  const style = 'style-def456.css';
  const codeview = 'codeview-0a1b2c.js';
  const files = {
    [app]: '(function(){})();',
    [bootScript]: '(function(){})();',
    [style]: 'body{color:red}',
    [codeview]: 'export default 1;',
  };

  it('links both from the page, relatively', async () => {
    const { base } = await boot({}, undefined, undefined, undefined, buildAssets(files));
    const html = await (await fetch(`${base}/`)).text();
    expect(html).toContain(`<link rel="stylesheet" href="assets/${style}">`);
    expect(html).toContain(`<script src="assets/${bootScript}"></script>`);
    expect(html).toContain(`<script src="assets/${app}"></script>`);
    expect(html).not.toContain('id="unbuilt"');
  });

  it('serves both before sign-in, since the gate is drawn by them — and nothing else under /assets/', async () => {
    const { base, port } = await boot({}, undefined, undefined, undefined, buildAssets(files));
    const js = await rawGet(port, `/assets/${app}`);
    expect(js.status).toBe(200);
    expect(js.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(js.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(js.headers['x-content-type-options']).toBe('nosniff');
    const bootRes = await rawGet(port, `/assets/${bootScript}`);
    expect(bootRes.status).toBe(200);
    expect(bootRes.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(bootRes.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    const css = await rawGet(port, `/assets/${style}`);
    expect(css.status).toBe(200);
    // Declared, never sniffed: with nosniff a browser applies a stylesheet only under this type.
    expect(css.headers['content-type']).toBe('text/css; charset=utf-8');
    expect(css.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(css.body.toString('utf8')).toBe('body{color:red}');
    // The code view is not needed to sign in, so it stays behind the session…
    expect((await fetch(`${base}/assets/${codeview}`)).status).toBe(401);
    // …and so does any other name, built or not.
    expect((await fetch(`${base}/assets/app-nope.js`)).status).toBe(401);
    const cookie = await signIn(base);
    expect((await rawGet(port, `/assets/${codeview}`, { cookie })).status).toBe(200);
    expect((await rawGet(port, `/assets/${style}`, { cookie })).status).toBe(200);
  });

  it('says the page was not built when there is no script to link', async () => {
    const { base, port } = await boot();
    const html = await (await fetch(`${base}/`)).text();
    expect(html).toContain('id="unbuilt"');
    expect(html).not.toContain('<script src=');
    // Nothing is open under /assets/ when nothing was built.
    expect((await rawGet(port, '/assets/app-abc123.js')).status).toBe(401);
  });
});

describe('webui server: the code view’s bundle', () => {
  const entry = 'codeview-abc123.js';
  const chunk = 'chunk-def456.js';

  it('serves the built entry and its lazily loaded chunks as immutable JavaScript', async () => {
    const assets = buildAssets({ [entry]: 'export default {editor(){}}', [chunk]: 'export const a=1;' });
    const { base, port } = await boot({}, undefined, undefined, undefined, assets);
    const cookie = await signIn(base);
    for (const name of [entry, chunk]) {
      const res = await rawGet(port, `/assets/${name}`, { cookie });
      expect(res.status, name).toBe(200);
      expect(res.headers['content-type']).toBe('text/javascript; charset=utf-8');
      // The name carries a content hash, so the bytes behind it never change.
      expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
      // Same pin as every other file this server hands out: declared type, never sniffed.
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.body.toString('utf8')).toContain('export');
    }
  });

  it('is guarded like every other route, and answers 404 for anything not built', async () => {
    const assets = buildAssets({ [entry]: 'export default 1;' });
    const { base, port } = await boot({}, undefined, undefined, undefined, assets);
    expect((await fetch(`${base}/assets/${entry}`)).status).toBe(401);
    const cookie = await signIn(base);
    expect((await rawGet(port, '/assets/codeview-nope.js', { cookie })).status).toBe(404);
    // The manifest is a build artefact too, but neither script nor stylesheet: either type would be a lie.
    expect((await rawGet(port, '/assets/manifest.json', { cookie })).status).toBe(404);
    // A directory that was never built answers 404 rather than throwing.
    const bare = await boot({}, undefined, undefined, undefined, loadAssets(path.join(dir, 'not-built')));
    expect((await rawGet(bare.port, `/assets/${entry}`, { cookie: await signIn(bare.base) })).status).toBe(404);
  });

  it('has no spelling of a path that reaches a file outside the asset directory', async () => {
    const assets = buildAssets({ [entry]: 'export default 1;' });
    const { base, port } = await boot({}, undefined, undefined, undefined, assets);
    // A neighbour of the directory, containing bytes that must never be served.
    fs.writeFileSync(path.join(dir, 'secret.js'), 'stolen bytes');
    const cookie = await signIn(base);
    for (const p of [
      '/assets/../secret.js',
      '/assets/%2e%2e/secret.js',
      '/assets/..%2fsecret.js',
      '/assets/%2e%2e%2fsecret.js',
      '/assets/./secret.js',
      '/assets/secret.js/../../secret.js',
      `/assets/${encodeURIComponent('../secret.js')}`,
    ]) {
      const res = await rawGet(port, p, { cookie });
      expect(res.status, p).toBe(404);
      expect(res.body.toString('utf8'), p).not.toContain('stolen');
    }
  });

  it('names the entry in the page it serves, relatively, and only when a build exists', async () => {
    const bare = await boot();
    expect(bootOf(await (await fetch(`${bare.base}/`)).text()).codeview).toBeNull();

    const built = await boot({}, undefined, undefined, undefined, buildAssets({ [entry]: 'export default 1;' }));
    const html = await (await fetch(`${built.base}/`)).text();
    // Relative, so a gateway behind a reverse proxy under a sub-path loads its own bundle.
    expect(bootOf(html).codeview).toBe(`assets/${entry}`);
  });

  it('lets the page load its files through the CSP, refuses every inline script, and nothing from another origin', async () => {
    const { base } = await boot();
    const csp = (await fetch(`${base}/`)).headers.get('content-security-policy') ?? '';
    // 'self' alone: since the script moved to client/ the page carries none inline, so an inline
    // script that got past web-markdown's escaping would not run.
    expect(csp).toContain("script-src 'self';");
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    // The stylesheet is a file too; the inline style attributes the script sets still need the rest.
    expect(csp).toContain("style-src 'self' 'unsafe-inline';");
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain('script-src http');
  });

  it('writes a JavaScript content type in two places only: the assets and the service worker', async () => {
    // What this pins is what THIS FILE writes, and no more: a route of its own that handed a file
    // back with its own type would be the failure. It cannot speak for `/term/`, which copies the
    // upstream's headers verbatim — the test above shows a fake ttyd answering text/javascript
    // untouched — so the security note says this file, not this origin.
    const source = fs.readFileSync(new URL('./server.ts', import.meta.url), 'utf8');
    const at = [...source.matchAll(/'Content-Type': '(text\/javascript[^']*)'/g)];
    expect(at).toHaveLength(2);
    /** The name of the handler each occurrence sits in. */
    const enclosing = (index: number): string | undefined =>
      [...source.slice(0, index).matchAll(/(?:async )?function (\w+)/g)].at(-1)?.[1];
    expect(at.map((m) => enclosing(m.index ?? 0))).toEqual(['sendServiceWorker', 'asset']);
    // And the behavioural half: a file the agent sent is JavaScript by NAME and octet-stream by
    // type, so the CSP's 'self' never lets one run as the second.
    const { base, room } = await boot();
    const cookie = await signIn(base);
    const url = room.publish(new URL(import.meta.url).pathname, 'evil.js');
    const res = await fetch(`${base}/${url}`, { headers: { cookie } });
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('content-disposition')).toContain('attachment');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });
});

describe('webui server: the door', () => {
  it('refuses every guarded route without a session', async () => {
    const { base, topic } = await boot();
    expect((await fetch(`${base}/api/events`)).status).toBe(401);
    const send = await fetch(`${base}/api/send`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ topic, text: 'x' }),
    });
    expect(send.status).toBe(401);
  });

  it('refuses the wrong token and accepts the right one', async () => {
    const { base } = await boot();
    const bad = await fetch(`${base}/api/login`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ token: 'nope' }) });
    expect(bad.status).toBe(401);
    expect(bad.headers.get('set-cookie')).toBeNull();

    const good = await fetch(`${base}/api/login`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ token: 'open-sesame' }) });
    expect(good.status).toBe(200);
    const cookie = good.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    // No Secure over plain http, or the browser drops the cookie and login appears to succeed
    // while nothing works.
    expect(cookie).not.toContain('Secure');
  });

  it('re-issues a live session cookie on page load, and nothing to a stranger', async () => {
    const { base } = await boot();
    const cookie = await signIn(base);
    const page = await fetch(`${base}/`, { headers: { cookie } });
    expect(page.status).toBe(200);
    // Same session, fresh Max-Age: the browser otherwise drops it a week after login however
    // often it is used.
    expect((page.headers.get('set-cookie') ?? '').split(';')[0]).toBe(cookie);
    expect(page.headers.get('set-cookie')).toContain('Max-Age=');

    const stranger = await fetch(`${base}/`, { headers: { cookie: 'aa_webui=forged' } });
    expect(stranger.status).toBe(200);
    expect(stranger.headers.get('set-cookie')).toBeNull();
  });

  it('throttles a run of guesses with a 429 and a Retry-After', async () => {
    const { base } = await boot();
    let last = new Response();
    for (let i = 0; i < 6; i += 1) {
      last = await fetch(`${base}/api/login`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ token: 'nope' }) });
    }
    expect(last.status).toBe(429);
    expect(last.headers.get('retry-after')).toBe('60');
  });

  it('rejects a body that is not JSON, which is half of the CSRF defence', async () => {
    const { base, topic } = await boot();
    const cookie = await signIn(base);
    const res = await fetch(`${base}/api/send`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'text/plain' },
      body: JSON.stringify({ topic, text: 'x' }),
    });
    expect(res.status).toBe(415);
  });

  it('rejects a state-changing request that came from another origin', async () => {
    const { base, topic } = await boot();
    const cookie = await signIn(base);
    const res = await fetch(`${base}/api/send`, {
      method: 'POST',
      headers: { ...JSON_HEADERS, cookie, origin: 'https://evil.example' },
      body: JSON.stringify({ topic, text: 'x' }),
    });
    expect(res.status).toBe(403);
  });

  it.each([
    ['an unknown key', { topic: 'aaaaaaaa', text: 'x', admin: true }],
    ['a malformed topic id', { topic: 'not-a-topic', text: 'x' }],
    ['no topic at all', { text: 'x' }],
  ])('rejects %s', async (_label, body) => {
    const { base } = await boot();
    const cookie = await signIn(base);
    const res = await fetch(`${base}/api/send`, {
      method: 'POST',
      headers: { ...JSON_HEADERS, cookie },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(400);
  });
});

/**
 * A `WebSso` whose provider is in this file: one keypair, a JWKS served by an injected fetch,
 * and tokens signed on demand. Nothing here opens a socket to the outside.
 */
const provider = generateKeyPairSync('rsa', { modulusLength: 2048 });

function ssoFor(over: Partial<SsoOptions> = {}): { sso: WebSso; token: (claims?: Record<string, unknown>) => string } {
  const jwks = JSON.stringify({
    keys: [{ ...provider.publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' }],
  });
  const sso = new WebSso({
    header: 'Cf-Access-Jwt-Assertion',
    cookie: 'CF_Authorization',
    jwksUrl: 'https://idp.example/certs',
    issuer: 'https://idp.example',
    audience: 'aud-tag',
    claim: 'email',
    allow: ['operator@example.com'],
    from: ['127.0.0.1'],
    fetch: (async () => ({ ok: true, status: 200, headers: new Headers(), text: async () => jwks }) as Response) as unknown as typeof globalThis.fetch,
    ...over,
  });
  const token = (claims: Record<string, unknown> = {}): string => {
    const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o), 'utf8').toString('base64url');
    const head = b64({ alg: 'RS256', kid: 'k1' });
    const body = b64({
      iss: 'https://idp.example',
      aud: 'aud-tag',
      email: 'operator@example.com',
      exp: Math.floor(Date.now() / 1000) + 3600,
      ...claims,
    });
    const sig = createSign('RSA-SHA256').update(`${head}.${body}`).sign(provider.privateKey).toString('base64url');
    return `${head}.${body}.${sig}`;
  };
  return { sso, token };
}

describe('webui server: the other door', () => {
  it('admits a request carrying the proxy assertion, with no session cookie at all', async () => {
    const { sso, token } = ssoFor();
    const { base, topic } = await boot({}, undefined, sso);
    const res = await fetch(`${base}/api/send`, {
      method: 'POST',
      headers: { ...JSON_HEADERS, 'cf-access-jwt-assertion': token() },
      body: JSON.stringify({ text: 'hello', topic }),
    });
    expect(res.status).toBe(202);
  });

  it('still refuses one the proxy did not sign', async () => {
    const { sso } = ssoFor();
    const { base } = await boot({}, undefined, sso);
    const res = await fetch(`${base}/api/events`, { headers: { 'cf-access-jwt-assertion': 'nope.nope.nope' } });
    expect(res.status).toBe(401);
  });

  it('refuses one for somebody else, even correctly signed', async () => {
    const { sso, token } = ssoFor();
    const { base } = await boot({}, undefined, sso);
    const res = await fetch(`${base}/api/events`, {
      headers: { 'cf-access-jwt-assertion': token({ email: 'stranger@example.com' }) },
    });
    expect(res.status).toBe(401);
  });

  it('refuses it when the request did not come from the proxy `from` names', async () => {
    // 10.0.0.0/8 cannot be this loopback connection, which is the point: the assertion is
    // perfect and the request is still turned away.
    const { sso, token } = ssoFor({ from: ['10.0.0.0/8'] });
    const { base } = await boot({}, undefined, sso);
    const res = await fetch(`${base}/api/events`, { headers: { 'cf-access-jwt-assertion': token() } });
    expect(res.status).toBe(401);
  });

  it('admits the terminal handshake too — the gate an upgrade bypasses', async () => {
    const socket = path.join(dir, 'sso-term.sock');
    const ttyd = await fakeTtyd(socket);
    const { sso, token } = ssoFor();
    const { port, topic, base } = await boot({}, { enabled: true, socket }, sso);
    // Through the cookie, because that is the form the assertion takes on a handshake the proxy
    // does not add headers to.
    const res = await handshake(port, `/term/ws?arg=${topic}`, {
      cookie: `CF_Authorization=${token()}`,
      origin: base,
    });
    expect(res.status).toBe(101);
    await ttyd.close();
  });

  it('refuses a handshake with neither cookie nor header', async () => {
    const socket = path.join(dir, 'sso-term-2.sock');
    const ttyd = await fakeTtyd(socket);
    const { sso } = ssoFor();
    const { port, topic, base } = await boot({}, { enabled: true, socket }, sso);
    const res = await handshake(port, `/term/ws?arg=${topic}`, { origin: base });
    expect(res.status).not.toBe(101);
    expect(ttyd.seen).toHaveLength(0);
    await ttyd.close();
  });

  it('closes the password door when told to, and serves a page with no field in it', async () => {
    const { sso: ssoConfig } = WebuiConfigSchema.parse({
      type: 'webui',
      token: 'open-sesame',
      sso: {
        jwksUrl: 'https://idp.example/certs',
        issuer: 'https://idp.example',
        audience: 'aud-tag',
        allow: ['operator@example.com'],
        from: ['127.0.0.1'],
        password: false,
      },
    });
    const { sso, token } = ssoFor();
    const { base, topic } = await boot({ sso: ssoConfig }, undefined, sso);
    const refused = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ token: 'open-sesame' }),
    });
    expect(refused.status).toBe(403);
    expect(await (await fetch(base)).text()).not.toContain('id="secret"');
    // And the other door still opens.
    const ok = await fetch(`${base}/api/send`, {
      method: 'POST',
      headers: { ...JSON_HEADERS, 'cf-access-jwt-assertion': token() },
      body: JSON.stringify({ text: 'hi', topic }),
    });
    expect(ok.status).toBe(202);
  });

  it('leaves the password door open by default when sso is configured', async () => {
    const { sso } = ssoFor();
    const { base } = await boot({}, undefined, sso);
    expect(await signIn(base)).toContain('aa_webui=');
    expect(await (await fetch(base)).text()).toContain('id="secret"');
  });

  it('answers whether a topic exists only to someone already admitted', async () => {
    // Moving the arg check ahead of admission (it is cheap, and the gate is now async) would
    // have turned "400 vs 401" into an existence oracle for topic ids a stranger could walk.
    const socket = path.join(dir, 'sso-term-3.sock');
    const ttyd = await fakeTtyd(socket);
    const { sso } = ssoFor();
    const { port, topic, base } = await boot({}, { enabled: true, socket }, sso);
    const real = await handshake(port, `/term/ws?arg=${topic}`, { origin: base });
    const fake = await handshake(port, '/term/ws?arg=00000000', { origin: base });
    expect(real.status).toBe(fake.status);
    expect(real.status).not.toBe(101);
    await ttyd.close();
  });

});

describe('webui server: topics', () => {
  it('opens one and reports it', async () => {
    const { base } = await boot();
    const cookie = await signIn(base);
    const res = await fetch(`${base}/api/topics`, { method: 'POST', headers: { ...JSON_HEADERS, cookie }, body: '{}' });
    expect(res.status).toBe(201);
    const made = (await res.json()) as { topic: { id: string } };
    expect(made.topic.id).toMatch(/^[0-9a-f]{8}$/);
  });

  it('streams only the topic that was asked for', async () => {
    const { base, port, room, topic } = await boot();
    const cookie = await signIn(base);
    const other = room.createTopic('other').id;
    const stream = await openStream(port, topic, cookie);
    await stream.next(); // the sync frame

    room.post(other, { own: false, html: '<p>elsewhere</p>' }, 'elsewhere');
    room.post(topic, { own: false, html: '<p>here</p>' }, 'here');
    // Read up to the message, since the cross-topic `topics` broadcast rides the same wire.
    let seen = '';
    for (let i = 0; i < 6 && !seen.includes('here'); i += 1) seen += await stream.next();
    // The other topic's message must not be on this wire at all — that isolation is what keeps
    // one busy room from costing a client reading a quiet one.
    expect(seen).not.toContain('elsewhere');
    expect(seen).toContain('here');
    stream.close();
  });

  it('answers 404 for a message sent to a topic that does not exist', async () => {
    const { base } = await boot();
    const cookie = await signIn(base);
    const res = await fetch(`${base}/api/send`, {
      method: 'POST',
      headers: { ...JSON_HEADERS, cookie },
      body: JSON.stringify({ topic: 'deadbeef', text: 'x' }),
    });
    expect(res.status).toBe(404);
  });

  it('deletes an existing topic and rejects unknown ones', async () => {
    const { base, room } = await boot();
    const cookie = await signIn(base);
    const created = room.createTopic('deleteme').id;

    // POST /api/topics/delete
    const res = await fetch(`${base}/api/topics/delete`, {
      method: 'POST',
      headers: { ...JSON_HEADERS, cookie },
      body: JSON.stringify({ topic: created }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(room.topics.has(created)).toBe(false);

    // Deleting again answers 404
    const res404 = await fetch(`${base}/api/topics/delete`, {
      method: 'POST',
      headers: { ...JSON_HEADERS, cookie },
      body: JSON.stringify({ topic: created }),
    });
    expect(res404.status).toBe(404);

    // Also supports DELETE /api/topics
    const another = room.createTopic('another').id;
    const resDel = await fetch(`${base}/api/topics`, {
      method: 'DELETE',
      headers: { ...JSON_HEADERS, cookie },
      body: JSON.stringify({ topic: another }),
    });
    expect(resDel.status).toBe(200);
    expect(room.topics.has(another)).toBe(false);
  });

  it('clears every topic and answers with the one that replaced them', async () => {
    const { base, room, topic } = await boot();
    const cookie = await signIn(base);
    room.createTopic('second');
    room.createTopic('third');

    const res = await fetch(`${base}/api/topics/clear`, {
      method: 'POST',
      headers: { ...JSON_HEADERS, cookie },
      body: '{}',
    });

    expect(res.status).toBe(200);
    const { topic: fresh } = (await res.json()) as { topic: { id: string } };
    // The replacement comes back in the RESPONSE: the page has its own per-topic caches to drop
    // and then has to land somewhere, and racing a POST against an SSE frame to find out where
    // is a worse contract than being told.
    expect(fresh.id).toMatch(/^[0-9a-f]{8}$/);
    expect(room.topics.list().map((t) => t.id)).toEqual([fresh.id]);
    expect(room.topics.has(topic)).toBe(false);
  });

  it('answers a clear with the list as it stands, so the page knows which caches to keep', async () => {
    const { base, room, topic } = await boot();
    const cookie = await signIn(base);
    room.createTopic('gone');
    room.starTopic(topic, true);

    const res = await fetch(`${base}/api/topics/clear`, { method: 'POST', headers: { ...JSON_HEADERS, cookie }, body: '{}' });

    const body = (await res.json()) as { topic: { id: string }; topics: Array<{ id: string }> };
    expect(body.topics.map((t) => t.id).sort()).toEqual([topic, body.topic.id].sort());
  });

  it('stars and unstars a topic, and says 404 for one that is not there', async () => {
    const { base, room, topic } = await boot();
    const cookie = await signIn(base);
    const star = (body: unknown): Promise<Response> =>
      fetch(`${base}/api/topics/star`, { method: 'POST', headers: { ...JSON_HEADERS, cookie }, body: JSON.stringify(body) });

    expect((await star({ topic, starred: true })).status).toBe(200);
    expect(room.topics.get(topic)?.starred).toBe(true);
    expect((await star({ topic, starred: false })).status).toBe(200);
    expect(room.topics.get(topic)?.starred).toBeUndefined();
    expect((await star({ topic: 'deadbeef', starred: true })).status).toBe(404);
    // A toggle with no stated value is refused rather than guessed at: a retried toggle flips back.
    expect((await star({ topic })).status).toBe(400);
  });

  it('makes room in a full list, and when it cannot, says why in the 409 and in the log', async () => {
    const { base, room } = await boot();
    const cookie = await signIn(base);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    while (!room.topics.full()) room.createTopic();
    const create = (): Promise<Response> =>
      fetch(`${base}/api/topics`, { method: 'POST', headers: { ...JSON_HEADERS, cookie }, body: '{}' });

    // Full is no longer a refusal: the oldest topic goes and the new one is made.
    expect((await create()).status).toBe(201);

    for (const t of room.topics.list()) room.starTopic(t.id, true);
    const res = await create();
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/^every one of the 200 topics is starred or in use/);
    // It used to leave no trace outside the browser's network panel.
    expect(warn.mock.calls.flat().join('\n')).toMatch(/\[webui\] refused to open a topic: every one/);
  });
});

describe('webui server: one topic, fetched before it is opened', () => {
  it('answers with the room as a sync would carry it, and the id that sync would be numbered with', async () => {
    const { base, port, room, topic } = await boot();
    const cookie = await signIn(base);
    room.post(topic, { own: false, html: '<p>one</p>' }, 'one');
    room.post(topic, { own: true, html: '<p>two</p>' }, 'two');

    const res = await fetch(`${base}/api/topic?t=${topic}`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const snap = (await res.json()) as {
      topic: string;
      epoch: number;
      last: string;
      lastAt: number;
      messages: Array<{ html: string; at: number }>;
    };
    expect(snap.topic).toBe(topic);
    expect(snap.messages.map((m) => m.html)).toEqual(['<p>one</p>', '<p>two</p>']);
    expect(typeof snap.epoch).toBe('number');
    // The row's lastAt as of these messages: what the page compares a cached copy with.
    expect(snap.lastAt).toBe(room.topicList().find((t) => t.id === topic)?.lastAt);
    expect(snap.lastAt).toBe(snap.messages[1]?.at);

    // The same id the sync carries, so a page that entered the topic on the strength of this
    // snapshot would resume from exactly here.
    const stream = await openStream(port, topic, cookie);
    const frame = await stream.next();
    expect(frame).toContain(`id: ${snap.last}`);
    const synced = JSON.parse(frame.slice(frame.indexOf('data: ') + 6)) as { epoch: number };
    expect(synced.epoch).toBe(snap.epoch);
    stream.close();
  });

  it('resumes from that id with only what was said after it', async () => {
    const { base, port, room, topic } = await boot();
    const cookie = await signIn(base);
    room.post(topic, { own: false, html: '<p>before</p>' }, 'before');
    const snap = (await (await fetch(`${base}/api/topic?t=${topic}`, { headers: { cookie } })).json()) as { last: string };
    room.post(topic, { own: false, html: '<p>after</p>' }, 'after');

    const stream = await openStream(port, topic, cookie, snap.last);
    let seen = '';
    for (let i = 0; i < 6 && !seen.includes('resumed'); i += 1) seen += await stream.next();
    expect(seen).not.toContain('"t":"sync"');
    expect(seen).not.toContain('before');
    expect(seen).toContain('after');
    expect(seen).toContain('"t":"resumed"');
    stream.close();
  });

  it('announces nothing to the clients already attached', async () => {
    const { base, port, room, topic } = await boot();
    const cookie = await signIn(base);
    const stream = await openStream(port, topic, cookie);
    await stream.next(); // the sync frame
    await fetch(`${base}/api/topic?t=${topic}`, { headers: { cookie } });
    // A read that told everyone else about the list would be a read with a side effect; nothing
    // is written to the wire, and the heartbeat is 25 s away.
    const quiet = await Promise.race([stream.next(), new Promise<string>((r) => setTimeout(() => r(''), 150))]);
    expect(quiet).toBe('');
    expect(room.watchers).toBe(1);
    stream.close();
  });

  it('refuses a malformed id and answers 404 for a well-formed one that is not there', async () => {
    const { base } = await boot();
    const cookie = await signIn(base);
    for (const t of ['', 'not-a-topic', '../../etc/passwd', 'a1b2c3d4e5', 'A1B2C3D4']) {
      const res = await fetch(`${base}/api/topic?t=${encodeURIComponent(t)}`, { headers: { cookie } });
      expect(res.status, `t=${t}`).toBe(400);
    }
    const missing = await fetch(`${base}/api/topic?t=deadbeef`, { headers: { cookie } });
    expect(missing.status).toBe(404);
  });

  it('compresses a large answer off the event loop and sends a small one as it is', async () => {
    const { base, port, room, topic } = await boot();
    const cookie = await signIn(base);
    room.post(topic, { own: false, html: `<p>${'x'.repeat(2000)}</p>` }, 'x');
    const empty = room.createTopic('nothing said yet').id;

    const big = await rawGet(port, `/api/topic?t=${topic}`, { cookie, 'accept-encoding': 'gzip' });
    expect(big.status).toBe(200);
    expect(big.headers['content-encoding']).toBe('gzip');
    expect(big.headers.vary).toBe('Accept-Encoding');
    expect((JSON.parse(gunzipSync(big.body).toString('utf8')) as { topic: string }).topic).toBe(topic);

    // A real topic with nothing in it answers under MIN_COMPRESS_BYTES, and gzip's own framing
    // would cost more than it saves — the same rule every other JSON answer here follows.
    const small = await rawGet(port, `/api/topic?t=${empty}`, { cookie, 'accept-encoding': 'gzip' });
    expect(small.status).toBe(200);
    expect(small.headers['content-encoding']).toBeUndefined();
    expect(small.body.length).toBeLessThan(512);
    expect((JSON.parse(small.body.toString('utf8')) as { topic: string; messages: unknown[] }).topic).toBe(empty);
    expect((JSON.parse(small.body.toString('utf8')) as { messages: unknown[] }).messages).toEqual([]);
  });

  it('refuses without a session, like every other guarded route', async () => {
    const { base, topic } = await boot();
    const res = await fetch(`${base}/api/topic?t=${topic}`);
    expect(res.status).toBe(401);
  });
});

describe('webui server: built for a weak link', () => {
  it('compresses the event stream AND still delivers each event as it happens', async () => {
    // The trap this pins: a gzip stream buffers until told otherwise, so without an explicit
    // Z_SYNC_FLUSH after every event the page receives nothing until the connection closes —
    // a "live" UI that shows the whole turn at the end of it. Without the flush this test does
    // not fail an assertion, it hangs, which is the honest reproduction of the bug.
    const { base, port, room, topic } = await boot();
    const cookie = await signIn(base);
    const stream = await openStream(port, topic, cookie);
    expect(stream.res.headers['content-encoding']).toBe('gzip');
    expect(await stream.next()).toContain('"t":"sync"');

    room.post(topic, { own: false, html: '<p>later</p>' }, 'later');
    expect(await stream.next()).toContain('later');
    stream.close();
  });

  it('resumes from where a dropped stream left off instead of re-sending everything', async () => {
    const { base, port, room, topic } = await boot();
    const cookie = await signIn(base);
    const first = await openStream(port, topic, cookie);
    await first.next();
    room.post(topic, { own: false, html: '<p>one</p>' }, 'one');
    const frame = await first.next();
    const id = /id: (\S+)/.exec(frame)?.[1] ?? '';
    expect(id).toMatch(new RegExp(`^${topic}\\.[0-9a-z]+\\.\\d+$`));
    first.close();

    room.post(topic, { own: false, html: '<p>two</p>' }, 'two');
    const second = await openStream(port, topic, cookie, id);
    const resumed = await second.next();
    // Only what was missed. Re-sending the whole conversation after every blip was the single
    // most expensive thing this protocol did on a bad connection.
    expect(resumed).toContain('two');
    expect(resumed).not.toContain('"t":"sync"');
    expect(resumed).not.toContain('one');
    second.close();
  });

  it('resumes a stream the page opened again on purpose, from the point it names in ?last=', async () => {
    // A tab back from the background opens a NEW EventSource, which cannot set Last-Event-ID; the
    // query is how it says where it got to. When EventSource later reconnects by itself, the header
    // it sends is newer than the query in the URL it reuses, and wins.
    const { base, port, room, topic } = await boot();
    const cookie = await signIn(base);
    // The ids the stream hands out, read where they are made rather than out of gzip chunks.
    const ids: string[] = [];
    room.subscribe(topic, (id, ev) => void (ev.t === 'msg' && ids.push(id)));
    room.post(topic, { own: false, html: '<p>one</p>' }, 'one');
    room.post(topic, { own: false, html: '<p>two</p>' }, 'two');
    const [early = '', late = ''] = ids;
    room.post(topic, { own: false, html: '<p>three</p>' }, 'three');

    // A resume ends with the state no backlog keeps — status, machines, the topic list — so read
    // up to the list, however the frames were chunked.
    const upToList = async (s: { next: () => Promise<string> }): Promise<string> => {
      let got = '';
      while (!got.includes('"t":"topics"') && !got.includes('"t":"sync"')) got += await s.next();
      return got;
    };
    const parked = await openStream(port, topic, cookie, undefined, `&last=${encodeURIComponent(early)}`);
    const back = await upToList(parked);
    expect(back).not.toContain('"t":"sync"');
    expect(back).toContain('two');
    expect(back).toContain('three');
    parked.close();

    const both = await openStream(port, topic, cookie, late, `&last=${encodeURIComponent(early)}`);
    const caught = await upToList(both);
    expect(caught).toContain('three');
    expect(caught).not.toContain('two');
    both.close();
  });

  /**
   * A client that asks for the stream and then stops reading, as a frozen phone's page does: a raw
   * socket, so nothing on this side drains it. Resolves once the response has started.
   */
  async function stalled(
    port: number,
    topic: string,
    cookie: string,
    opts: { gzip: boolean; lastEventId?: string }
  ): Promise<{ socket: net.Socket; closed: () => boolean; read: () => string }> {
    const socket = net.connect(port, '127.0.0.1');
    await new Promise<void>((r) => socket.once('connect', () => r()));
    let closed = false;
    socket.on('close', () => (closed = true));
    socket.on('error', () => {});
    let text = '';
    socket.on('data', (b: Buffer) => (text += b.toString('latin1')));
    socket.write(
      `GET /api/events?t=${topic} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nCookie: ${cookie}\r\n` +
        (opts.gzip ? 'Accept-Encoding: gzip\r\n' : '') +
        (opts.lastEventId ? `Last-Event-ID: ${opts.lastEventId}\r\n` : '') +
        '\r\n'
    );
    await until(() => text.includes('\r\n\r\n'), 'the stream starts');
    socket.pause();
    return { socket, closed: () => closed, read: () => text };
  }

  /** Post `n` replies of incompressible text, letting the compressor and the socket run between. */
  async function flood(room: WebRoom, topic: string, n: number, tag: string): Promise<void> {
    for (let i = 0; i < n; i++) {
      room.post(topic, { own: false, html: `<p>${tag}-${i} ${randomBytes(192 * 1024).toString('base64')}</p>` }, `${tag}-${i}`);
      await new Promise((r) => setImmediate(r));
    }
  }

  it('cuts a stream that stopped reading, and the page catches up from its last event when it comes back', async () => {
    // Nothing used to stop writing to a client that had stopped reading: every byte it did not take
    // was held here, without limit — 153 MB after 2000 posts to one stalled stream (2026-11-07).
    vi.useFakeTimers({ toFake: ['Date'] });
    const { base, port, room, topic } = await boot();
    const cookie = await signIn(base);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const first = await openStream(port, topic, cookie);
    await first.next();
    room.post(topic, { own: false, html: '<p>seen</p>' }, 'seen');
    const id = /id: (\S+)/.exec(await first.next())?.[1] ?? '';
    first.close();
    await until(() => room.watchers === 0, 'the first stream leaves');

    const phone = await stalled(port, topic, cookie, { gzip: true, lastEventId: id });
    await until(() => room.watchers === 1, 'the stalled stream attaches');
    // Far more than a loopback socket's buffers take, so most of it is held here.
    await flood(room, topic, 80, 'missed');
    // Behind, but not for long yet: a slow link draining a big sync looks like this too.
    expect(room.watchers).toBe(1);
    expect(phone.closed()).toBe(false);

    vi.setSystemTime(Date.now() + 61_000);
    room.post(topic, { own: false, html: '<p>the last word</p>' }, 'the last word');
    await until(() => room.watchers === 0, 'the stalled stream is cut');
    // A paused socket hears the hang-up once it reads again, as a frozen page does when it thaws.
    phone.socket.resume();
    await until(() => phone.closed(), 'the client sees the connection end');
    expect(warn.mock.calls.flat().join('\n')).toMatch(/cutting an event stream [\d.]+ MB behind for 61s/);

    // EventSource reconnects with the last id it received; the backlog still reaches it, so the
    // page is handed exactly what it missed, the cut write included.
    const back = await openStream(port, topic, cookie, id);
    const missed = new Set<string>();
    let synced = false;
    let tail = '';
    // Chunk by chunk, carrying a tail across the boundary, since this is ~20 MB of text.
    for (;;) {
      const text = tail + (await back.next());
      for (const m of text.matchAll(/missed-\d+ /g)) missed.add(m[0]);
      synced ||= text.includes('"t":"sync"');
      if (text.includes('the last word')) break;
      tail = text.slice(-32);
    }
    expect(synced).toBe(false);
    expect(missed.size).toBe(80);
    back.close();
  });

  it('keeps a stream that falls behind and then catches up', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { base, port, room, topic } = await boot();
    const cookie = await signIn(base);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const slow = await stalled(port, topic, cookie, { gzip: false });
    await flood(room, topic, 80, 'burst');
    vi.setSystemTime(Date.now() + 30_000);
    room.post(topic, { own: false, html: '<p>still here</p>' }, 'still here');
    expect(room.watchers).toBe(1);

    // The link comes back and the backlog drains; being behind once is not held against it.
    slow.socket.resume();
    await until(() => slow.read().includes('still here'), 'the backlog drains');
    vi.setSystemTime(Date.now() + 61_000);
    room.post(topic, { own: false, html: '<p>and later</p>' }, 'and later');
    await until(() => slow.read().includes('and later'), 'the next event arrives');
    expect(room.watchers).toBe(1);
    expect(slow.closed()).toBe(false);
    slow.socket.destroy();
  });

  it('delivers a retried send once', async () => {
    const { base, room, topic } = await boot();
    const cookie = await signIn(base);
    const heard: string[] = [];
    room.onMessage((m) => heard.push(m.content));
    const body = JSON.stringify({ topic, text: 'only once', nonce: 'n-1' });
    const a = await fetch(`${base}/api/send`, { method: 'POST', headers: { ...JSON_HEADERS, cookie }, body });
    const b = await fetch(`${base}/api/send`, { method: 'POST', headers: { ...JSON_HEADERS, cookie }, body });
    // The retry is answered as if it were the original, because for the caller it is.
    expect([a.status, b.status]).toEqual([202, 202]);
    expect(heard).toEqual(['only once']);
  });
});

describe('webui server: a send that carries its files as bytes', () => {
  /** What page.ts `framed` sends: a 4-byte length, the JSON header, the files' bytes. */
  const frame = (header: unknown, ...files: Buffer[]): Uint8Array<ArrayBuffer> => {
    const head = Buffer.from(JSON.stringify(header), 'utf8');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(head.length);
    return new Uint8Array(Buffer.concat([len, head, ...files]));
  };
  const OCTETS = { 'content-type': 'application/octet-stream' };

  it('takes the files as bytes and hands the daemon what the JSON form would have', async () => {
    const { base, room, topic } = await boot();
    const cookie = await signIn(base);
    const heard: Array<{ text: string; files: Array<{ name?: string; url: string; mime?: string }> }> = [];
    room.onMessage((m) => heard.push({ text: m.content, files: m.attachments ?? [] }));
    const png = Buffer.from([137, 80, 78, 71, 0, 255, 10]);
    const notes = Buffer.from('first line\nsecond — line\n', 'utf8');
    const body = frame(
      {
        topic,
        text: 'two files — ✓',
        nonce: 'bin-1',
        files: [
          { name: 'shot.png', mime: 'image/png', size: png.length },
          { name: 'notes.txt', mime: 'text/plain', size: notes.length },
        ],
      },
      png,
      notes
    );
    const res = await fetch(`${base}/api/send`, { method: 'POST', headers: { ...OCTETS, cookie }, body });
    expect(res.status).toBe(202);
    expect(heard).toHaveLength(1);
    expect(heard[0]!.text).toBe('two files — ✓');
    expect(heard[0]!.files.map((f) => [f.name, f.mime, f.url])).toEqual([
      ['shot.png', 'image/png', `data:image/png;base64,${png.toString('base64')}`],
      ['notes.txt', 'text/plain', `data:text/plain;base64,${notes.toString('base64')}`],
    ]);
    // The same nonce as JSON is the same message: a retry in either form is answered, not repeated.
    const again = await fetch(`${base}/api/send`, {
      method: 'POST',
      headers: { ...JSON_HEADERS, cookie },
      body: JSON.stringify({ topic, text: 'two files — ✓', nonce: 'bin-1' }),
    });
    expect(again.status).toBe(202);
    expect(heard).toHaveLength(1);
  });

  it('refuses framing that does not add up, and says why', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { base, topic } = await boot();
    const cookie = await signIn(base);
    const post = (body: Uint8Array<ArrayBuffer>): Promise<Response> =>
      fetch(`${base}/api/send`, { method: 'POST', headers: { ...OCTETS, cookie }, body });
    const file = Buffer.from('abcdef');
    const header = { topic, text: 'x', files: [{ name: 'a.bin', mime: '', size: file.length }] };
    // A byte too many, a byte too few, a header longer than the body, no header at all.
    for (const body of [
      frame(header, file, Buffer.from('!')),
      frame(header, file.subarray(1)),
      new Uint8Array([0, 0, 1, 0, 123, 125]),
      new Uint8Array([0, 0]),
    ]) {
      expect((await post(body)).status).toBe(400);
    }
    // A header the JSON form would refuse is refused here too: an extra key, and no files at all.
    expect((await post(frame({ ...header, extra: 1 }, file))).status).toBe(400);
    expect((await post(frame({ topic, text: 'x', files: [] })))).toMatchObject({ status: 400 });
    expect(warn.mock.calls.flat().join('\n')).toMatch(/POST \/api\/send: refused — .*do not add up/);
  });

  it('keeps the JSON form’s limits: the body cap, and the topic and name rules', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { base, topic } = await boot();
    const cookie = await signIn(base);
    const big = Buffer.alloc(37 * 1024 * 1024);
    const over = await fetch(`${base}/api/send`, {
      method: 'POST',
      headers: { ...OCTETS, cookie },
      body: frame({ topic, text: '', files: [{ name: 'big.bin', mime: '', size: big.length }] }, big),
    }).catch(() => undefined);
    // The server hangs up on an oversized body mid-send, so the client may see a reset instead.
    if (over) expect(over.status).toBe(413);
    const file = Buffer.from('x');
    const named = await fetch(`${base}/api/send`, {
      method: 'POST',
      headers: { ...OCTETS, cookie },
      body: frame({ topic: 'not-a-topic', text: '', files: [{ name: 'a', mime: '', size: 1 }] }, file),
    });
    expect(named.status).toBe(400);
  });

  it('is a POST like any other: refused from another origin, and without a session', async () => {
    const { base, topic } = await boot();
    const cookie = await signIn(base);
    const body = frame({ topic, text: '', files: [{ name: 'a', mime: '', size: 1 }] }, Buffer.from('x'));
    const cross = await fetch(`${base}/api/send`, {
      method: 'POST',
      headers: { ...OCTETS, cookie, origin: 'https://evil.example' },
      body,
    });
    expect(cross.status).toBe(403);
    const stranger = await fetch(`${base}/api/send`, { method: 'POST', headers: OCTETS, body });
    expect(stranger.status).toBe(401);
    // And a type a form CAN send is still not one this route reads.
    const form = await fetch(`${base}/api/send`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', cookie },
      body,
    });
    expect(form.status).toBe(415);
  });
});

describe('webui server: a send that does not arrive whole', () => {
  /** What the log was told, as one string. */
  const warned = (spy: ReturnType<typeof vi.spyOn>): string => spy.mock.calls.flat().join('\n');

  it('says in the log why a send was refused, which it never used to', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { base, topic } = await boot();
    const cookie = await signIn(base);
    // `files` is not a list: the schema refuses it, and the page is told 400.
    const res = await fetch(`${base}/api/send`, {
      method: 'POST',
      headers: { ...JSON_HEADERS, cookie },
      body: JSON.stringify({ topic, text: 'x', files: 'nope' }),
    });
    expect(res.status).toBe(400);
    expect(warned(warn)).toMatch(/POST \/api\/send: refused — malformed request: files/);
  });

  it('says so when a body is too large, with the length the client declared', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { base, topic } = await boot();
    const cookie = await signIn(base);
    // The server hangs up on an oversized body while it is still being sent, so the client may see
    // either the 413 or a reset. Neither is the point: the line is written before the answer.
    await fetch(`${base}/api/send`, {
      method: 'POST',
      headers: { ...JSON_HEADERS, cookie },
      body: JSON.stringify({ topic, text: 'x'.repeat(37 * 1024 * 1024) }),
    }).catch(() => undefined);
    expect(warned(warn)).toMatch(/POST \/api\/send: refused — the body passed 37748736 bytes \(Content-Length 3\d{7}\)/);
  });

  it('notes a client that hung up mid-body in one line, not as a failed request with a stack', async () => {
    // What a page that timed an upload out and abandoned it looks like from here — and the reason
    // this had to be handled: before, it came out of the route as `request failed` with a stack.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { base, port } = await boot();
    const cookie = await signIn(base);
    const req = http.request({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: '/api/send',
      headers: { ...JSON_HEADERS, cookie, 'content-length': '1000' },
    });
    req.on('error', () => {});
    req.write('{"topic":"');
    await new Promise((r) => setTimeout(r, 50));
    req.destroy();
    await until(() => /hung up/.test(warned(warn)), 'the hang-up is logged');
    expect(warned(warn)).toMatch(/POST \/api\/send: refused — the client hung up after 10 of 1000 bytes/);
    expect(error).not.toHaveBeenCalled();
  });

  it('leaves the login route out of it, since a stranger can reach that one', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { base } = await boot();
    const res = await fetch(`${base}/api/login`, { method: 'POST', headers: JSON_HEADERS, body: '{not json' });
    expect(res.status).toBe(400);
    expect(warned(warn)).not.toContain('refused');
  });
});

describe('webui server: traffic', () => {
  it('delivers a posted message to the room', async () => {
    const { base, room, topic } = await boot();
    const cookie = await signIn(base);
    const heard: string[] = [];
    room.onMessage((m) => heard.push(m.content));
    const sent = await fetch(`${base}/api/send`, {
      method: 'POST',
      headers: { ...JSON_HEADERS, cookie },
      body: JSON.stringify({ topic, text: 'hi there' }),
    });
    expect(sent.status).toBe(202);
    expect(heard).toEqual(['hi there']);
  });

  it('refuses a click on a message the room no longer holds', async () => {
    const { base, topic } = await boot();
    const cookie = await signIn(base);
    const res = await fetch(`${base}/api/click`, {
      method: 'POST',
      headers: { ...JSON_HEADERS, cookie },
      body: JSON.stringify({ topic, messageId: 'gone', buttonId: 'ask:r:0' }),
    });
    expect(res.status).toBe(409);
  });

  it('serves a published file as an attachment that can never execute on this origin', async () => {
    const { base, room } = await boot();
    const cookie = await signIn(base);
    // An agent that sent an .html would otherwise get it rendered same-origin, holding this
    // session's cookie — so the type is always octet-stream and the disposition always
    // attachment, whatever the file actually is.
    const url = room.publish(new URL(import.meta.url).pathname, 'evil.html');
    const res = await fetch(`${base}/${url}`, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('content-disposition')).toContain('attachment');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('serves a raster image as itself, so the page can show it', async () => {
    const { base, room } = await boot();
    const cookie = await signIn(base);
    const url = room.publish(new URL(import.meta.url).pathname, 'shot.png');
    const res = await fetch(`${base}/${url}`, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('content-disposition')).toContain('inline');
    // The inline exception rests entirely on this: a file merely NAMED .png is pinned to the
    // type we declared, so a document cannot be sniffed back out of one.
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toContain('sandbox');
  });

  it('serves an operator\'s own picture once its write has finished, not a 404 before it', async () => {
    const { base, room } = await boot();
    const cookie = await signIn(base);
    // The echo that names this URL reaches the page as the write starts; the request for it can
    // arrive first. Here the file does not exist until `ready` settles.
    const file = path.join(os.tmpdir(), `webui-upload-${process.pid}-${Date.now()}.png`);
    let finish: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      finish = () => {
        fs.writeFileSync(file, 'png bytes');
        resolve();
      };
    });
    const url = room.publish(file, 'pasted-1.png', { ready });
    const pending = fetch(`${base}/${url}`, { headers: { cookie } });
    setTimeout(finish, 50);
    const res = await pending;
    try {
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/png');
      expect(await res.text()).toBe('png bytes');
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  it('serves a file the agent sent after the path it was sent from is gone', async () => {
    // A remote agent's send-file: the daemon fetches the file into a temporary one, hands it to
    // sendFile, and removes it the moment that returns. Before the copy, the click that came after
    // got a 404 JSON body, which a `download` link saves as `<token>.json`.
    const { base, room } = await boot();
    const cookie = await signIn(base);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetherd-file-'));
    const kept = fs.mkdtempSync(path.join(os.tmpdir(), 'webui-kept-'));
    try {
      room.useUploads(diskUploadStore(kept));
      const source = path.join(tmp, 'pushme-0.1.1.apk');
      fs.writeFileSync(source, 'apk bytes');
      const url = await room.publishCopy(source, 'pushme-0.1.1.apk');
      fs.rmSync(tmp, { recursive: true, force: true });
      const res = await fetch(`${base}/${url}`, { headers: { cookie } });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/octet-stream');
      expect(res.headers.get('content-disposition')).toContain('filename="pushme-0.1.1.apk"');
      expect(await res.text()).toBe('apk bytes');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.rmSync(kept, { recursive: true, force: true });
    }
  });

  it.each([
    ['an .svg, which is XML a browser runs', 'diagram.svg'],
    ['a .pdf, which browsers render and which scripts', 'report.pdf'],
    ['an extensionless name', 'screenshot'],
    ['a name whose extension only looks like one', 'notes.png.html'],
  ])('keeps %s a download', async (_label, name) => {
    const { base, room } = await boot();
    const cookie = await signIn(base);
    const url = room.publish(new URL(import.meta.url).pathname, name);
    const res = await fetch(`${base}/${url}`, { headers: { cookie } });
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('content-disposition')).toContain('attachment');
  });

  it.each([
    ['an unknown token', 'f/deadbeef'],
    ['a path instead of a token', 'f/..%2F..%2Fetc%2Fpasswd'],
  ])('answers 404 for %s', async (_label, p) => {
    const { base } = await boot();
    const cookie = await signIn(base);
    expect((await fetch(`${base}/${p}`, { headers: { cookie } })).status).toBe(404);
  });

  describe('the reader', () => {
    /** A file the agent sent, with these bytes and this name, published the way `sendFile` does. */
    async function sent(name: string, bytes: string | Buffer) {
      const { base, room } = await boot();
      const cookie = await signIn(base);
      // Under the per-test directory, which afterEach removes.
      const file = path.join(dir, `source-${name}`);
      fs.writeFileSync(file, bytes);
      const url = room.publish(file, name);
      return { base, cookie, room, url, view: room.viewUrl(url) };
    }

    it('renders a markdown file to HTML under the download token', async () => {
      const { base, cookie, url, view } = await sent('plan.md', '# Plan\n\nship **it**\n');
      expect(view).toBe(url.replace('f/', 'view/'));
      const res = await fetch(`${base}/${view}`, { headers: { cookie } });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
      expect(await res.json()).toEqual({
        name: 'plan.md',
        size: 20,
        shown: 20,
        html: '<h1>Plan</h1><p>ship <strong>it</strong></p>',
      });
    });

    it('hands over an .html as escaped source — never as a document of its own', async () => {
      // The download rule exists so an agent's .html cannot run on this origin. The reader goes
      // round that rule only because the browser never receives the file, only text built from it.
      const { base, cookie, view } = await sent('evil.html', '<script>steal()</script>');
      const res = await fetch(`${base}/${view}`, { headers: { cookie } });
      expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
      const body = (await res.json()) as { html: string };
      expect(body.html).toBe('<pre class="src"><code>&lt;script&gt;steal()&lt;/script&gt;</code></pre>');
    });

    it('sends the head of a file too long to show whole, and says how long it was', async () => {
      const line = 'a log line\n';
      const big = line.repeat(Math.ceil((MAX_READ_BYTES * 2) / line.length));
      const { base, cookie, view } = await sent('run.log', big);
      const body = (await (await fetch(`${base}/${view}`, { headers: { cookie } })).json()) as {
        size: number;
        shown: number;
      };
      expect(body.size).toBe(big.length);
      expect(body.shown).toBeLessThanOrEqual(MAX_READ_BYTES);
      expect(body.shown % line.length).toBe(0);
    });

    it('refuses a name it does not render, and bytes that are not text', async () => {
      const pdf = await sent('report.pdf', '%PDF-1.7');
      expect((await fetch(`${pdf.base}/${pdf.view}`, { headers: { cookie: pdf.cookie } })).status).toBe(415);
      const named = await sent('notes.txt', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00]));
      const res = await fetch(`${named.base}/${named.view}`, { headers: { cookie: named.cookie } });
      expect(res.status).toBe(415);
      expect(await res.json()).toEqual({ error: 'that file is not text' });
    });

    it('answers 404 for a token it never minted, and for a file gone from disk', async () => {
      const { base, cookie, room } = await sent('plan.md', 'x');
      expect((await fetch(`${base}/view/deadbeef`, { headers: { cookie } })).status).toBe(404);
      const url = room.publish(path.join(dir, 'never-written.md'), 'gone.md');
      expect((await fetch(`${base}/${room.viewUrl(url)}`, { headers: { cookie } })).status).toBe(404);
    });

    it('is behind the session like the download it renders', async () => {
      const { base, view } = await sent('plan.md', '# Plan\n');
      expect((await fetch(`${base}/${view}`)).status).toBe(401);
    });
  });

  describe('closing idle agents', () => {
    it('ends the listed idle topics through the daemon and answers which', async () => {
      const { base, room, topic } = await boot();
      const cookie = await signIn(base);
      const asked: string[] = [];
      room.useIdleReclaim((ref) => {
        asked.push(ref.thread ?? '');
        return true;
      });
      const res = await fetch(`${base}/api/topics/close-idle`, {
        method: 'POST',
        headers: { ...JSON_HEADERS, cookie },
        body: JSON.stringify({ topics: [topic] }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ closed: [topic], kept: [] });
      expect(asked).toEqual([topic]);
    });

    it.each([
      ['no topics at all', { topics: [] }],
      ['an id that is not a topic id', { topics: ['../etc'] }],
      ['a field it does not take', { topics: ['a1b2c3d4'], all: true }],
    ])('refuses %s', async (_label, body) => {
      const { base, room } = await boot();
      const cookie = await signIn(base);
      let asked = 0;
      room.useIdleReclaim(() => {
        asked += 1;
        return true;
      });
      const res = await fetch(`${base}/api/topics/close-idle`, {
        method: 'POST',
        headers: { ...JSON_HEADERS, cookie },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
      expect(asked).toBe(0);
    });

    it('is behind the session, and refuses another origin', async () => {
      const { base, topic } = await boot();
      const body = JSON.stringify({ topics: [topic] });
      expect((await fetch(`${base}/api/topics/close-idle`, { method: 'POST', headers: JSON_HEADERS, body })).status).toBe(401);
      const cookie = await signIn(base);
      const res = await fetch(`${base}/api/topics/close-idle`, {
        method: 'POST',
        headers: { ...JSON_HEADERS, cookie, origin: 'https://evil.example' },
        body,
      });
      expect(res.status).toBe(403);
    });
  });

  describe('ending a topic and the topics under it', () => {
    it('ends through the daemon and answers each topic it walked', async () => {
      const { base, room, topic } = await boot();
      const cookie = await signIn(base);
      const asked: Array<string | number> = [];
      room.useTopicKill((ref, confirmed) => {
        asked.push(ref.thread ?? '', confirmed.size);
        return [
          { topic: ref.thread ?? '', outcome: 'ended' },
          { topic: 'b2c3d4e5', outcome: 'no-child' },
        ];
      });
      const res = await fetch(`${base}/api/topics/kill`, {
        method: 'POST',
        headers: { ...JSON_HEADERS, cookie },
        body: JSON.stringify({ topic, topics: [topic] }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        results: [
          { topic, outcome: 'ended' },
          { topic: 'b2c3d4e5', outcome: 'no-child' },
        ],
      });
      expect(asked).toEqual([topic, 1]);
    });

    it.each([
      ['an id that is not a topic id', { topic: '../etc', topics: ['a1b2c3d4'] }],
      ['a field it does not take', { topic: 'a1b2c3d4', topics: ['a1b2c3d4'], all: true }],
      ['no topic at all', { topics: ['a1b2c3d4'] }],
      ['no confirmed list', { topic: 'a1b2c3d4' }],
      ['an empty confirmed list', { topic: 'a1b2c3d4', topics: [] }],
    ])('refuses %s', async (_label, body) => {
      const { base, room } = await boot();
      const cookie = await signIn(base);
      let asked = 0;
      room.useTopicKill(() => {
        asked += 1;
        return [];
      });
      const res = await fetch(`${base}/api/topics/kill`, {
        method: 'POST',
        headers: { ...JSON_HEADERS, cookie },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
      expect(asked).toBe(0);
    });

    it('is behind the session, and refuses another origin', async () => {
      const { base, topic } = await boot();
      const body = JSON.stringify({ topic, topics: [topic] });
      expect((await fetch(`${base}/api/topics/kill`, { method: 'POST', headers: JSON_HEADERS, body })).status).toBe(401);
      const cookie = await signIn(base);
      const res = await fetch(`${base}/api/topics/kill`, {
        method: 'POST',
        headers: { ...JSON_HEADERS, cookie, origin: 'https://evil.example' },
        body,
      });
      expect(res.status).toBe(403);
    });
  });

  describe('scheduled tasks', () => {
    const task: SchedulePanelTask = {
      id: 'a1b2c3',
      name: 'Morning CI',
      tags: ['ci'],
      createdAt: Date.UTC(2026, 10, 1, 0, 0, 0),
      state: 'active',
      when: '0 8 * * * (Asia/Shanghai)',
      next: '2026-11-05 08:00',
      nextAt: Date.UTC(2026, 10, 5, 0, 0, 0),
      run: 'cc · fixed session',
      target: 'web:main#a1b2c3d4',
      targetTopic: 'a1b2c3d4',
      runs: 2,
      running: false,
      detail: 'summarise the failures',
      kind: 'agent',
    };
    const FORM: SchedulePanelFormContext = {
      agents: ['cc'],
      agentHosts: {},
      hosts: ['box'],
      channels: [{ id: 'tg:-100/7', title: 'ops chat' }],
      shapes: { bash: ['cwd', 'host', 'timeout', 'at'], fixed: ['agent', 'at'], new: ['agent', 'model', 'cwd', 'at'], daily: ['agent', 'model', 'cwd'] },
      tz: 'Asia/Shanghai',
      agent: 'cc',
    };
    const NO_DETAIL: Pick<SchedulePanel, 'detail' | 'edit' | 'add' | 'form'> = {
      detail: () => undefined,
      edit: async () => ({ ok: false, error: 'not in this test' }),
      add: async () => ({ ok: false, error: 'not in this test' }),
      form: () => FORM,
    };
    const page: SchedulePanelTaskDetail = {
      ...FORM,
      task,
      fields: { name: 'Morning CI', cron: '0 8 * * *', tz: 'Asia/Shanghai', prompt: 'summarise the failures', agent: 'cc', session: 'fixed', target: 'webui:main/a1b2c3d4' },
      runs: [{ at: 1, atText: '2026-11-04 08:00', status: 'ok', topic: 'a1b2c3d4' }],
    };

    it('lists what the daemon handed the room, and says when it offered none', async () => {
      const { base, room } = await boot();
      const cookie = await signIn(base);
      expect(await (await fetch(`${base}/api/schedules`, { headers: { cookie } })).json()).toEqual({
        enabled: false,
        tasks: [],
      });

      room.useSchedulePanel({ ...NO_DETAIL, list: () => [task], op: () => ({ ok: true, tasks: [task] }) });
      const res = await fetch(`${base}/api/schedules`, { headers: { cookie } });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ enabled: true, tasks: [task] });
    });

    it('carries out one action and answers with the fresh list', async () => {
      const { base, room } = await boot();
      const cookie = await signIn(base);
      const calls: string[] = [];
      const paused: SchedulePanelTask = { ...task, state: 'paused' };
      room.useSchedulePanel({
        ...NO_DETAIL,
        list: () => [task],
        op: (id, action) => {
          calls.push(`${id}:${action}`);
          return { ok: true, tasks: [paused] };
        },
      });

      const res = await fetch(`${base}/api/schedules/op`, {
        method: 'POST',
        headers: { ...JSON_HEADERS, cookie },
        body: JSON.stringify({ id: 'a1b2c3', action: 'pause' }),
      });
      expect(res.status).toBe(200);
      expect(calls).toEqual(['a1b2c3:pause']);
      expect(await res.json()).toEqual({ ok: true, tasks: [paused] });
    });

    it('carries a whole tag set through to the daemon, and requires it for the tags action', async () => {
      const { base, room } = await boot();
      const cookie = await signIn(base);
      const calls: Array<{ id: string; action: string; tags?: string[] }> = [];
      room.useSchedulePanel({
        ...NO_DETAIL,
        list: () => [task],
        op: (id, action, tags) => {
          calls.push({ id, action, ...(tags !== undefined ? { tags } : {}) });
          return { ok: true, tasks: [{ ...task, tags: ['ops', 'ci'] }] };
        },
      });

      const res = await fetch(`${base}/api/schedules/op`, {
        method: 'POST',
        headers: { ...JSON_HEADERS, cookie },
        body: JSON.stringify({ id: 'a1b2c3', action: 'tags', tags: ['ops', 'ci'] }),
      });
      expect(res.status).toBe(200);
      expect(calls).toEqual([{ id: 'a1b2c3', action: 'tags', tags: ['ops', 'ci'] }]);
      expect((await res.json()).tasks[0].tags).toEqual(['ops', 'ci']);

      const missing = await fetch(`${base}/api/schedules/op`, {
        method: 'POST',
        headers: { ...JSON_HEADERS, cookie },
        body: JSON.stringify({ id: 'a1b2c3', action: 'tags' }),
      });
      expect(missing.status).toBe(400);
      expect(calls).toHaveLength(1);
    });

    it('hands back the service refusal, and refuses a body the page could not have sent', async () => {
      const { base, room } = await boot();
      const cookie = await signIn(base);
      let called = 0;
      room.useSchedulePanel({
        ...NO_DETAIL,
        list: () => [task],
        op: () => {
          called += 1;
          return { ok: false, error: '#a1b2c3 is already paused' };
        },
      });

      const refused = await fetch(`${base}/api/schedules/op`, {
        method: 'POST',
        headers: { ...JSON_HEADERS, cookie },
        body: JSON.stringify({ id: 'a1b2c3', action: 'pause' }),
      });
      expect(refused.status).toBe(400);
      expect(await refused.json()).toEqual({ ok: false, error: '#a1b2c3 is already paused' });

      const malformed = await fetch(`${base}/api/schedules/op`, {
        method: 'POST',
        headers: { ...JSON_HEADERS, cookie },
        body: JSON.stringify({ id: 'a1b2c3', action: 'rm -rf /' }),
      });
      expect(malformed.status).toBe(400);
      expect(called).toBe(1);
    });

    it("answers a task's page by id, 404 for a task that is not there, 400 for an id the store cannot hold", async () => {
      const { base, room } = await boot();
      const cookie = await signIn(base);
      room.useSchedulePanel({ ...NO_DETAIL, list: () => [task], op: () => ({ ok: true, tasks: [task] }), detail: (id) => (id === 'a1b2c3' ? page : undefined) });

      const res = await fetch(`${base}/api/schedules/task?id=a1b2c3`, { headers: { cookie } });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, detail: page });
      const gone = await fetch(`${base}/api/schedules/task?id=ffff00`, { headers: { cookie } });
      expect(gone.status).toBe(404);
      expect(await gone.json()).toEqual({ ok: false, error: 'no scheduled task #ffff00' });
      expect((await fetch(`${base}/api/schedules/task?id=../x`, { headers: { cookie } })).status).toBe(400);
    });

    it('carries an edit through as the fields the page sent, and hands back the refusal in the service words', async () => {
      const { base, room } = await boot();
      const cookie = await signIn(base);
      const calls: Array<{ id: string; edit: SchedulePanelEdit }> = [];
      let refuse = false;
      room.useSchedulePanel({
        ...NO_DETAIL,
        list: () => [task],
        op: () => ({ ok: true, tasks: [task] }),
        edit: async (id, edit) => {
          calls.push({ id, edit });
          return refuse ? { ok: false, error: '--cron: invalid' } : { ok: true, detail: page, tasks: [task] };
        },
      });
      const post = (body: unknown): Promise<Response> =>
        fetch(`${base}/api/schedules/edit`, { method: 'POST', headers: { ...JSON_HEADERS, cookie }, body: JSON.stringify(body) });

      const res = await post({ id: 'a1b2c3', edit: { prompt: 'new text', cwd: null } });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, detail: page, tasks: [task] });
      expect(calls).toEqual([{ id: 'a1b2c3', edit: { prompt: 'new text', cwd: null } }]);

      refuse = true;
      const refused = await post({ id: 'a1b2c3', edit: { cron: 'nope' } });
      expect(refused.status).toBe(400);
      expect(await refused.json()).toEqual({ ok: false, error: '--cron: invalid' });

      // What a task is, its session, its machine and where it posts travel too; a target naming a
      // place elsewhere goes as its id, for the daemon to read the way --channel is read.
      refuse = false;
      const moved = await post({ id: 'a1b2c3', edit: { command: 'df -h', host: null, session: 'new', target: { channel: 'tg:-100/7' }, tags: ['ci'] } });
      expect(moved.status).toBe(200);
      expect(calls.at(-1)).toEqual({ id: 'a1b2c3', edit: { command: 'df -h', host: null, session: 'new', target: 'tg:-100/7', tags: ['ci'] } });

      // Nothing the form cannot send reaches the daemon: an empty edit, a field it has no input
      // for, a session that is not one, a target of neither shape, a wrong type.
      for (const bad of [
        { id: 'a1b2c3', edit: {} },
        { id: 'a1b2c3', edit: { kind: 'bash' } },
        { id: 'a1b2c3', edit: { session: 'forever' } },
        { id: 'a1b2c3', edit: { target: 'tg:-100/7' } },
        { id: 'a1b2c3', edit: { target: { topic: '../x' } } },
        { id: 'a1b2c3', edit: { timeoutMs: '10m' } },
        { id: 'a1b2c3', edit: { name: 'x' }, extra: 1 },
      ]) {
        expect((await post(bad)).status).toBe(400);
      }
      expect(calls).toHaveLength(3);
    });

    it('offers the new-task form, and carries a new task through with its target, or the refusal in add\'s words', async () => {
      const { base, room } = await boot();
      const cookie = await signIn(base);
      expect((await fetch(`${base}/api/schedules/form`, { headers: { cookie } })).status).toBe(404);
      const adds: unknown[] = [];
      let refuse = false;
      room.useSchedulePanel({
        ...NO_DETAIL,
        list: () => [task],
        op: () => ({ ok: true, tasks: [task] }),
        add: async (input) => {
          adds.push(input);
          return refuse ? { ok: false, error: 'give exactly one of --cron <expr> or --at <time>' } : { ok: true, detail: page, tasks: [task] };
        },
      });
      const form = await fetch(`${base}/api/schedules/form`, { headers: { cookie } });
      expect(form.status).toBe(200);
      expect(await form.json()).toEqual({ ok: true, form: FORM });

      const post = (body: unknown): Promise<Response> =>
        fetch(`${base}/api/schedules/add`, { method: 'POST', headers: { ...JSON_HEADERS, cookie }, body: JSON.stringify(body) });
      const ok = await post({ task: { cron: '0 8 * * *', prompt: 'brief me', session: 'new', target: { channel: 'tg:-100/7' } } });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ ok: true, detail: page, tasks: [task] });
      expect(adds).toEqual([{ cron: '0 8 * * *', prompt: 'brief me', session: 'new', target: 'tg:-100/7' }]);

      refuse = true;
      const refused = await post({ task: { prompt: 'x', target: { channel: 'tg:-100/7' } } });
      expect(refused.status).toBe(400);
      expect(await refused.json()).toEqual({ ok: false, error: 'give exactly one of --cron <expr> or --at <time>' });
      // A topic the page does not have is refused by the room, before the daemon is asked; a body
      // with no target, or with a field the form has no input for, never reaches either.
      const lost = await post({ task: { prompt: 'x', cron: '0 8 * * *', target: { topic: 'ffffffff' } } });
      expect(lost.status).toBe(400);
      expect((await post({ task: { prompt: 'x', cron: '0 8 * * *' } })).status).toBe(400);
      expect((await post({ task: { prompt: 'x', target: { channel: 'tg:1' }, id: 'zz' } })).status).toBe(400);
      expect(adds).toHaveLength(2);
    });

    it('is behind the session like every other route', async () => {
      const { base } = await boot();
      expect((await fetch(`${base}/api/schedules`)).status).toBe(401);
      expect((await fetch(`${base}/api/schedules/task?id=a1b2c3`)).status).toBe(401);
      const edit = await fetch(`${base}/api/schedules/edit`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ id: 'a1b2c3', edit: { name: 'x' } }),
      });
      expect(edit.status).toBe(401);
      expect((await fetch(`${base}/api/schedules/form`)).status).toBe(401);
      const add = await fetch(`${base}/api/schedules/add`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ task: { prompt: 'x', cron: '0 8 * * *', target: { channel: 'tg:1' } } }),
      });
      expect(add.status).toBe(401);
      const res = await fetch(`${base}/api/schedules/op`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ id: 'a1b2c3', action: 'pause' }),
      });
      expect(res.status).toBe(401);
    });
  });

  describe('skills', () => {
    const skill: SkillPanelEntry = {
      name: 'deploy-check',
      description: 'Use when checking a deployment',
      version: '0123456789ab',
      status: 'active',
      pinned: false,
      resident: false,
      createdAt: '2026-11-01T00:00:00.000Z',
      uses: 3,
      agents: ['cc'],
    };

    it('lists what the daemon handed the room, and says when it offered none', async () => {
      const { base, room } = await boot();
      const cookie = await signIn(base);
      expect(await (await fetch(`${base}/api/skills`, { headers: { cookie } })).json()).toEqual({
        enabled: false,
        skills: [],
      });

      room.useSkillsPanel({ list: () => [skill], op: async () => ({ ok: true, skills: [skill] }) });
      const res = await fetch(`${base}/api/skills`, { headers: { cookie } });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ enabled: true, skills: [skill] });
    });

    it('carries out one operation and answers with the fresh list', async () => {
      const { base, room } = await boot();
      const cookie = await signIn(base);
      const calls: string[] = [];
      room.useSkillsPanel({
        list: () => [skill],
        op: async (op) => {
          calls.push(op.action);
          return { ok: true, skills: [{ ...skill, pinned: true }] };
        },
      });

      const res = await fetch(`${base}/api/skills/op`, {
        method: 'POST',
        headers: { ...JSON_HEADERS, cookie },
        body: JSON.stringify({ action: 'pin', name: 'deploy-check', pinned: true }),
      });
      expect(res.status).toBe(200);
      expect(calls).toEqual(['pin']);
      expect(await res.json()).toEqual({ ok: true, skills: [{ ...skill, pinned: true }] });
    });

    it('hands back the store refusal, and refuses a body the page could not have sent', async () => {
      const { base, room } = await boot();
      const cookie = await signIn(base);
      let called = 0;
      room.useSkillsPanel({
        list: () => [skill],
        op: async () => {
          called += 1;
          return { ok: false, error: 'version mismatch: "deploy-check" is at aabbccddeeff, not 0123456789ab.' };
        },
      });

      const refused = await fetch(`${base}/api/skills/op`, {
        method: 'POST',
        headers: { ...JSON_HEADERS, cookie },
        body: JSON.stringify({ action: 'patch', name: 'deploy-check', version: '0123456789ab', content: 'x' }),
      });
      expect(refused.status).toBe(400);
      expect(await refused.json()).toEqual({
        ok: false,
        error: 'version mismatch: "deploy-check" is at aabbccddeeff, not 0123456789ab.',
      });

      for (const body of [
        { action: 'delete', name: 'deploy-check' },
        { action: 'archive', name: 'deploy-check', force: true },
        { action: 'show', name: '../etc/passwd' },
      ]) {
        const malformed = await fetch(`${base}/api/skills/op`, {
          method: 'POST',
          headers: { ...JSON_HEADERS, cookie },
          body: JSON.stringify(body),
        });
        expect(malformed.status, JSON.stringify(body)).toBe(400);
      }
      expect(called).toBe(1);
    });

    it('takes a commit id for a revert, and refuses anything else', async () => {
      const { base, room } = await boot();
      const cookie = await signIn(base);
      const ids: string[] = [];
      room.useSkillsPanel({
        list: () => [skill],
        op: async (op) => {
          if (op.action === 'revert') ids.push(op.id);
          return { ok: true, skills: [skill] };
        },
      });
      const post = (id: string): Promise<Response> =>
        fetch(`${base}/api/skills/op`, {
          method: 'POST',
          headers: { ...JSON_HEADERS, cookie },
          body: JSON.stringify({ action: 'revert', name: 'deploy-check', id }),
        });

      // A history entry is a commit: 12 hex as `history` prints it, or any length git takes.
      expect((await post('a5388a00a83d')).status).toBe(200);
      expect((await post('a5388a00a83d5f1e2c3b4a5968778695a4b3c2d1')).status).toBe(200);
      for (const bad of ['000000000000172-abc123', 'HEAD~1', 'a538', '--all']) expect((await post(bad)).status, bad).toBe(400);
      expect(ids).toEqual(['a5388a00a83d', 'a5388a00a83d5f1e2c3b4a5968778695a4b3c2d1']);
    });

    it('is behind the session like every other route', async () => {
      const { base } = await boot();
      expect((await fetch(`${base}/api/skills`)).status).toBe(401);
      const res = await fetch(`${base}/api/skills/op`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ action: 'archive', name: 'deploy-check' }),
      });
      expect(res.status).toBe(401);
    });
  });

  describe('reviews', () => {
    const review: ReviewPanelEntry = {
      id: 'review:web#main#a1b2c3d4:1762300000000',
      title: 'Right sidebar',
      at: 1762300000000,
      outcome: 'changed',
      summary: 'updated deploy-check',
      changes: [
        {
          action: 'patch',
          name: 'deploy-check',
          reason: 'two runs forgot the tests',
          applied: true,
          undo: 'fleetherd skills revert deploy-check 0001-abc',
        },
      ],
      preferences: ['answers lead with the conclusion'],
      invalid: [],
      topic: 'a1b2c3d4',
    };
    const pending = [{ text: 'answers lead with the conclusion', count: 2, at: Date.UTC(2026, 10, 5, 12, 0), from: [{ title: 'deploy' }] }];
    const list = { enabled: true, running: true, reviews: [review], pending };

    it('lists what the daemon handed the room, and says when it offered none', async () => {
      const { base, room } = await boot();
      const cookie = await signIn(base);
      expect(await (await fetch(`${base}/api/reviews`, { headers: { cookie } })).json()).toEqual({
        enabled: false,
        running: false,
        reviews: [],
        pending: [],
      });

      room.useReviewPanel({ list: () => list, dismiss: () => list });
      const res = await fetch(`${base}/api/reviews`, { headers: { cookie } });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(list);
    });

    it('has no write side beside dismissing a suggestion: a review cannot be started or changed', async () => {
      const { base, room } = await boot();
      const cookie = await signIn(base);
      room.useReviewPanel({ list: () => list, dismiss: () => list });
      const res = await fetch(`${base}/api/reviews`, {
        method: 'POST',
        headers: { ...JSON_HEADERS, cookie },
        body: JSON.stringify({ action: 'run' }),
      });
      expect(res.status).toBe(404);
      // The op route takes one verb and refuses every other.
      const run = await fetch(`${base}/api/reviews/op`, {
        method: 'POST',
        headers: { ...JSON_HEADERS, cookie },
        body: JSON.stringify({ action: 'run' }),
      });
      expect(run.status).toBe(400);
    });

    it('dismisses a suggestion and answers with the fresh list', async () => {
      const { base, room } = await boot();
      const cookie = await signIn(base);
      const dismissed: string[] = [];
      room.useReviewPanel({
        list: () => list,
        dismiss: (text) => {
          dismissed.push(text);
          return { ...list, pending: [] };
        },
      });
      const res = await fetch(`${base}/api/reviews/op`, {
        method: 'POST',
        headers: { ...JSON_HEADERS, cookie },
        body: JSON.stringify({ action: 'dismiss', text: 'answers lead with the conclusion' }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ pending: [] });
      expect(dismissed).toEqual(['answers lead with the conclusion']);
      expect((await fetch(`${base}/api/reviews/op`, { method: 'POST', headers: JSON_HEADERS, body: '{}' })).status).toBe(401);
    });

    it('is behind the session like every other route', async () => {
      const { base } = await boot();
      expect((await fetch(`${base}/api/reviews`)).status).toBe(401);
    });
  });

  describe('the history page', () => {
    const session = {
      id: 1,
      key: 'webui#main#a1b2c3d4',
      title: 'Deploy notes',
      agent: 'cc',
      platform: 'webui',
      lastAt: 1762300000000,
      messages: 3,
      topic: 'a1b2c3d4',
    };
    const page = { enabled: true, sessions: [session], next: '1762300000000.1' };
    const hit = {
      session: 1,
      message: 4,
      at: 1762300000000,
      title: 'Deploy notes',
      agent: 'cc',
      platform: 'webui',
      role: 'user',
      excerpt: 'the deployment finished',
    };
    const read = { session, messages: [{ id: 1, at: 1762300000000, role: 'user', kind: 'normal', text: 'hello' }], note: 'This conversation has more than 500 messages.' };

    it('lists what the daemon handed the room, and says when it offered none', async () => {
      const { base, room } = await boot();
      const cookie = await signIn(base);
      expect(await (await fetch(`${base}/api/history`, { headers: { cookie } })).json()).toEqual({
        enabled: false,
        sessions: [],
      });

      const asked: Array<{ before?: string; limit?: number }> = [];
      room.useHistoryPanel({
        list: (opts) => {
          asked.push(opts ?? {});
          return page;
        },
        search: () => ({ hits: [hit] }),
        read: () => read,
      });
      const res = await fetch(`${base}/api/history?before=1762300000000.1&limit=20`, { headers: { cookie } });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(page);
      expect(asked).toEqual([{ before: '1762300000000.1', limit: 20 }]);
    });

    it('refuses a cursor or a limit it did not hand out', async () => {
      const { base, room } = await boot();
      const cookie = await signIn(base);
      const asked: unknown[] = [];
      room.useHistoryPanel({ list: (opts) => (asked.push(opts), page), search: () => ({ hits: [] }), read: () => read });
      for (const query of ['before=yesterday', 'before=1.2.3', 'before=-1.2', 'limit=0', 'limit=201', 'limit=abc', 'limit=1.5']) {
        expect((await fetch(`${base}/api/history?${query}`, { headers: { cookie } })).status, query).toBe(400);
      }
      // Nothing malformed reached the store: a bad cursor is refused before it is compared.
      expect(asked).toEqual([]);
    });

    it('searches through the daemon and refuses a query with nothing to look for', async () => {
      const { base, room } = await boot();
      const cookie = await signIn(base);
      const queries: string[] = [];
      room.useHistoryPanel({
        list: () => page,
        search: (q) => {
          queries.push(q);
          return { hits: [hit], more: true };
        },
        read: () => read,
      });
      const res = await fetch(`${base}/api/history/search?q=${encodeURIComponent('deployment')}`, { headers: { cookie } });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ enabled: true, hits: [hit], more: true });
      expect(queries).toEqual(['deployment']);

      for (const query of ['', 'q=', `q=${'x'.repeat(201)}`]) {
        expect((await fetch(`${base}/api/history/search?${query}`, { headers: { cookie } })).status, query).toBe(400);
      }
      expect(queries).toEqual(['deployment']);
    });

    it('answers with the store\'s own sentence when the search cannot be made', async () => {
      const { base, room } = await boot();
      const cookie = await signIn(base);
      room.useHistoryPanel({
        list: () => page,
        search: () => {
          throw new Error('search needs a word to look for');
        },
        read: () => read,
      });
      const res = await fetch(`${base}/api/history/search?q=%21%21`, { headers: { cookie } });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'search needs a word to look for' });
    });

    it('reads one conversation, with the note that says the read was cut short', async () => {
      const { base, room } = await boot();
      const cookie = await signIn(base);
      const ids: number[] = [];
      room.useHistoryPanel({
        list: () => page,
        search: () => ({ hits: [hit] }),
        read: (id) => {
          ids.push(id);
          return read;
        },
      });
      const res = await fetch(`${base}/api/history/read?id=1`, { headers: { cookie } });
      expect(res.status).toBe(200);
      // Drawn as a topic's messages are (room.ts historyMessages), so the page can show it with
      // the transcript's own bubbles.
      expect(await res.json()).toEqual({
        session,
        messages: [{ id: 'h1', own: true, html: '<div class="raw">hello</div>', at: 1762300000000, buttons: [], reactions: [] }],
        note: read.note,
      });
      expect(ids).toEqual([1]);
    });

    it('refuses an id that is not one, and 404s one that names no conversation', async () => {
      const { base, room } = await boot();
      const cookie = await signIn(base);
      room.useHistoryPanel({
        list: () => page,
        search: () => ({ hits: [hit] }),
        read: () => {
          throw new Error('no conversation "99"; `fleetherd sessions list` shows the ids');
        },
      });
      expect((await fetch(`${base}/api/history/read`, { headers: { cookie } })).status).toBe(400);
      expect((await fetch(`${base}/api/history/read?id=abc`, { headers: { cookie } })).status).toBe(400);
      const missing = await fetch(`${base}/api/history/read?id=99`, { headers: { cookie } });
      expect(missing.status).toBe(404);
      expect((await missing.json()).error).toMatch(/no conversation "99"/);
    });

    it('is behind the session like every other route', async () => {
      const { base } = await boot();
      for (const path of ['/api/history', '/api/history/search?q=x', '/api/history/read?id=1']) {
        expect((await fetch(`${base}${path}`)).status, path).toBe(401);
      }
    });
  });
});

describe('webui server: the git window', () => {
  const status = {
    ok: true as const,
    repo: { root: '/srv/project', branch: 'main', base: 'main' },
    files: [{ path: 'src/a.ts', status: 'modified' as const, additions: 3, deletions: 1 }],
  };
  const file = {
    ok: true as const,
    path: 'src/a.ts',
    status: 'modified' as const,
    original: 'a\n',
    modified: 'a\nb\n',
    patch: '@@ -1 +1,2 @@\n a\n+b\n',
  };
  const summary = {
    sha: 'a'.repeat(40),
    short: 'aaaaaaa',
    subject: 'one change',
    author: 'owner',
    at: 1_700_000_000_000,
    parents: 0,
  };
  /** The history half of a panel, for the tests that are not about it. */
  const idleHistory = () => ({
    log: async () => ({ ok: true as const, repo: { root: '/srv/project' }, commits: [], more: false }),
    commit: async () => ({ ok: false as const, reason: 'error' as const, text: 'no' }),
    commitFile: async () => ({ ok: false as const, text: 'no' }),
  });

  it('answers the change list for the mode and base it was asked for', async () => {
    const { base, room, topic } = await boot();
    const cookie = await signIn(base);
    const calls: unknown[] = [];
    room.useGitPanel({
      status: async (ref, mode, base) => {
        calls.push({ ref, mode, base });
        return status;
      },
      file: async () => file,
      branches: async () => ({ ok: true, branch: 'main', base: 'main', branches: ['main'] }),
      ...idleHistory(),
    });

    const res = await fetch(`${base}/api/git/status?t=${topic}&mode=branch&base=origin%2Fmain`, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(status);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ mode: 'branch', base: 'origin/main' });

    const branches = await fetch(`${base}/api/git/branches?t=${topic}`, { headers: { cookie } });
    expect(await branches.json()).toEqual({ ok: true, branch: 'main', base: 'main', branches: ['main'] });
  });

  it('carries one file through with its path, and hands a refusal back as an answer', async () => {
    const { base, room, topic } = await boot();
    const cookie = await signIn(base);
    const calls: Array<{ mode: string; base: string | undefined; path: string }> = [];
    room.useGitPanel({
      status: async () => status,
      file: async (_ref, mode, base, path) => {
        calls.push({ mode, base, path });
        return path === 'src/a.ts' ? file : { ok: false, text: 'That file is not one of the changes shown.' };
      },
      branches: async () => ({ ok: true, branches: [] }),
      ...idleHistory(),
    });

    const ok = await fetch(`${base}/api/git/file?t=${topic}&mode=working&path=${encodeURIComponent('src/a.ts')}`, {
      headers: { cookie },
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual(file);

    const refused = await fetch(`${base}/api/git/file?t=${topic}&mode=working&path=README.md`, { headers: { cookie } });
    expect(refused.status).toBe(200);
    expect(await refused.json()).toEqual({ ok: false, text: 'That file is not one of the changes shown.' });
    expect(calls).toEqual([{ mode: 'working', base: undefined, path: 'src/a.ts' }, { mode: 'working', base: undefined, path: 'README.md' }]);
  });

  it('refuses a malformed query before it reaches the daemon', async () => {
    const { base, room, topic } = await boot();
    const cookie = await signIn(base);
    let called = false;
    room.useGitPanel({
      status: async () => {
        called = true;
        return status;
      },
      file: async () => file,
      branches: async () => ({ ok: true, branches: [] }),
      ...idleHistory(),
    });

    for (const path of [
      `/api/git/status?t=${topic}`,
      `/api/git/status?t=${topic}&mode=staged`,
      `/api/git/status?t=not-a-topic&mode=working`,
      `/api/git/status?t=${topic}&mode=working&base=${'x'.repeat(301)}`,
      `/api/git/file?t=${topic}&mode=working`,
      `/api/git/file?t=${topic}&mode=working&path=`,
    ]) {
      expect((await fetch(`${base}${path}`, { headers: { cookie } })).status, path).toBe(400);
    }
    expect(called).toBe(false);
  });

  it('answers a page of commits, one commit and one of its files', async () => {
    const { base, room, topic } = await boot();
    const cookie = await signIn(base);
    const calls: unknown[] = [];
    room.useGitPanel({
      status: async () => status,
      file: async () => file,
      branches: async () => ({ ok: true, branches: [] }),
      log: async (_ref, skip) => {
        calls.push({ log: skip });
        return { ok: true, repo: { root: '/srv/project', branch: 'main' }, commits: [summary], more: true };
      },
      commit: async (_ref, sha) => {
        calls.push({ commit: sha });
        return { ok: true, repo: { root: '/srv/project' }, commit: { ...summary, body: 'why it changed' }, files: status.files };
      },
      commitFile: async (_ref, sha, path) => {
        calls.push({ commitFile: sha, path });
        return file;
      },
    });

    const log = await fetch(`${base}/api/git/log?t=${topic}&skip=50`, { headers: { cookie } });
    expect(log.status).toBe(200);
    expect(await log.json()).toEqual({ ok: true, repo: { root: '/srv/project', branch: 'main' }, commits: [summary], more: true });

    // No skip is the first page, not a malformed query.
    const first = await fetch(`${base}/api/git/log?t=${topic}`, { headers: { cookie } });
    expect(first.status).toBe(200);

    const commit = await fetch(`${base}/api/git/commit?t=${topic}&sha=${summary.sha}`, { headers: { cookie } });
    expect(commit.status).toBe(200);
    expect(await commit.json()).toMatchObject({ ok: true, commit: { sha: summary.sha, body: 'why it changed' } });

    const one = await fetch(`${base}/api/git/commit-file?t=${topic}&sha=${summary.sha}&path=${encodeURIComponent('src/a.ts')}`, {
      headers: { cookie },
    });
    expect(one.status).toBe(200);
    expect(await one.json()).toEqual(file);

    expect(calls).toEqual([
      { log: 50 },
      { log: 0 },
      { commit: summary.sha },
      { commitFile: summary.sha, path: 'src/a.ts' },
    ]);
  });

  it('refuses a malformed history query before it reaches the daemon', async () => {
    const { base, room, topic } = await boot();
    const cookie = await signIn(base);
    let called = false;
    const trip = async () => {
      called = true;
      return { ok: false as const, reason: 'error' as const, text: 'no' };
    };
    room.useGitPanel({
      status: async () => status,
      file: async () => file,
      branches: async () => ({ ok: true, branches: [] }),
      log: trip,
      commit: trip,
      commitFile: async () => {
        called = true;
        return { ok: false as const, text: 'no' };
      },
    });

    const sha = summary.sha;
    for (const path of [
      `/api/git/log?t=${topic}&skip=-1`,
      `/api/git/log?t=${topic}&skip=abc`,
      `/api/git/log?t=${topic}&skip=1.5`,
      `/api/git/log?t=${topic}&skip=100001`,
      `/api/git/log?t=not-a-topic`,
      `/api/git/commit?t=${topic}`,
      `/api/git/commit?t=${topic}&sha=HEAD`,
      `/api/git/commit?t=${topic}&sha=--all`,
      `/api/git/commit?t=${topic}&sha=abc`,
      `/api/git/commit?t=${topic}&sha=${'A'.repeat(40)}`,
      `/api/git/commit-file?t=${topic}&sha=${sha}`,
      `/api/git/commit-file?t=${topic}&sha=${sha}&path=`,
      `/api/git/commit-file?t=${topic}&sha=HEAD&path=a.txt`,
    ]) {
      expect((await fetch(`${base}${path}`, { headers: { cookie } })).status, path).toBe(400);
    }
    expect(called).toBe(false);
  });

  it('is behind the session like every other route', async () => {
    const { base, topic } = await boot();
    for (const path of [
      `/api/git/status?t=${topic}&mode=working`,
      `/api/git/file?t=${topic}&mode=working&path=a.txt`,
      `/api/git/branches?t=${topic}`,
      `/api/git/log?t=${topic}`,
      `/api/git/commit?t=${topic}&sha=${'a'.repeat(40)}`,
      `/api/git/commit-file?t=${topic}&sha=${'a'.repeat(40)}&path=a.txt`,
    ]) {
      expect((await fetch(`${base}${path}`)).status, path).toBe(401);
    }
  });
});

describe('webui server: lifecycle', () => {
  it('reports a port it cannot bind instead of letting the daemon run on half-working', async () => {
    // Without this, EADDRINUSE arrives as an asynchronous 'error' event, gets swallowed by the
    // daemon's global [uncaughtException] handler, and the daemon runs forever with a dead UI.
    const { instance } = await boot();
    const topics = new TopicStore(path.join(dir, 'clash.json'));
    const clash = createWebServer(new WebRoom(instance, topics), new WebAuth({ token: 'x' }), instance, {
      enabled: false,
      socket: '/nonexistent.sock',
      sessions: new TerminalSessions(),
    });
    await expect(clash.start()).rejects.toThrow(/cannot bind/);
  });

  it('stops promptly with a compressed event stream still open', async () => {
    // The regression this exists for: `server.close()` alone waits for every connection to
    // end, and an SSE response never does. Its callback would never fire, `Daemon.stop()` would
    // never resolve, and the signal handler's `process.exit` sits in that promise's finally —
    // so Ctrl-C would hang the daemon forever. The gzip stream has to be ended too, not just
    // the response.
    const { base, port, server, topic } = await boot();
    const cookie = await signIn(base);
    const stream = await openStream(port, topic, cookie);
    await stream.next();

    const started = Date.now();
    await server.stop();
    expect(Date.now() - started).toBeLessThan(1500);
    stream.close();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Terminal proxy
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A stand-in for ttyd on a unix socket: answers one GET and echoes bytes after an upgrade.
 *
 * Deliberately not a WebSocket library — the proxy under test never parses a frame, so a
 * handshake that looks right on the wire plus a byte echo is exactly the contract it has.
 */
function fakeTtyd(
  socketPath: string,
  type = 'text/html'
): Promise<{ seen: string[]; close: () => Promise<void> }> {
  const seen: string[] = [];
  const server = http.createServer((req, res) => {
    seen.push(req.url ?? '');
    res.writeHead(200, { 'content-type': type, 'x-from': 'ttyd' });
    res.end('<html>terminal</html>');
  });
  server.on('upgrade', (req, socket) => {
    seen.push(req.url ?? '');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        'Sec-WebSocket-Accept: stand-in\r\nSec-WebSocket-Protocol: tty\r\n\r\n'
    );
    socket.on('data', (d: Buffer) => socket.write(d));
    // Hang up when the proxy does. An `http.Server` socket reports the proxy's FIN as `end`
    // and then sits half-open forever, so without this the stand-in's own `close()` never
    // returns and the test reads as a leak in the code under test. Real ttyd closes on FIN.
    socket.on('end', () => socket.destroy());
  });
  return new Promise((resolve) => {
    server.listen(socketPath, () =>
      resolve({
        seen,
        close: () => new Promise<void>((done) => server.close(() => done())),
      })
    );
  });
}

/** Attempt a WebSocket handshake against the daemon and report what came back. */
function handshake(
  port: number,
  path_: string,
  headers: Record<string, string>
): Promise<{ status: number; echo?: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: path_,
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': 'AQIDBAUGBwgJCgsMDQ4PEC==',
        ...headers,
      },
    });
    req.on('upgrade', (_res, socket) => {
      socket.once('data', (d: Buffer) => {
        socket.destroy();
        resolve({ status: 101, echo: d.toString('utf8') });
      });
      socket.write('hello');
    });
    req.on('response', (res) => {
      res.resume();
      resolve({ status: res.statusCode ?? 0 });
    });
    // A refusal that writes a status line and hangs up arrives here rather than as a parsed
    // response, because `socket.end()` closes before the client has a body to finish.
    req.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'ECONNRESET') resolve({ status: 0 });
      else reject(e);
    });
    req.end();
    setTimeout(() => reject(new Error('handshake never settled')), 4000).unref();
  });
}

describe('webui server: terminal', () => {
  it('is not reachable at all when the feature is off', async () => {
    const { base, port } = await boot();
    const cookie = await signIn(base);
    expect((await fetch(`${base}/term/`, { headers: { cookie } })).status).toBe(404);
    // And neither is the handshake — which is the half that does NOT go through the route
    // table, so a 404 on the GET says nothing about it.
    const up = await handshake(port, '/term/ws', { cookie, origin: `http://127.0.0.1:${port}` });
    expect(up.status).not.toBe(101);
  });

  it('proxies the page and the websocket once signed in', async () => {
    const socketPath = path.join(dir, 'ttyd.sock');
    const ttyd = await fakeTtyd(socketPath);
    const { base, port } = await boot({}, { enabled: true, socket: socketPath });
    const cookie = await signIn(base);

    const page = await fetch(`${base}/term/`, { headers: { cookie } });
    expect(page.status).toBe(200);
    // Passed through rather than rebuilt: ttyd's own headers have to survive, because its
    // Content-Encoding is how the browser knows to inflate the page.
    expect(page.headers.get('x-from')).toBe('ttyd');
    expect(await page.text()).toContain('terminal');

    const up = await handshake(port, '/term/ws', { cookie, origin: `http://127.0.0.1:${port}` });
    expect(up.status).toBe(101);
    expect(up.echo).toBe('hello');
    expect(ttyd.seen).toContain('/term/ws');
    await ttyd.close();
  });

  it('passes the upstream content type through, so what /term/ serves is ttyd’s to decide', async () => {
    // The reason the security note says "the only JavaScript THIS FILE writes" rather than "the
    // only JavaScript under this origin": the proxy copies headers verbatim, so a ttyd that
    // served a .js (or the next ttyd release adding one) would answer as JavaScript and this
    // server would neither know nor change it. Pinned rather than assumed, because the wording
    // of that note depends on it.
    const socketPath = path.join(dir, 'ttyd.sock');
    const ttyd = await fakeTtyd(socketPath, 'text/javascript');
    const { base } = await boot({}, { enabled: true, socket: socketPath });
    const cookie = await signIn(base);
    const res = await fetch(`${base}/term/bundle.js`, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/javascript');
    expect(await res.text()).toContain('terminal');
    await ttyd.close();
  });

  it('refuses a handshake with no session, rather than leaving it hanging', async () => {
    // The trap this pins: an upgrade never reaches `route()`, so none of the checks there
    // apply to it. A hung handshake would also be indistinguishable from a slow backend and
    // would hold a connection against the browser's per-origin limit for the tab's lifetime.
    const socketPath = path.join(dir, 'ttyd.sock');
    const ttyd = await fakeTtyd(socketPath);
    const { port } = await boot({}, { enabled: true, socket: socketPath });
    const up = await handshake(port, '/term/ws', { origin: `http://127.0.0.1:${port}` });
    expect(up.status).not.toBe(101);
    expect(ttyd.seen).toHaveLength(0);
    await ttyd.close();
  });

  it('refuses a handshake from another origin, and one that names no origin', async () => {
    // A handshake is exempt from the same-origin policy and carries cookies whatever
    // `SameSite` says, so here the Origin check is the only lock rather than the second one.
    const socketPath = path.join(dir, 'ttyd.sock');
    const ttyd = await fakeTtyd(socketPath);
    const { base, port } = await boot({}, { enabled: true, socket: socketPath });
    const cookie = await signIn(base);

    expect((await handshake(port, '/term/ws', { cookie, origin: 'http://evil.test' })).status).not.toBe(101);
    expect((await handshake(port, '/term/ws', { cookie })).status).not.toBe(101);
    expect(ttyd.seen).toHaveLength(0);
    await ttyd.close();
  });

  it('refuses an arg that is not one of this room’s topics', async () => {
    // ttyd runs with --url-arg, so this string reaches an exec on the other side. It is
    // checked against the topic store before ttyd ever sees it.
    const socketPath = path.join(dir, 'ttyd.sock');
    const ttyd = await fakeTtyd(socketPath);
    const { base, port, topic } = await boot({}, { enabled: true, socket: socketPath });
    const cookie = await signIn(base);

    expect((await fetch(`${base}/term/?arg=deadbeef`, { headers: { cookie } })).status).toBe(400);
    expect((await fetch(`${base}/term/?arg=${topic}`, { headers: { cookie } })).status).toBe(200);
    // Two args is nobody's legitimate request and would hand the wrapper a second parameter.
    expect((await fetch(`${base}/term/?arg=${topic}&arg=${topic}`, { headers: { cookie } })).status).toBe(400);

    const bad = await handshake(port, '/term/ws?arg=deadbeef', {
      cookie,
      origin: `http://127.0.0.1:${port}`,
    });
    expect(bad.status).not.toBe(101);
    await ttyd.close();
  });

  it('says so plainly when the backend is not running', async () => {
    const { base } = await boot({}, { enabled: true, socket: path.join(dir, 'absent.sock') });
    const cookie = await signIn(base);
    const res = await fetch(`${base}/term/`, { headers: { cookie } });
    expect(res.status).toBe(502);
    expect(await res.text()).toMatch(/not running/);
  });

  it('stops promptly with a proxied websocket still open', async () => {
    // Same shape as the event-stream case above, one hop further out: the connection to ttyd
    // is one `server.close()` would wait on forever and is not ours to wait for.
    const socketPath = path.join(dir, 'ttyd.sock');
    const ttyd = await fakeTtyd(socketPath);
    const { base, port, server } = await boot({}, { enabled: true, socket: socketPath });
    const cookie = await signIn(base);
    const live = await handshake(port, '/term/ws', { cookie, origin: `http://127.0.0.1:${port}` });
    expect(live.status).toBe(101);

    const started = Date.now();
    await server.stop();
    expect(Date.now() - started).toBeLessThan(1500);
    await ttyd.close();
  });

  it('counts a live pane against its topic, and stops counting when it goes', async () => {
    // What the switcher's marker is made of. The count is the daemon's only knowledge of the
    // terminal — it never asks the far side anything — so this is the whole of "running".
    const socketPath = path.join(dir, 'ttyd.sock');
    const ttyd = await fakeTtyd(socketPath);
    const { base, port, topic, sessions, room } = await boot({}, { enabled: true, socket: socketPath });
    const cookie = await signIn(base);
    expect(sessions.has(topic)).toBe(false);

    const up = await handshake(port, `/term/ws?arg=${topic}`, { cookie, origin: `http://127.0.0.1:${port}` });
    expect(up.status).toBe(101);
    expect(sessions.has(topic)).toBe(true);
    expect(room.topicList().find((t) => t.id === topic)?.term).toBe(true);

    // `handshake` destroys its socket after the echo, which is a closed tab. The count has to
    // follow it down or the marker never goes out again.
    await until(() => !sessions.has(topic));
    expect(room.topicList().find((t) => t.id === topic)?.term).toBe(false);
    await ttyd.close();
  });

  it('does not count a handshake it refused', async () => {
    // A refusal is not a pane. Counting one would light a marker with nothing left to put it
    // out, since there is no socket whose close could decrement it.
    const socketPath = path.join(dir, 'ttyd.sock');
    const ttyd = await fakeTtyd(socketPath);
    const { port, sessions } = await boot({}, { enabled: true, socket: socketPath });
    const bad = await handshake(port, '/term/ws?arg=deadbeef', { origin: `http://127.0.0.1:${port}` });
    expect(bad.status).not.toBe(101);
    expect(sessions.has('deadbeef')).toBe(false);
    await ttyd.close();
  });

  it('ends a session by running the command the operator configured', async () => {
    const stamp = path.join(dir, 'ended.txt');
    const { base, topic } = await boot(
      {},
      {
        enabled: true,
        socket: path.join(dir, 'absent.sock'),
        // No shell: argv[0] is the program, and `{topic}` is substituted into an argument
        // rather than into a command line. `node -e` rather than `sh -c` so this does not
        // depend on a shell being there.
        endCommand: [
          process.execPath,
          '-e',
          'require("fs").writeFileSync(process.argv[1], process.argv[2])',
          stamp,
          '{topic}',
        ],
      }
    );
    const cookie = await signIn(base);

    const res = await fetch(`${base}/api/terminal/end`, {
      method: 'POST',
      headers: { ...JSON_HEADERS, cookie, origin: base },
      body: JSON.stringify({ topic }),
    });
    expect(res.status).toBe(200);
    expect(fs.readFileSync(stamp, 'utf8')).toBe(topic);
  });

  it('reports a command that failed instead of claiming the session is gone', async () => {
    const { base, topic } = await boot(
      {},
      {
        enabled: true,
        socket: path.join(dir, 'absent.sock'),
        endCommand: [process.execPath, '-e', 'process.exit(3)', '{topic}'],
      }
    );
    const cookie = await signIn(base);
    const res = await fetch(`${base}/api/terminal/end`, {
      method: 'POST',
      headers: { ...JSON_HEADERS, cookie, origin: base },
      body: JSON.stringify({ topic }),
    });
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/could not end/);
  });

  it('refuses to end anything without a configured command, or for a topic it does not have', async () => {
    const { base, topic } = await boot({}, { enabled: true, socket: path.join(dir, 'absent.sock') });
    const cookie = await signIn(base);
    const end = (body: unknown): Promise<Response> =>
      fetch(`${base}/api/terminal/end`, {
        method: 'POST',
        headers: { ...JSON_HEADERS, cookie, origin: base },
        body: JSON.stringify(body),
      });

    // Unknown topic first: it is answered before the missing command, so a page cannot learn
    // which topics exist by reading which error it gets.
    expect((await end({ topic: 'deadbeef' })).status).toBe(404);
    // 501, not 404: the route is there and the request was fine — this deployment simply never
    // said what ending a session means.
    expect((await end({ topic })).status).toBe(501);
    // And the shape is still a shape. `{topic}` reaches a command, so nothing else may.
    expect((await end({ topic, extra: 1 })).status).toBe(400);
    expect((await end({ topic: '../../etc' })).status).toBe(400);
  });

  it('will not end a session on a daemon that serves no terminal', async () => {
    const { base, topic } = await boot({}, { enabled: false, socket: '/nonexistent.sock', endCommand: ['true', '{topic}'] });
    const cookie = await signIn(base);
    const res = await fetch(`${base}/api/terminal/end`, {
      method: 'POST',
      headers: { ...JSON_HEADERS, cookie, origin: base },
      body: JSON.stringify({ topic }),
    });
    expect(res.status).toBe(404);
  });
});

describe('webui server: the file window', () => {
  const post = (base: string, cookie: string, route: string, body: unknown) =>
    fetch(`${base}${route}`, { method: 'POST', headers: { ...JSON_HEADERS, cookie }, body: JSON.stringify(body) });

  /** The smallest panel the routes can reach: the daemon's own is tested in daemon/file-panel.test.ts. */
  function fakePanel(): { panel: FilesPanel; seen: string[] } {
    const seen: string[] = [];
    const ok = <T extends object>(v: T) => ({ ok: true as const, ...v });
    const panel: FilesPanel = {
      async list(_ref, p) {
        seen.push(`list ${p}`);
        return ok({ path: '/w', rel: '', entries: [{ name: 'a.txt', dir: false }] });
      },
      async read(_ref, p) {
        seen.push(`read ${p}`);
        return ok({
          path: p,
          dir: '/w',
          rel: 'a.txt',
          name: 'a.txt',
          size: 3,
          mtimeMs: 5,
          kind: 'text' as const,
          text: 'abc',
          sha256: 'a'.repeat(64),
        });
      },
      async write(_ref, p, text, expect) {
        seen.push(`write ${p} ${text} ${JSON.stringify(expect)}`);
        if (p.endsWith('stale.txt')) {
          return { ok: false as const, conflict: true as const, exists: true, size: 9, mtimeMs: 10, error: 'changed' };
        }
        return { ok: true as const, mtimeMs: 6, size: text.length, sha256: 'b'.repeat(64) };
      },
      async create(_ref, p, dir) {
        seen.push(`create ${p} ${dir}`);
        return { ok: true as const, path: p, dir };
      },
      async rename(_ref, from, to) {
        seen.push(`rename ${from} ${to}`);
        return { ok: true as const, path: to };
      },
      async remove(_ref, p) {
        seen.push(`remove ${p}`);
        return { ok: true as const, removed: true };
      },
      async search(_ref, q) {
        seen.push(`search ${q}`);
        return { ok: true as const, hits: [{ path: '/w/a.txt', rel: 'a.txt', name: 'a.txt', dir: false }], truncated: false };
      },
    };
    return { panel, seen };
  }

  it('answers 404 on every route when the feature is off', async () => {
    const { base, topic } = await boot();
    const cookie = await signIn(base);
    const q = `topic=${topic}&path=a.txt&q=x`;
    for (const route of ['/api/files/list', '/api/files/read', '/api/files/search']) {
      expect((await fetch(`${base}${route}?${q}`, { headers: { cookie } })).status, route).toBe(404);
    }
    for (const [route, body] of [
      ['/api/files/write', { topic, path: 'a.txt', text: 'x' }],
      ['/api/files/create', { topic, path: 'a.txt', dir: false }],
      ['/api/files/rename', { topic, from: 'a.txt', to: 'b.txt' }],
      ['/api/files/remove', { topic, path: 'a.txt' }],
    ] as const) {
      expect((await post(base, cookie, route, body)).status, route).toBe(404);
    }
  });

  it('lists, reads and writes through the injected panel when it is on', async () => {
    const { base, room, topic } = await boot({ files: { enabled: true, roots: [] } });
    const files = fakePanel();
    room.useFilesPanel(files.panel);
    const cookie = await signIn(base);

    const list = await fetch(`${base}/api/files/list?topic=${topic}&path=`, { headers: { cookie } });
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({ ok: true, path: '/w', entries: [{ name: 'a.txt', dir: false }] });

    const read = await fetch(`${base}/api/files/read?topic=${topic}&path=/w/a.txt&preview=1`, { headers: { cookie } });
    expect(await read.json()).toMatchObject({ ok: true, kind: 'text', text: 'abc', sha256: 'a'.repeat(64) });

    const save = await post(base, cookie, '/api/files/write', {
      topic,
      path: '/w/a.txt',
      text: 'hello',
      mtimeMs: 5,
      size: 3,
      sha256: 'a'.repeat(64),
    });
    expect(save.status).toBe(200);
    expect(await save.json()).toMatchObject({ ok: true, mtimeMs: 6, size: 5 });
    // The whole version — sha included — reaches the panel.
    expect(files.seen.at(-1)).toBe(`write /w/a.txt hello {"mtimeMs":5,"size":3,"sha256":"${'a'.repeat(64)}"}`);

    // A conflict is 409, with what the file is now — the page's three-way choice hangs off it.
    const stale = await post(base, cookie, '/api/files/write', { topic, path: '/w/stale.txt', text: 'x', mtimeMs: 1, size: 1 });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ ok: false, conflict: true, exists: true, size: 9 });

    expect((await post(base, cookie, '/api/files/create', { topic, path: '/w/new.txt', dir: false })).status).toBe(200);
    expect((await post(base, cookie, '/api/files/rename', { topic, from: '/w/a.txt', to: '/w/b.txt' })).status).toBe(200);
    expect((await post(base, cookie, '/api/files/remove', { topic, path: '/w/b.txt' })).status).toBe(200);
    const search = await fetch(`${base}/api/files/search?topic=${topic}&q=a`, { headers: { cookie } });
    expect(await search.json()).toMatchObject({ ok: true, hits: [{ rel: 'a.txt' }] });
  });

  it('validates the query and the body before anything reaches a machine', async () => {
    const { base, room, topic } = await boot({ files: { enabled: true, roots: [] } });
    room.useFilesPanel(fakePanel().panel);
    const cookie = await signIn(base);

    expect((await fetch(`${base}/api/files/list?topic=nope&path=`, { headers: { cookie } })).status).toBe(400);
    expect((await fetch(`${base}/api/files/search?topic=${topic}&q=`, { headers: { cookie } })).status).toBe(400);
    // .strict(): an extra key is a refused body, not an ignored one.
    const extra = await post(base, cookie, '/api/files/write', { topic, path: 'a', text: 'x', rm: '-rf' });
    expect(extra.status).toBe(400);
    // The explicit overwrite is a body the schema accepts; whether it skips the check is the
    // daemon's business, not the protocol's.
    expect((await post(base, cookie, '/api/files/write', { topic, path: '/w/a', text: 'x', force: true })).status).toBe(200);
  });

  it('serves the page with the button revealed only when the feature is on', async () => {
    const off = await boot();
    const offPage = await fetch(`${off.base}/`).then((r) => r.text());
    expect(bootOf(offPage).files).toBe(false);
    const on = await boot({ files: { enabled: true, roots: [] } });
    const onPage = await fetch(`${on.base}/`).then((r) => r.text());
    expect(bootOf(onPage).files).toBe(true);
  });
});

describe('webui server: the instruction editor', () => {
  const post = (base: string, cookie: string, route: string, body: unknown) =>
    fetch(`${base}${route}`, { method: 'POST', headers: { ...JSON_HEADERS, cookie }, body: JSON.stringify(body) });

  /** The routes' side only: the daemon's own panel is tested in daemon/instructions-panel.test.ts. */
  function fakePanel(): { panel: InstructionsPanel; seen: string[] } {
    const seen: string[] = [];
    const panel: InstructionsPanel = {
      async list() {
        seen.push('list');
        return { dir: '/c/instructions', on: true, global: [{ name: 'common.md', layer: 'common', exists: true, size: 3, agents: ['cc'], reach: 'every agent' }], agents: [] };
      },
      async refs(agent) {
        seen.push(`refs ${agent}`);
        if (agent !== 'cc') return { ok: false as const, error: `there is no agent "${agent}" in the config` };
        return { ok: true as const, agent, host: 'local', root: '~/.claude/CLAUDE.md', rootState: 'managed' as const, summary: 'refs', refs: [] };
      },
      async read(target, o) {
        seen.push(`read ${JSON.stringify(target)} ${o?.preview === true}`);
        return { ok: true as const, path: '/c/instructions/common.md', dir: '/c/instructions', name: 'common.md', size: 3, mtimeMs: 5, kind: 'text' as const, text: 'abc' };
      },
      async write(target, text, expect) {
        seen.push(`write ${JSON.stringify(target)} ${text} ${JSON.stringify(expect)}`);
        if (target.scope === 'agent' && target.path.endsWith('stale.md')) {
          return { ok: false as const, conflict: true as const, exists: true, size: 9, mtimeMs: 10, error: 'changed' };
        }
        return { ok: true as const, mtimeMs: 6, size: text.length, sha256: 'b'.repeat(64), delivery: [{ host: 'local', agents: ['cc'], outcome: 'linked' }] };
      },
    };
    return { panel, seen };
  }

  it('answers 404 on every route when the feature is off, panel or not', async () => {
    const { base, room } = await boot();
    // Handed a panel anyway: the switch is the server's to read too, not only the daemon's.
    room.useInstructionsPanel(fakePanel().panel);
    const cookie = await signIn(base);
    for (const route of ['/api/instructions', '/api/instructions/refs?agent=cc', '/api/instructions/read?scope=global&name=common.md']) {
      expect((await fetch(`${base}${route}`, { headers: { cookie } })).status, route).toBe(404);
    }
    expect((await post(base, cookie, '/api/instructions/write', { scope: 'global', name: 'common.md', text: 'x' })).status).toBe(404);
    const page = await fetch(`${base}/`).then((r) => r.text());
    expect(bootOf(page).instructions).toBe(false);
  });

  it('answers 404 when it is on but the daemon handed over no panel', async () => {
    const { base } = await boot({ instructions: { enabled: true } });
    const cookie = await signIn(base);
    expect((await fetch(`${base}/api/instructions`, { headers: { cookie } })).status).toBe(404);
  });

  it('lists, reads and writes through the panel, behind the session', async () => {
    const { base, room } = await boot({ instructions: { enabled: true } });
    const p = fakePanel();
    room.useInstructionsPanel(p.panel);
    expect((await fetch(`${base}/api/instructions`)).status).toBe(401);
    const cookie = await signIn(base);
    expect(bootOf(await fetch(`${base}/`, { headers: { cookie } }).then((r) => r.text())).instructions).toBe(true);

    expect(await (await fetch(`${base}/api/instructions`, { headers: { cookie } })).json()).toMatchObject({ on: true, global: [{ name: 'common.md' }] });
    const refs = await fetch(`${base}/api/instructions/refs?agent=nope`, { headers: { cookie } });
    expect(refs.status).toBe(400);
    expect(await refs.json()).toMatchObject({ error: expect.stringContaining('no agent') });

    const read = await fetch(`${base}/api/instructions/read?scope=agent&agent=cc&path=${encodeURIComponent('/h/r.md')}&preview=1`, { headers: { cookie } });
    expect(read.status).toBe(200);
    expect(p.seen.at(-1)).toBe('read {"scope":"agent","agent":"cc","path":"/h/r.md"} true');

    const save = await post(base, cookie, '/api/instructions/write', { scope: 'global', name: 'common.md', text: 'hi', mtimeMs: 5, size: 3, sha256: 'a'.repeat(64) });
    expect(save.status).toBe(200);
    expect(await save.json()).toMatchObject({ ok: true, delivery: [{ host: 'local', outcome: 'linked' }] });
    expect(p.seen.at(-1)).toBe(`write {"scope":"global","name":"common.md"} hi {"mtimeMs":5,"size":3,"sha256":"${'a'.repeat(64)}"}`);

    // A file not written yet is created only where nothing is: `missing` reaches the panel alone.
    await post(base, cookie, '/api/instructions/write', { scope: 'global', name: 'claude.md', text: 'x', missing: true, mtimeMs: 0 });
    expect(p.seen.at(-1)).toBe('write {"scope":"global","name":"claude.md"} x {"missing":true}');

    const stale = await post(base, cookie, '/api/instructions/write', { scope: 'agent', agent: 'cc', path: '/h/stale.md', text: 'x', mtimeMs: 1, size: 1 });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ conflict: true, exists: true });
  });

  it('refuses a malformed target before the panel sees it', async () => {
    const { base, room } = await boot({ instructions: { enabled: true } });
    const p = fakePanel();
    room.useInstructionsPanel(p.panel);
    const cookie = await signIn(base);
    const get = (q: string) => fetch(`${base}/api/instructions/read?${q}`, { headers: { cookie } });
    expect((await get('scope=disk&path=/etc/passwd')).status).toBe(400);
    expect((await get('scope=agent&agent=cc')).status).toBe(400);
    expect((await get('scope=global')).status).toBe(400);
    // .strict() and the closed union: a global save cannot carry a path, an agent save must.
    expect((await post(base, cookie, '/api/instructions/write', { scope: 'global', name: 'common.md', path: '/etc/x', text: 'x' })).status).toBe(400);
    expect((await post(base, cookie, '/api/instructions/write', { scope: 'agent', agent: 'cc', text: 'x' })).status).toBe(400);
    expect((await post(base, cookie, '/api/instructions/write', { scope: 'file', path: '/etc/x', text: 'x' })).status).toBe(400);
    expect(p.seen.filter((s) => s.startsWith('read') || s.startsWith('write'))).toEqual([]);
  });
});

describe('webui server: notifications and what the operator has seen', () => {
  const P256 = 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4';
  const post = (base: string, cookie: string, route: string, body: unknown) =>
    fetch(`${base}${route}`, { method: 'POST', headers: { ...JSON_HEADERS, cookie }, body: JSON.stringify(body) });

  it('serves the service worker to anyone, uncached, with a CSP of its own; and lets the page register it', async () => {
    const { base } = await boot();
    const sw = await fetch(`${base}/sw.js`);
    expect(sw.status).toBe(200);
    expect(sw.headers.get('content-type')).toMatch(/javascript/);
    expect(sw.headers.get('cache-control')).toBe('no-cache');
    // Its own origin and nothing else: the icon, and the topic a push is about (sw.ts keepTopic).
    expect(sw.headers.get('content-security-policy')).toBe("default-src 'none'; img-src 'self'; connect-src 'self'");
    const body = await sw.text();
    expect(body).toContain("addEventListener('push'");
    // No fetch handler: a worker that cached the app would serve last week's page after an upgrade.
    expect(body).not.toContain("'fetch'");
    const page = await fetch(`${base}/`);
    expect(page.headers.get('content-security-policy')).toContain("worker-src 'self'");
    expect(page.headers.get('content-security-policy')).toContain("script-src 'self';");
  });

  it('hands out the push key only behind the session, and keeps a subscription to a real push service', async () => {
    const push = new WebPush(path.join(dir, 'push'));
    const { base } = await boot({}, undefined, undefined, push);
    expect((await fetch(`${base}/api/push`)).status).toBe(401);
    const cookie = await signIn(base);
    const key = await fetch(`${base}/api/push`, { headers: { cookie } }).then((r) => r.json());
    expect(key).toEqual({ enabled: true, key: push.publicKey });

    const ok = await post(base, cookie, '/api/push/subscribe', {
      endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
      expirationTime: null,
      keys: { p256dh: P256, auth: 'BTBZMqHH6r4Tts7J_aSIgg' },
    });
    expect(ok.status).toBe(200);
    expect(push.has('https://fcm.googleapis.com/fcm/send/abc')).toBe(true);

    await post(base, cookie, '/api/push/unsubscribe', { endpoint: 'https://fcm.googleapis.com/fcm/send/abc' });
    expect(push.count).toBe(0);
  });

  it('refuses a subscription whose endpoint is not a push service — the server would POST to it', async () => {
    const push = new WebPush(path.join(dir, 'push'));
    const { base } = await boot({}, undefined, undefined, push);
    const cookie = await signIn(base);
    const res = await post(base, cookie, '/api/push/subscribe', {
      endpoint: 'https://169.254.169.254/latest/meta-data',
      keys: { p256dh: P256, auth: 'BTBZMqHH6r4Tts7J_aSIgg' },
    });
    expect(res.status).toBe(400);
    expect(push.count).toBe(0);
  });

  it('says there are no notifications when the server has none', async () => {
    const { base } = await boot();
    const cookie = await signIn(base);
    expect(await fetch(`${base}/api/push`, { headers: { cookie } }).then((r) => r.json())).toEqual({ enabled: false });
  });

  it('records what the operator has seen', async () => {
    const { base, room, topic } = await boot();
    const cookie = await signIn(base);
    room.setActivity(topic, { outcome: { kind: 'done', at: Date.now() - 5 } });
    expect(room.topicList().find((t) => t.id === topic)?.stage).toBe('review');
    expect((await post(base, cookie, '/api/seen', { topic })).status).toBe(200);
    expect(room.topicList().find((t) => t.id === topic)?.stage).toBe('idle');
  });

  it('deleting a topic that opened others leaves them as topics of their own', async () => {
    const { base, room, topic } = await boot();
    const cookie = await signIn(base);
    const child = room.createTopic('[cx] part', topic);
    expect((await post(base, cookie, '/api/topics/delete', { topic })).status).toBe(200);
    expect(room.topicList().find((t) => t.id === child.id)?.parent).toBeUndefined();
  });
});

describe('WebServer: a turn’s changes', () => {
  const status = {
    ok: true as const,
    repo: { root: '/work/app', branch: 'main', base: 'abc' },
    files: [{ path: 'src/a.ts', status: 'modified' as const, additions: 3, deletions: 1 }],
  };
  const file = {
    ok: true as const,
    path: 'src/a.ts',
    status: 'modified' as const,
    original: 'a\n',
    modified: 'b\n',
    patch: '-a\n+b\n',
  };

  it('answers one turn’s file list and one of its files, both read through the room', async () => {
    const { base, room, topic } = await boot();
    const cookie = await signIn(base);
    const asked: string[] = [];
    room.useTurnChanges({
      status: async (ref, turn) => {
        asked.push(`status ${ref.thread} ${turn}`);
        return status;
      },
      file: async (ref, turn, path) => {
        asked.push(`file ${ref.thread} ${turn} ${path}`);
        return file;
      },
    });

    const list = await fetch(`${base}/api/turn-changes/status?t=${topic}&turn=2`, { headers: { cookie } });
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual(status);

    const one = await fetch(`${base}/api/turn-changes/file?t=${topic}&turn=2&path=${encodeURIComponent('src/a.ts')}`, {
      headers: { cookie },
    });
    expect(one.status).toBe(200);
    expect(await one.json()).toEqual(file);
    expect(asked).toEqual([`status ${topic} 2`, `file ${topic} 2 src/a.ts`]);
  });

  it('answers a record it does not have with the failure shape, and refuses a malformed query', async () => {
    const { base, room, topic } = await boot();
    const cookie = await signIn(base);
    room.useTurnChanges({
      status: async () => ({ ok: false, reason: 'error', text: 'no changes were recorded for turn 9' }),
      file: async () => ({ ok: false, text: 'src/a.ts did not change in that turn' }),
    });

    const missing = await fetch(`${base}/api/turn-changes/status?t=${topic}&turn=9`, { headers: { cookie } });
    expect(missing.status).toBe(200);
    expect(await missing.json()).toMatchObject({ ok: false, reason: 'error' });

    const noFile = await fetch(`${base}/api/turn-changes/file?t=${topic}&turn=9&path=nope`, { headers: { cookie } });
    expect(noFile.status).toBe(404);

    for (const path of [
      '/api/turn-changes/status',
      `/api/turn-changes/status?t=${topic}`,
      '/api/turn-changes/status?t=zzzz&turn=1',
      `/api/turn-changes/status?t=${topic}&turn=0`,
      `/api/turn-changes/file?t=${topic}&turn=1`,
    ]) {
      expect((await fetch(`${base}${path}`, { headers: { cookie } })).status, path).toBe(400);
    }
  });

  it('is behind the session like every other route', async () => {
    const { base, topic } = await boot();
    for (const path of ['/api/turn-changes/status?t=' + topic + '&turn=1', '/api/turn-changes/file?t=' + topic + '&turn=1&path=a']) {
      expect((await fetch(`${base}${path}`)).status, path).toBe(401);
    }
  });
});

describe('WebServer: the agent’s own settings', () => {
  const ACCOUNT = {
    id: 'account',
    name: 'Account',
    current: 'work',
    options: [
      { value: 'work', name: 'Work' },
      { value: 'home', name: 'Home', description: '5-hour limit used up' },
    ],
  };

  it('peeks, lists and chooses through the room, for the topic named', async () => {
    const { base, room, topic } = await boot();
    const cookie = await signIn(base);
    const asked: string[] = [];
    room.useOptionPicker({
      peek: async (ref) => {
        asked.push(`peek ${ref.thread}`);
        return { agent: 'browser', options: [{ id: 'account', name: 'Account' }] };
      },
      list: async (ref) => {
        asked.push(`list ${ref.thread}`);
        return { ok: true, agent: 'browser', options: [ACCOUNT] };
      },
      choose: async (ref, id, value) => {
        asked.push(`choose ${ref.thread} ${id}=${value}`);
        return { ok: true, options: [{ ...ACCOUNT, current: value }], text: 'Account set to Home for this conversation.' };
      },
    });

    const peek = await fetch(`${base}/api/options?peek=1&t=${topic}`, { headers: { cookie } });
    expect(peek.status).toBe(200);
    expect(await peek.json()).toEqual({ agent: 'browser', options: [{ id: 'account', name: 'Account' }] });

    const list = await fetch(`${base}/api/options?t=${topic}`, { headers: { cookie } });
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({ ok: true, agent: 'browser', options: [ACCOUNT] });

    const pick = await fetch(`${base}/api/options`, {
      method: 'POST',
      headers: { ...JSON_HEADERS, cookie },
      body: JSON.stringify({ topic, id: 'account', value: 'home' }),
    });
    expect(pick.status).toBe(200);
    expect(await pick.json()).toMatchObject({ ok: true, text: 'Account set to Home for this conversation.' });
    expect(asked).toEqual([`peek ${topic}`, `list ${topic}`, `choose ${topic} account=home`]);
  });

  it('hands an agent’s refusal back as a 409 with its sentence', async () => {
    const { base, room, topic } = await boot();
    const cookie = await signIn(base);
    room.useOptionPicker({
      peek: async () => ({ agent: 'browser', options: [] }),
      list: async () => ({ ok: false, agent: 'browser', reason: 'none', text: 'browser has no settings of its own to change.' }),
      choose: async () => ({ ok: false, text: 'This conversation already started on work; its account cannot change.' }),
    });
    const pick = await fetch(`${base}/api/options`, {
      method: 'POST',
      headers: { ...JSON_HEADERS, cookie },
      body: JSON.stringify({ topic, id: 'account', value: 'home' }),
    });
    expect(pick.status).toBe(409);
    expect(await pick.json()).toEqual({ ok: false, text: 'This conversation already started on work; its account cannot change.' });
  });

  it('answers an unknown topic and a daemon without the switch in words, and refuses a malformed request', async () => {
    const { base, room, topic } = await boot();
    const cookie = await signIn(base);
    // No picker handed over yet: nothing to draw, and words for the list.
    expect(await (await fetch(`${base}/api/options?peek=1&t=${topic}`, { headers: { cookie } })).json()).toEqual({ options: [] });
    expect(await (await fetch(`${base}/api/options?t=${topic}`, { headers: { cookie } })).json()).toMatchObject({ ok: false, reason: 'off' });
    room.useOptionPicker({
      peek: async () => ({ agent: 'browser', options: [{ id: 'account', name: 'Account' }] }),
      list: async () => ({ ok: true, agent: 'browser', options: [ACCOUNT] }),
      choose: async () => ({ ok: true, options: [ACCOUNT], text: '' }),
    });
    expect(await (await fetch(`${base}/api/options?peek=1&t=0badc0de`, { headers: { cookie } })).json()).toEqual({ options: [] });
    expect((await fetch(`${base}/api/options?t=zzzz`, { headers: { cookie } })).status).toBe(400);
    const bad = await fetch(`${base}/api/options`, {
      method: 'POST',
      headers: { ...JSON_HEADERS, cookie },
      body: JSON.stringify({ topic, id: 'account' }),
    });
    expect(bad.status).toBe(400);
  });

  it('is behind the session like every other route', async () => {
    const { base, topic } = await boot();
    expect((await fetch(`${base}/api/options?t=${topic}`)).status).toBe(401);
    const pick = await fetch(`${base}/api/options`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ topic, id: 'a', value: 'b' }) });
    expect(pick.status).toBe(401);
  });
});

describe('external plugin routes (/api/plugins/ and /plugins/)', () => {
  function writePluginFixture(id: string): string {
    const pluginDir = path.join(dir, `plugin-${id}`);
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, 'fleetherd-plugin.json'),
      JSON.stringify({
        id,
        name: `Plugin ${id}`,
        version: '0.1.0',
        client: 'client.mjs',
        style: 'style.css',
        server: 'server.mjs',
      }),
      'utf8'
    );
    fs.writeFileSync(path.join(pluginDir, 'client.mjs'), `export default { id: ${JSON.stringify(id)}, activate() {} };\n`, 'utf8');
    fs.writeFileSync(path.join(pluginDir, 'style.css'), '.hello { color: var(--fh-fg); }\n', 'utf8');
    fs.writeFileSync(
      path.join(pluginDir, 'server.mjs'),
      `export function activate(host) {
        host.routes.get('/ping', (_req, res) => {
          const body = JSON.stringify({ ok: true, id: host.id, greeting: host.config?.greeting ?? 'hi' });
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(body);
        });
        host.routes.post('/echo', async (req, res) => {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          const raw = Buffer.concat(chunks).toString('utf8');
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ echoed: JSON.parse(raw) }));
        });
      }
      `,
      'utf8'
    );
    return pluginDir;
  }

  async function bootWithPlugin(): Promise<Booted & { pluginHost: PluginHostManager }> {
    const pluginDir = writePluginFixture('hello');
    const loaded = loadPlugins([{ path: pluginDir, config: { greeting: 'bonjour' } }]);
    expect(loaded).toHaveLength(1);
    const port = await freePort();
    const instance: WebuiInstance = {
      ...WebuiConfigSchema.parse({ type: 'webui', token: 'open-sesame' }),
      id: 'webui',
      host: '127.0.0.1',
      port,
    };
    const topics = new TopicStore(path.join(dir, `${port}.json`));
    const topic = topics.current().id;
    const room = new WebRoom(instance, topics);
    const sessions = new TerminalSessions();
    room.useTerminalSessions(sessions);
    const pluginHost = new PluginHostManager({
      room,
      plugins: loaded,
      storageDir: path.join(dir, `plugin-storage-${port}`),
    });
    await pluginHost.activateAll();
    const server = createWebServer(
      room,
      new WebAuth({ token: instance.token }),
      instance,
      { enabled: false, socket: '/nonexistent.sock', sessions },
      undefined,
      undefined,
      loadAssets(path.join(dir, `no-assets-${port}`)),
      loaded,
      pluginHost
    );
    await server.start();
    running.push({
      start: () => server.start(),
      stop: async () => {
        await pluginHost.dispose();
        await server.stop();
      },
    });
    return { room, server, base: `http://127.0.0.1:${port}`, port, topic, instance, sessions, pluginHost };
  }

  it('requires authentication for plugin API routes and plugin static assets', async () => {
    const { base } = await bootWithPlugin();
    expect((await fetch(`${base}/api/plugins/hello/ping`)).status).toBe(401);
    expect(
      (
        await fetch(`${base}/api/plugins/hello/echo`, {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({ msg: 'hi' }),
        })
      ).status
    ).toBe(401);
    expect((await fetch(`${base}/plugins/hello/client.mjs`)).status).toBe(401);
  });

  it('dispatches authenticated GET/POST requests to the plugin host and enforces same-origin on POST', async () => {
    const { base, pluginHost } = await bootWithPlugin();
    const cookie = await signIn(base);

    const ping = await fetch(`${base}/api/plugins/hello/ping`, { headers: { cookie } });
    expect(ping.status).toBe(200);
    expect(await ping.json()).toEqual({ ok: true, id: 'hello', greeting: 'bonjour' });

    const echo = await fetch(`${base}/api/plugins/hello/echo`, {
      method: 'POST',
      headers: { ...JSON_HEADERS, cookie },
      body: JSON.stringify({ text: 'world' }),
    });
    expect(echo.status).toBe(200);
    expect(await echo.json()).toEqual({ echoed: { text: 'world' } });

    const crossOrigin = await fetch(`${base}/api/plugins/hello/echo`, {
      method: 'POST',
      headers: { ...JSON_HEADERS, cookie, origin: 'https://evil.example' },
      body: JSON.stringify({ text: 'blocked' }),
    });
    expect(crossOrigin.status).toBe(403);

    expect((await fetch(`${base}/api/plugins/hello/missing`, { headers: { cookie } })).status).toBe(404);
    expect((await fetch(`${base}/api/plugins/unknown/ping`, { headers: { cookie } })).status).toBe(404);

    await pluginHost.dispose();
    expect((await fetch(`${base}/api/plugins/hello/ping`, { headers: { cookie } })).status).toBe(404);
  });

  it('prevents plugins from shadowing built-in routes and rejects traversal subpaths', async () => {
    const { base, topic } = await bootWithPlugin();
    const cookie = await signIn(base);

    const builtIn = await fetch(`${base}/api/topic?t=${topic}`, { headers: { cookie } });
    expect(builtIn.status).toBe(200);
    expect(await builtIn.json()).toMatchObject({ topic });

    const created = await fetch(`${base}/api/topics`, {
      method: 'POST',
      headers: { ...JSON_HEADERS, cookie },
      body: JSON.stringify({ title: 'Built-in stays intact' }),
    });
    expect(created.status).toBe(201);

    expect((await fetch(`${base}/api/plugins/hello/%2e%2e/topics`, { headers: { cookie } })).status).toBe(404);
  });
});
