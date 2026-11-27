import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseConfig, type Config } from '../../config/schema.js';
import { checkWebui, inspectWebuiPlugins } from './doctor.js';

async function listenTcp(): Promise<{ server: net.Server; port: number }> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('expected tcp address');
  return { server, port: addr.port };
}

async function allocateFreePort(): Promise<number> {
  const { server, port } = await listenTcp();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function startHttpServer(
  handler: http.RequestListener
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('expected http address');
  return {
    url: `http://127.0.0.1:${addr.port}/jwks.json`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function makeWebuiConfig(opts: {
  host?: string;
  port: number;
  allowFrom?: string[];
  agentCwd?: string;
  remoteHost?: { id: string; cwd: string };
  filesRoots?: string[];
  plugins?: Array<{ path: string }>;
  sso?: { jwksUrl: string; header?: string; from?: string[]; password?: boolean };
}): Config {
  const agents: Array<Record<string, unknown>> = [
    { id: 'cc', harness: 'claude', ...(opts.agentCwd ? { cwd: opts.agentCwd } : {}) },
  ];
  const hosts: Record<string, { ssh: string }> = {};
  if (opts.remoteHost) {
    hosts[opts.remoteHost.id] = { ssh: `me@${opts.remoteHost.id}` };
    agents.push({ id: 'remote-cc', harness: 'claude', host: opts.remoteHost.id, cwd: opts.remoteHost.cwd });
  }
  return parseConfig({
    version: 1,
    agents,
    ...(Object.keys(hosts).length > 0 ? { hosts } : {}),
    platforms: {
      web: {
        type: 'webui',
        token: 'test-token',
        host: opts.host ?? '127.0.0.1',
        port: opts.port,
        ...(opts.filesRoots ? { files: { enabled: true, roots: opts.filesRoots } } : {}),
        ...(opts.plugins ? { plugins: opts.plugins } : {}),
        ...(opts.sso
          ? {
              sso: {
                jwksUrl: opts.sso.jwksUrl,
                issuer: 'https://sso.example.com',
                audience: 'fleetherd-test',
                allow: ['me@example.com'],
                ...(opts.sso.header ? { header: opts.sso.header } : {}),
                from: opts.sso.from ?? ['127.0.0.1/32'],
                ...(opts.sso.password !== undefined ? { password: opts.sso.password } : {}),
              },
            }
          : {}),
      },
    },
    routing: { default: 'cc' },
    access: { allowFrom: opts.allowFrom ?? [] },
  });
}

function writePluginManifest(dir: string, id: string, version = '1.0.0'): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'fleetherd-plugin.json'),
    JSON.stringify({ id, name: id, version })
  );
}

