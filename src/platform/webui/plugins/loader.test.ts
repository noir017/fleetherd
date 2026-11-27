import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { WebuiConfigSchema } from '../../../config/platform-schemas.js';
import { loadAssets } from '../assets.js';
import { WebAuth } from '../auth.js';
import { WebRoom, type WebuiInstance } from '../room.js';
import { createWebServer, type WebServer } from '../server.js';
import { TerminalSessions } from '../terminal-sessions.js';
import { TopicStore } from '../topics.js';
import { assertSafePluginDir, loadPlugins, loadSinglePlugin, pluginMimeType } from './loader.js';

let tmpDir = '';
const running: WebServer[] = [];

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fh-plugin-loader-'));
});

afterEach(async () => {
  await Promise.all(running.splice(0).map((s) => s.stop()));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writePlugin(
  dir: string,
  manifest: Record<string, unknown>,
  files: Record<string, string> = {}
): string {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'fleetherd-plugin.json'), JSON.stringify(manifest, null, 2));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return dir;
}

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

function bootOf(html: string): Record<string, unknown> {
  const json = /<script type="application\/json" id="boot-config">([^<]*)<\/script>/.exec(html)?.[1];
  if (json === undefined) throw new Error('no boot-config');
  return JSON.parse(json) as Record<string, unknown>;
}

describe('assertSafePluginDir', () => {
  it('accepts a plugin directory outside forbidden roots', () => {
    const safeDir = path.join(tmpDir, 'opt-plugins', 'hello');
    const filesRoot = path.join(tmpDir, 'files-root');
    const agentWorkdir = path.join(tmpDir, 'agent-workdir');
    fs.mkdirSync(safeDir, { recursive: true });
    fs.mkdirSync(filesRoot, { recursive: true });
    fs.mkdirSync(agentWorkdir, { recursive: true });

    const resolved = assertSafePluginDir(safeDir, [filesRoot, agentWorkdir]);
    expect(resolved).toBe(fs.realpathSync(safeDir));
  });

  it('rejects plugin directories inside files.roots or agent workdirs', () => {
    const filesRoot = path.join(tmpDir, 'files-root');
    const underFiles = path.join(filesRoot, 'nested', 'hello');
    const agentWorkdir = path.join(tmpDir, 'agent-workdir');
    const underAgent = path.join(agentWorkdir, 'my-plugin');
    fs.mkdirSync(underFiles, { recursive: true });
    fs.mkdirSync(underAgent, { recursive: true });

    expect(() => assertSafePluginDir(filesRoot, [filesRoot])).toThrow(/forbidden root/);
    expect(() => assertSafePluginDir(underFiles, [filesRoot])).toThrow(/forbidden root/);
    expect(() => assertSafePluginDir(agentWorkdir, [agentWorkdir])).toThrow(/forbidden root/);
    expect(() => assertSafePluginDir(underAgent, [filesRoot, agentWorkdir])).toThrow(/forbidden root/);
  });

  it('rejects symlink pointing into a forbidden root (symlink bypass defense)', () => {
    const agentWorkdir = path.join(tmpDir, 'agent-workdir');
    const realTarget = path.join(agentWorkdir, 'evil-plugin');
    const symlinkDir = path.join(tmpDir, 'opt-plugins', 'disguised-link');
    fs.mkdirSync(realTarget, { recursive: true });
    fs.mkdirSync(path.dirname(symlinkDir), { recursive: true });
    fs.symlinkSync(realTarget, symlinkDir);

    expect(() => assertSafePluginDir(symlinkDir, [agentWorkdir])).toThrow(/forbidden root/);
  });

  it('rejects symlink inside a forbidden root pointing outside', () => {
    const filesRoot = path.join(tmpDir, 'files-root');
    const outsideTarget = path.join(tmpDir, 'outside-plugin');
    const linkInsideRoot = path.join(filesRoot, 'link-plugin');
    fs.mkdirSync(filesRoot, { recursive: true });
    fs.mkdirSync(outsideTarget, { recursive: true });
    fs.symlinkSync(outsideTarget, linkInsideRoot);

    expect(() => assertSafePluginDir(linkInsideRoot, [filesRoot])).toThrow(/forbidden root/);
  });
});

