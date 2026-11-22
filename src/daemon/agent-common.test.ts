import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildHarnessEnv, expandHome, prependPath, windowsSpawnOptions } from './agent-common.js';
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
