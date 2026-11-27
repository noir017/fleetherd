import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentDef } from '../config/schema.js';
import type { Welcome } from '../remote/connection.js';
import type { RemoteHost } from '../remote/host.js';
import { buildAgentEnv, buildHarnessEnv, expandHome, prepareRemoteSpawn, prependPath, windowsSpawnOptions } from './agent-common.js';
import type { AgentProvision } from './provision.js';
import { shellLaunch } from './schedule-bash.js';

describe('buildHarnessEnv', () => {
  it('strips nested Claude session markers but keeps the configured CLI executable', () => {
    const previous = {
      claudeCodeExecutable: process.env.CLAUDE_CODE_EXECUTABLE,
      claudeCodeEntrypoint: process.env.CLAUDE_CODE_ENTRYPOINT,
      claudeCode: process.env.CLAUDECODE,
    };
    process.env.CLAUDE_CODE_EXECUTABLE = '/usr/bin/claude';
    process.env.CLAUDE_CODE_ENTRYPOINT = 'cli';
    process.env.CLAUDECODE = '1';

    try {
      const env = buildHarnessEnv({ id: 'cc', harness: 'claude', args: [], env: {}, permissions: 'auto', options: {} });

      expect(env.CLAUDE_CODE_EXECUTABLE).toBe('/usr/bin/claude');
      expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
      expect(env.CLAUDECODE).toBeUndefined();
    } finally {
      if (previous.claudeCodeExecutable === undefined) delete process.env.CLAUDE_CODE_EXECUTABLE;
      else process.env.CLAUDE_CODE_EXECUTABLE = previous.claudeCodeExecutable;
      if (previous.claudeCodeEntrypoint === undefined) delete process.env.CLAUDE_CODE_ENTRYPOINT;
      else process.env.CLAUDE_CODE_ENTRYPOINT = previous.claudeCodeEntrypoint;
      if (previous.claudeCode === undefined) delete process.env.CLAUDECODE;
      else process.env.CLAUDECODE = previous.claudeCode;
    }
  });
});

describe('Windows compatibility helpers', () => {
  it('prependPath preserves Windows Path casing and avoids duplicate keys', () => {
    const env: Record<string, string | undefined> = { Path: 'C:\\Windows\\System32', PATH: 'C:\\Extra' };
    prependPath(env, 'C:\\Users\\u\\.config\\fleetherd\\bin', ';');
    expect(env.Path).toBe('C:\\Users\\u\\.config\\fleetherd\\bin;C:\\Windows\\System32');
    expect('PATH' in env).toBe(false);
  });

  it('windowsSpawnOptions returns empty on POSIX and enables shell only for .cmd/.bat on win32', () => {
    expect(windowsSpawnOptions('codex-acp', {}, 'linux')).toEqual({});
    expect(windowsSpawnOptions('C:\\tools\\app.exe', {}, 'win32')).toEqual({ windowsHide: true });
    expect(windowsSpawnOptions('C:\\tools\\codex-acp.cmd', {}, 'win32')).toEqual({ shell: true, windowsHide: true });

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fh-win-spawn-'));
    try {
      fs.writeFileSync(path.join(dir, 'codex-acp.CMD'), '@echo off\r\n');
      fs.writeFileSync(path.join(dir, 'opencode.EXE'), '');
      const env = { Path: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' };
      expect(windowsSpawnOptions('codex-acp', env, 'win32')).toEqual({ shell: true, windowsHide: true });
      expect(windowsSpawnOptions('opencode', env, 'win32')).toEqual({ windowsHide: true });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('expandHome handles both ~/ and ~\\', () => {
    expect(expandHome('~/proj')).toBe(path.join(os.homedir(), 'proj'));
    expect(expandHome('~\\proj')).toBe(path.join(os.homedir(), 'proj'));
  });

  it('shellLaunch uses bash -lc on POSIX and ComSpec on win32', () => {
    expect(shellLaunch('echo hi', 'linux', {})).toEqual({
      command: 'bash',
      args: ['-lc', 'echo hi'],
      detached: true,
    });
    expect(shellLaunch('echo hi', 'win32', { ComSpec: 'C:\\Windows\\System32\\cmd.exe' })).toEqual({
      command: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/s', '/c', 'echo hi'],
      detached: false,
      windowsHide: true,
    });
  });
});

describe('agent provision dispatch', () => {
  const def = { id: 'cc', harness: 'claude', args: [], env: { HOME: '/home/me/agent' }, permissions: 'auto', options: {} } as AgentDef;

  it('buildAgentEnv runs injected provisions in order with the agent home', () => {
    const seen: string[] = [];
    const make = (name: string): AgentProvision => ({
      name,
      local: (d, home) => {
        seen.push(`${name}:${d.id}:${home}`);
      },
      remote: async () => {},
    });
    buildAgentEnv(def, 'tok', '/tmp/ipc.sock', [make('first'), make('second')]);
    expect(seen).toEqual(['first:cc:/home/me/agent', 'second:cc:/home/me/agent']);
  });

  it('prepareRemoteSpawn runs injected provisions sequentially with the resolved remote home', async () => {
    const seen: string[] = [];
    const welcome: Welcome = { version: '9.0.0', instance: 'i1', home: '/home/me', pid: 1, os: 'linux', arch: 'amd64', resumed: false };
    const host = {
      id: 'myhost',
      ready: async () => welcome,
      mkdirp: async () => {},
      stat: async () => ({ exists: true, dir: true }),
    } as unknown as RemoteHost;
    const remoteDef = { ...def, host: 'myhost', env: { HOME: '~/alt' } } as AgentDef;
    const make = (name: string): AgentProvision => ({
      name,
      local: () => {},
      remote: async (h, d, home, w) => {
        seen.push(`${name}:${h.id}:${d.id}:${home}:${w.instance}`);
      },
    });
    const res = await prepareRemoteSpawn(remoteDef, host, '/home/me/.fleetherd/agents/cc', [make('first'), make('second')]);
    expect(res.cwd).toBe('/home/me/.fleetherd/agents/cc');
    expect(seen).toEqual(['first:myhost:cc:/home/me/alt:i1', 'second:myhost:cc:/home/me/alt:i1']);
  });
});