describe('platform/webui/doctor', () => {
  it('fails cleanly when config is unavailable', async () => {
    const en = await checkWebui(null, 'en');
    expect(en).toEqual({ ok: false, detail: 'config unavailable, cannot check the web UI' });

    const zh = await checkWebui(null, 'zh-CN');
    expect(zh.ok).toBe(false);
    expect(zh.detail).toContain('配置不可用');
  });

  it('skips when no webui platform is configured', async () => {
    const cfg = parseConfig({
      version: 1,
      agents: [{ id: 'cc', harness: 'claude' }],
      platforms: {
        dc: { type: 'discord', token: 'discord-test-token' },
      },
      routing: { default: 'cc' },
    });

    const res = await checkWebui(cfg, 'en');
    expect(res).toEqual({ ok: true, detail: 'no webui instance configured; skipped' });
  });

  it('checks owner allowFrom identity and free port without warning when properly configured', async () => {
    const port = await allocateFreePort();
    const okCfg = makeWebuiConfig({ port, allowFrom: ['web:owner'] });
    const okRes = await checkWebui(okCfg, 'en');
    expect(okRes.ok).toBe(true);
    expect(okRes.level).toBeUndefined();
    expect(okRes.detail).toBe(`web: 127.0.0.1:${port} is free`);

    const missingOwnerCfg = makeWebuiConfig({ port, allowFrom: ['dc:user1'] });
    const warnRes = await checkWebui(missingOwnerCfg, 'en');
    expect(warnRes.ok).toBe(true);
    expect(warnRes.level).toBe('warn');
    expect(warnRes.detail).toContain('web: access.allowFrom does not list "web:owner"');
  });

  it('warns when the configured port is already in use or bound to a non-loopback host', async () => {
    const { server, port } = await listenTcp();
    try {
      const cfg = makeWebuiConfig({ host: '127.0.0.1', port });
      const res = await checkWebui(cfg, 'en');
      expect(res.ok).toBe(true);
      expect(res.level).toBe('warn');
      expect(res.detail).toContain(`web: 127.0.0.1:${port} is already in use`);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    const freePort = await allocateFreePort();
    const publicCfg = makeWebuiConfig({ host: '0.0.0.0', port: freePort });
    const publicRes = await checkWebui(publicCfg, 'en');
    expect(publicRes.ok).toBe(true);
    expect(publicRes.level).toBe('warn');
    expect(publicRes.detail).toContain('bound to 0.0.0.0 over plain HTTP');
  });

  it('verifies SSO JWKS keys, password fallback note, and unreachable JWKS errors', async () => {
    const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
    const goodJwks = await startHttpServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ keys: [jwk] }));
    });
    const badJwks = await startHttpServer((_req, res) => {
      res.writeHead(500);
      res.end('upstream error');
    });

    try {
      const port = await allocateFreePort();

      const withPassword = await checkWebui(
        makeWebuiConfig({
          port,
          sso: { jwksUrl: goodJwks.url, header: 'X-Test-Jwt', from: ['127.0.0.1/32'], password: true },
        }),
        'en'
      );
      expect(withPassword.ok).toBe(true);
      expect(withPassword.level).toBeUndefined();
      expect(withPassword.detail).toContain(
        `web: sso reads X-Test-Jwt from 127.0.0.1/32, verified against 1 key(s) at ${goodJwks.url}`
      );
      expect(withPassword.detail).toContain('set sso.password: false');

      const withoutPassword = await checkWebui(
        makeWebuiConfig({
          port,
          sso: { jwksUrl: goodJwks.url, from: ['127.0.0.1/32'], password: false },
        }),
        'en'
      );
      expect(withoutPassword.ok).toBe(true);
      expect(withoutPassword.level).toBeUndefined();
      expect(withoutPassword.detail).toContain('verified against 1 key(s)');
      expect(withoutPassword.detail).not.toContain('sso.password: false');

      const failed = await checkWebui(
        makeWebuiConfig({
          port,
          sso: { jwksUrl: badJwks.url, from: ['127.0.0.1/32'] },
        }),
        'en'
      );
      expect(failed.ok).toBe(true);
      expect(failed.level).toBe('warn');
      expect(failed.detail).toContain(`web: sso cannot read ${badJwks.url} (HTTP 500)`);
    } finally {
      await Promise.all([goodJwks.close(), badJwks.close()]);
    }
  });

  it('rejects plugins inside forbidden roots (agent cwd and files.roots) and reports valid plugins with security notice', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fh-webui-doctor-'));
    try {
      const okPlugin = path.join(dir, 'opt-plugins', 'hello');
      const dupPlugin = path.join(dir, 'opt-plugins', 'hello-dup');
      const agentCwd = path.join(dir, 'agent-cwd');
      const badAgentPlugin = path.join(agentCwd, 'inside-agent');
      const filesRoot = path.join(dir, 'files-root');
      const badFilesPlugin = path.join(filesRoot, 'inside-files');
      const remoteCwd = path.join(dir, 'remote-cwd');
      const underRemoteCwd = path.join(remoteCwd, 'ok-remote');

      writePluginManifest(okPlugin, 'hello-doc', '1.0.0');
      writePluginManifest(dupPlugin, 'hello-doc', '2.0.0');
      writePluginManifest(badAgentPlugin, 'bad-agent', '1.0.0');
      writePluginManifest(badFilesPlugin, 'bad-files', '1.0.0');
      writePluginManifest(underRemoteCwd, 'remote-ok', '1.0.0');

      const port = await allocateFreePort();
      const cfg = makeWebuiConfig({
        port,
        agentCwd,
        remoteHost: { id: 'myhost', cwd: remoteCwd },
        filesRoots: [filesRoot],
        plugins: [
          { path: okPlugin },
          { path: dupPlugin },
          { path: badAgentPlugin },
          { path: badFilesPlugin },
          { path: underRemoteCwd },
        ],
      });

      const summary = inspectWebuiPlugins(
        'web',
        [
          { path: okPlugin },
          { path: dupPlugin },
          { path: badAgentPlugin },
          { path: badFilesPlugin },
          { path: underRemoteCwd },
        ],
        [filesRoot],
        cfg,
        'en'
      );
      expect(summary).toContain('plugins (5)');
      expect(summary).toContain(`${okPlugin} (hello-doc@1.0.0 ✓)`);
      expect(summary).toContain(`${dupPlugin} (✗ duplicate plugin id`);
      expect(summary).toContain(`${badAgentPlugin} (✗`);
      expect(summary).toContain('forbidden root');
      expect(summary).toContain(`${badFilesPlugin} (✗`);
      expect(summary).toContain(`${underRemoteCwd} (remote-ok@1.0.0 ✓)`);
      expect(summary).toContain('no sandbox');

      const res = await checkWebui(cfg, 'en');
      expect(res.ok).toBe(true);
      expect(res.level).toBe('warn');
      expect(res.detail).toContain('hello-doc@1.0.0 ✓');
      expect(res.detail).toContain('forbidden root');
      expect(res.detail).toContain('no sandbox');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