describe('loadSinglePlugin & loadPlugins', () => {
  it('loads a valid plugin, expands assets globs, and excludes server and unlisted files', () => {
    const pluginDir = writePlugin(
      path.join(tmpDir, 'plugins', 'hello'),
      {
        id: 'hello-plugin',
        name: 'Hello Plugin',
        version: '1.2.3',
        client: 'dist/client.js',
        style: 'dist/style.css',
        server: 'dist/server.mjs',
        assets: ['dist/assets/**'],
      },
      {
        'dist/client.js': 'export default { id: "hello-plugin" };',
        'dist/style.css': '.hello { color: red; }',
        'dist/server.mjs': 'export function activate() {}',
        'dist/assets/logo.svg': '<svg></svg>',
        'dist/assets/nested/data.json': '{"ok":true}',
        'secret.txt': 'do not serve',
      }
    );

    const res = loadSinglePlugin({ path: pluginDir, config: { greeting: 'hi' } });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.plugin.id).toBe('hello-plugin');
    expect(res.plugin.config).toEqual({ greeting: 'hi' });
    expect(res.plugin.bootEntry).toEqual({
      id: 'hello-plugin',
      version: '1.2.3',
      client: 'plugins/hello-plugin/dist/client.js',
      style: 'plugins/hello-plugin/dist/style.css',
    });
    expect([...res.plugin.allowedFiles.keys()].sort()).toEqual([
      'dist/assets/logo.svg',
      'dist/assets/nested/data.json',
      'dist/client.js',
      'dist/style.css',
    ]);
    expect(res.plugin.allowedFiles.has('dist/server.mjs')).toBe(false);
    expect(res.plugin.allowedFiles.has('secret.txt')).toBe(false);
    expect(res.plugin.allowedFiles.has('fleetherd-plugin.json')).toBe(false);
  });

  it('omits bootEntry for server-only plugins', () => {
    const pluginDir = writePlugin(
      path.join(tmpDir, 'plugins', 'server-only'),
      { id: 'server-only', name: 'Server Only', version: '0.1.0', server: 'dist/server.mjs' },
      { 'dist/server.mjs': 'export function activate() {}' }
    );
    const res = loadSinglePlugin({ path: pluginDir });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.plugin.bootEntry).toBeUndefined();
      expect(res.plugin.allowedFiles.size).toBe(0);
    }
  });

  it('rejects client file symlink escaping plugin directory', () => {
    const outsideSecret = path.join(tmpDir, 'outside.js');
    fs.writeFileSync(outsideSecret, 'console.log("leaked");');
    const pluginDir = writePlugin(path.join(tmpDir, 'plugins', 'escape'), {
      id: 'escape-test',
      name: 'Escape',
      version: '1.0.0',
      client: 'dist/client.js',
    });
    fs.mkdirSync(path.join(pluginDir, 'dist'), { recursive: true });
    fs.symlinkSync(outsideSecret, path.join(pluginDir, 'dist', 'client.js'));

    const res = loadSinglePlugin({ path: pluginDir });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/outside plugin directory/);
  });

  it('skips broken, forbidden, and duplicate plugins without crashing startup', () => {
    const forbidden = path.join(tmpDir, 'agent-cwd');
    const badForbidden = writePlugin(
      path.join(forbidden, 'bad-in-cwd'),
      { id: 'bad-in-cwd', name: 'Bad', version: '1.0.0' }
    );
    const goodDir = writePlugin(
      path.join(tmpDir, 'plugins', 'good'),
      { id: 'good-one', name: 'Good', version: '1.0.0', client: 'client.js' },
      { 'client.js': 'export default {};' }
    );
    const dupDir = writePlugin(
      path.join(tmpDir, 'plugins', 'dup'),
      { id: 'good-one', name: 'Dup', version: '2.0.0' }
    );
    const logs: string[] = [];
    const loaded = loadPlugins(
      [
        { path: badForbidden },
        { path: path.join(tmpDir, 'missing-dir') },
        { path: goodDir },
        { path: dupDir },
      ],
      { forbiddenRoots: [forbidden], log: (m) => logs.push(m) }
    );
    expect(loaded.map((p) => p.id)).toEqual(['good-one']);
    expect(logs).toHaveLength(3);
    expect(logs[0]).toContain('forbidden root');
    expect(logs[2]).toContain('duplicate plugin id');
  });

  it('maps MIME types safely and refuses HTML execution', () => {
    expect(pluginMimeType('dist/client.js')).toBe('application/javascript; charset=utf-8');
    expect(pluginMimeType('dist/client.mjs')).toBe('application/javascript; charset=utf-8');
    expect(pluginMimeType('dist/style.css')).toBe('text/css; charset=utf-8');
    expect(pluginMimeType('assets/icon.svg')).toBe('image/svg+xml');
    expect(pluginMimeType('assets/evil.html')).toBe('application/octet-stream');
  });
});

