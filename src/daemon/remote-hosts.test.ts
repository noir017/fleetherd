import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../config/schema.js';
import { buildTask } from '../core/schedule.js';
import { normalizeActionPaths } from '../commands/reverse.js';
import { expandRemoteHome, remoteAgentEnv, remoteAgentHome, remoteAgentRoot } from './agent-common.js';
import { remoteClaudeProjectsDir } from './claude-transcript.js';
import { diffConfig } from './config-reload.js';
import { gatewayNamespace, isBridgedCommand } from './remote-hosts.js';
import { workdirScanFrom } from './workdir-scan.js';

/**
 * The daemon's side of agents on remote hosts, short of a connection: config, the namespace, which
 * commands an agent over there may run back here, and how paths and environments are worked out for
 * a machine that is not this one. The connection itself is covered end to end against the real
 * talkcode-remote binary in remote/remote.integration.test.ts.
 */

const cfg = (over: Record<string, unknown> = {}) =>
  parseConfig({
    platforms: { tg: { type: 'telegram', token: 't' } },
    agents: [
      { id: 'cc', harness: 'claude', host: 'box', cwd: '~/work' },
      { id: 'local', harness: 'opencode' },
    ],
    hosts: { box: { ssh: 'me@10.0.0.5:2222' } },
    routing: { default: 'cc' },
    ...over,
  });

const welcome = { version: 'v', instance: 'i', home: '/home/me', pid: 1, os: 'linux', arch: 'arm64', resumed: false };

describe('config: hosts', () => {
  it('accepts agents on a configured host', () => {
    const c = cfg();
    expect(c.hosts?.box?.ssh).toBe('me@10.0.0.5:2222');
    expect(c.agents[0]!.host).toBe('box');
  });

  it('refuses an agent naming a host that is not configured', () => {
    expect(() => cfg({ hosts: {} })).toThrow(/names host \\"box\\", which is not under hosts/);
  });

  it('refuses an ssh destination that would need quoting', () => {
    expect(() => cfg({ hosts: { box: { ssh: 'me@host; rm -rf ~' } } })).toThrow(/user@host/);
    expect(() => cfg({ hosts: { box: { ssh: "me@host'" } } })).toThrow(/user@host/);
  });

  it('refuses an unknown key in a host entry', () => {
    expect(() => cfg({ hosts: { box: { ssh: 'h', port: 22 } } })).toThrow();
  });
});

describe('/reload and hosts', () => {
  it('counts an agent whose host entry changed as changed, so it is respawned', () => {
    const d = diffConfig(cfg(), cfg({ hosts: { box: { ssh: 'me@10.0.0.6' } } }));
    expect(d.agentsChanged).toEqual(['cc']);
    expect(d.sections).toContain('hosts');
  });
});

describe('isBridgedCommand', () => {
  it('lets a remote agent run reverse commands, the tools server and help — nothing else', () => {
    for (const ok of [['send-message', 'hi'], ['send-file', 'x'], ['schedule', 'list'], ['mcp'], ['help'], ['--help']]) {
      expect(isBridgedCommand(ok)).toBe(true);
    }
    for (const no of [[], ['start'], ['setup'], ['doctor'], ['--migrate-config']]) {
      expect(isBridgedCommand(no)).toBe(false);
    }
  });
});

describe('gatewayNamespace', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it('is made once and kept, in a shape a host accepts as a directory name', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-ns-'));
    dirs.push(dir);
    const first = gatewayNamespace(dir);
    expect(first).toMatch(/^g[0-9a-f]{12}$/);
    expect(gatewayNamespace(dir)).toBe(first);
    expect(fs.statSync(path.join(dir, 'remote-id')).mode & 0o777).toBe(0o600);
  });
});

describe('remote paths and environment', () => {
  const def = cfg().agents[0]!;

  it('resolves `~` against the host home, and only once it is known', () => {
    expect(expandRemoteHome('~/work', '/home/me')).toBe('/home/me/work');
    expect(expandRemoteHome('~', '/home/me')).toBe('/home/me');
    expect(expandRemoteHome('/abs', '/home/me')).toBe('/abs');
    expect(expandRemoteHome('~/work', undefined)).toBe('~/work');
  });

  it("gives an agent without a cwd a workspace of its own on the host", () => {
    expect(remoteAgentRoot(def, '/home/me')).toBe('/home/me/work');
    expect(remoteAgentRoot({ ...def, cwd: undefined }, '/home/me')).toBe('/home/me/.talkcode/agents/cc');
  });

  it("sends only the agent's own env block and its token — never this daemon's environment", () => {
    process.env.TC_TEST_SECRET = 's3';
    try {
      const env = remoteAgentEnv({ ...def, env: { API_KEY: '${TC_TEST_SECRET}', HOME: '~/alt' } }, 'tok');
      expect(env).toEqual({ API_KEY: 's3', HOME: '~/alt', TALKCODE_TURN_TOKEN: 'tok' });
      expect(env.PATH).toBeUndefined();
    } finally {
      delete process.env.TC_TEST_SECRET;
    }
  });

  it('honours an env.HOME override when locating the harness state on the host', () => {
    expect(remoteAgentHome(def, welcome)).toBe('/home/me');
    expect(remoteAgentHome({ ...def, env: { HOME: '~/alt' } }, welcome)).toBe('/home/me/alt');
    expect(remoteClaudeProjectsDir(def, welcome)).toBe('/home/me/.claude/projects');
    expect(remoteClaudeProjectsDir({ ...def, env: { CLAUDE_CONFIG_DIR: '~/cc' } }, welcome)).toBe('/home/me/cc/projects');
  });

  it("lists a remote workspace from the host's entries, with POSIX paths", () => {
    const scan = workdirScanFrom(
      '/home/me/work',
      [
        { name: 'zeta', dir: true },
        { name: 'alpha', dir: true },
        { name: 'notes.md', dir: false },
        { name: '.git', dir: true },
        { name: 'node_modules', dir: true },
      ],
      true
    );
    expect(scan).toEqual({
      ok: true,
      truncated: 0,
      options: [
        { path: '/home/me/work', name: 'work', root: true },
        { path: '/home/me/work/alpha', name: 'alpha' },
        { path: '/home/me/work/zeta', name: 'zeta' },
      ],
    });
  });
});

describe('reverse paths from a remote agent', () => {
  afterEach(() => {
    delete process.env.TALKCODE_REMOTE_HOME;
  });

  it("resolves `~` against the agent's host home and relative paths against its directory", () => {
    process.env.TALKCODE_REMOTE_HOME = '/home/me';
    expect(normalizeActionPaths({ kind: 'send-file', path: '~/out.png' }, '/home/me/work')).toMatchObject({ path: '/home/me/out.png' });
    expect(normalizeActionPaths({ kind: 'send-file', path: 'out.png' }, '/home/me/work')).toMatchObject({ path: '/home/me/work/out.png' });
  });
});

describe('scheduled --bash from a remote agent', () => {
  it('records the host, so the command runs where the agent that wrote it runs', () => {
    const built = buildTask(
      { bash: 'make test', at: '+5m' },
      {
        now: Date.UTC(2026, 9, 29, 0, 0),
        id: 't1',
        defaultTz: 'UTC',
        agents: ['cc'],
        from: { key: 'k', platform: 'tg', agent: 'cc', cwd: '/home/me/work', host: 'box' },
        target: { platform: 'tg', address: { channel: 'c' } },
        canOpenTopic: false,
      }
    );
    expect(built.ok && built.task.run).toEqual({ kind: 'bash', command: 'make test', timeoutMs: expect.any(Number), cwd: '/home/me/work', host: 'box' });
  });
});
