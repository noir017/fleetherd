import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { locateCommand, runDoctor } from './doctor.js';

describe('commands/doctor i18n', () => {
  const origEnv = { ...process.env };
  // Restore values in place: assigning a new object to process.env detaches it from the real
  // environment that os.tmpdir()/os.homedir() read, for every later file in this worker.
  const restoreEnv = (): void => {
    for (const k of Object.keys(process.env)) if (!(k in origEnv)) delete process.env[k];
    Object.assign(process.env, origEnv);
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    restoreEnv();
    delete process.env.FLEETHERD_LOCALE;
  });

  afterEach(() => {
    restoreEnv();
    process.exitCode = undefined;
  });

  it('prints identity and checks in English by default', async () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((msg: string) => {
      logs.push(msg);
    });

    await runDoctor();

    expect(logs.some((l) => l.includes('description: Gateway connecting IM platforms to coding agents'))).toBe(true);
    expect(logs.some((l) => l.includes('Config file exists and is valid'))).toBe(true);
  });

  it('prints identity and checks in zh-CN when FLEETHERD_LOCALE=zh-CN', async () => {
    process.env.FLEETHERD_LOCALE = 'zh-CN';
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((msg: string) => {
      logs.push(msg);
    });

    await runDoctor();

    expect(logs.some((l) => l.includes('description: 连接 IM 聊天平台与 Coding Agent 的网关'))).toBe(true);
    expect(logs.some((l) => l.includes('配置文件存在且有效'))).toBe(true);
  });

  it('localizes migrate-config failure message in zh-CN', async () => {
    process.env.FLEETHERD_LOCALE = 'zh-CN';
    process.env.FLEETHERD_CONFIG_FILE = '/tmp/nonexistent-config-file.yaml';
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((msg: string) => {
      logs.push(msg);
    });

    await runDoctor({ migrateConfig: true });

    const expected = path.resolve('/tmp/nonexistent-config-file.yaml');
    expect(logs.some((l) => l.includes(`无法读取 ${expected}`))).toBe(true);
  });

  it('lists configured webui plugins with status and security notice', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fh-doctor-plugins-'));
    try {
      const okPlugin = path.join(dir, 'opt-plugins', 'hello');
      fs.mkdirSync(okPlugin, { recursive: true });
      fs.writeFileSync(
        path.join(okPlugin, 'fleetherd-plugin.json'),
        JSON.stringify({ id: 'hello-doc', name: 'Hello', version: '1.0.0' })
      );
      const agentCwd = path.join(dir, 'agent-cwd');
      const badPlugin = path.join(agentCwd, 'inside-agent');
      fs.mkdirSync(badPlugin, { recursive: true });
      fs.writeFileSync(
        path.join(badPlugin, 'fleetherd-plugin.json'),
        JSON.stringify({ id: 'bad-doc', name: 'Bad', version: '1.0.0' })
      );
      const cfgFile = path.join(dir, 'config.yaml');
      fs.writeFileSync(
        cfgFile,
        [
          'version: 1',
          'agents:',
          '  - id: claude',
          '    harness: claude',
          `    cwd: ${agentCwd}`,
          'platforms:',
          '  web:',
          '    type: webui',
          '    token: test-token',
          '    host: 127.0.0.1',
          '    port: 18787',
          '    plugins:',
          `      - path: ${okPlugin}`,
          `      - path: ${badPlugin}`,
          'routing:',
          '  default: claude',
        ].join('\n')
      );
      process.env.FLEETHERD_CONFIG_FILE = cfgFile;
      const logs: string[] = [];
      vi.spyOn(console, 'log').mockImplementation((msg: string) => {
        logs.push(msg);
      });

      await runDoctor();

      const webuiLine = logs.find((l) => l.includes('Web UI'));
      expect(webuiLine).toBeDefined();
      expect(webuiLine).toContain('hello-doc@1.0.0 ✓');
      expect(webuiLine).toContain('forbidden root');
      expect(webuiLine).toContain('no sandbox');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('locateCommand', () => {
  it('resolves PATHEXT shims and case-insensitive Path on win32', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fh-locate-'));
    try {
      const cmdFile = path.join(dir, 'codex-acp.CMD');
      fs.writeFileSync(cmdFile, '@echo off\r\n');
      const env = { Path: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' };
      expect(locateCommand('codex-acp', env, 'win32')).toBe(cmdFile);
      expect(locateCommand('missing-tool', env, 'win32')).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