describe('GET /plugins/<id>/<file> and boot-config', () => {
  async function startServerWithPlugins(entries: Array<{ path: string; config?: unknown }>) {
    const port = await freePort();
    const instance: WebuiInstance = {
      ...WebuiConfigSchema.parse({ type: 'webui', token: 'open-sesame', plugins: entries }),
      id: 'webui',
      host: '127.0.0.1',
      port,
    };
    const topics = new TopicStore(path.join(tmpDir, `topics-${port}.json`));
    topics.current();
    const room = new WebRoom(instance, topics);
    const sessions = new TerminalSessions();
    room.useTerminalSessions(sessions);
    const loaded = loadPlugins(instance.plugins);
    const server = createWebServer(
      room,
      new WebAuth({ token: instance.token }),
      instance,
      { enabled: false, socket: '/nonexistent.sock', sessions },
      undefined,
      undefined,
      loadAssets(path.join(tmpDir, `no-assets-${port}`)),
      loaded
    );
    await server.start();
    running.push(server);
    const base = `http://127.0.0.1:${port}`;
    const loginRes = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'open-sesame' }),
    });
    const cookie = (loginRes.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    return { base, cookie };
  }

  it('guards /plugins/<id>/<file>, serves only whitelisted files, blocks traversal, and populates boot-config', async () => {
    const fePlugin = writePlugin(
      path.join(tmpDir, 'plugins', 'hello'),
      {
        id: 'hello-ui',
        name: 'Hello UI',
        version: '1.0.0',
        client: 'dist/client.js',
        style: 'dist/style.css',
        server: 'dist/server.mjs',
        assets: ['dist/assets/**'],
      },
      {
        'dist/client.js': 'export const ok = 1;',
        'dist/style.css': 'body { --x: 1; }',
        'dist/server.mjs': 'export function activate() {}',
        'dist/assets/icon.svg': '<svg/>',
        'secret.txt': 'nope',
      }
    );
    const bePlugin = writePlugin(
      path.join(tmpDir, 'plugins', 'be-only'),
      { id: 'backend-only', name: 'Backend', version: '0.5.0', server: 'index.mjs' },
      { 'index.mjs': 'export function activate() {}' }
    );

    const { base, cookie } = await startServerWithPlugins([{ path: fePlugin }, { path: bePlugin }]);

    // 1. Unauthenticated request must be refused (GUARDED)
    const unauth = await fetch(`${base}/plugins/hello-ui/dist/client.js`);
    expect(unauth.status).toBe(401);

    // 2. Whitelisted JS, CSS, and asset files are served with exact headers
    const js = await fetch(`${base}/plugins/hello-ui/dist/client.js`, { headers: { cookie } });
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toBe('application/javascript; charset=utf-8');
    expect(js.headers.get('cache-control')).toBe('no-cache');
    expect(js.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await js.text()).toBe('export const ok = 1;');

    const css = await fetch(`${base}/plugins/hello-ui/dist/style.css`, { headers: { cookie } });
    expect(css.status).toBe(200);
    expect(css.headers.get('content-type')).toBe('text/css; charset=utf-8');

    const svg = await fetch(`${base}/plugins/hello-ui/dist/assets/icon.svg`, { headers: { cookie } });
    expect(svg.status).toBe(200);
    expect(svg.headers.get('content-type')).toBe('image/svg+xml');

    // 3. Unlisted files, server module, manifest, and traversal attempts return 404
    for (const denied of [
      '/plugins/hello-ui/secret.txt',
      '/plugins/hello-ui/dist/server.mjs',
      '/plugins/hello-ui/fleetherd-plugin.json',
      '/plugins/hello-ui/..%2f..%2fetc%2fpasswd',
      '/plugins/hello-ui/dist/%2e%2e/secret.txt',
      '/plugins/unknown-plugin/dist/client.js',
    ]) {
      const r = await fetch(`${base}${denied}`, { headers: { cookie } });
      expect(r.status, `expected 404 for ${denied}`).toBe(404);
    }

    // 4. boot-config lists only frontend plugins; CSP stays script-src 'self'
    const pageRes = await fetch(`${base}/`);
    expect(pageRes.headers.get('content-security-policy')).toContain("script-src 'self';");
    const boot = bootOf(await pageRes.text());
    expect(boot.plugins).toEqual([
      {
        id: 'hello-ui',
        version: '1.0.0',
        client: 'plugins/hello-ui/dist/client.js',
        style: 'plugins/hello-ui/dist/style.css',
      },
    ]);
  });
});
