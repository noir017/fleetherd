import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { runDoctor } from './doctor.js';

describe('commands/doctor i18n', () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    vi.restoreAllMocks();
    process.env = { ...origEnv };
    delete process.env.FLEETHERD_LOCALE;
  });

  afterEach(() => {
    process.env = { ...origEnv };
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

    expect(logs.some((l) => l.includes('无法读取 /tmp/nonexistent-config-file.yaml'))).toBe(true);
  });
});
