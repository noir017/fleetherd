import { describe, expect, it } from 'vitest';
import { en, zhCN, tCli, type CliMessageKey } from './cli.js';
import { newProgram } from '../../commands/program.js';

function placeholdersOf(text: string): string[] {
  const matches = text.match(/\{[a-zA-Z0-9_]+\}/g) ?? [];
  return [...new Set(matches)].sort();
}

describe('core/i18n/cli', () => {
  it('maintains strict key parity between en and zh-CN catalogs', () => {
    const enKeys = Object.keys(en).sort();
    const zhKeys = Object.keys(zhCN).sort();
    expect(zhKeys).toEqual(enKeys);
    expect(enKeys.length).toBeGreaterThan(0);
  });

  it('ensures all entries are non-empty and have matching placeholders', () => {
    const enKeys = Object.keys(en) as CliMessageKey[];
    for (const key of enKeys) {
      expect(en[key].length, `en[${key}] should not be empty`).toBeGreaterThan(0);
      expect(zhCN[key].length, `zhCN[${key}] should not be empty`).toBeGreaterThan(0);

      const enVars = placeholdersOf(en[key]);
      const zhVars = placeholdersOf(zhCN[key]);
      expect(zhVars, `Placeholders for key "${key}" should match between en and zh-CN`).toEqual(enVars);
    }
  });

  it('translates messages with fallback to en when locale is omitted', () => {
    expect(tCli(undefined, 'cli.description')).toBe(en['cli.description']);
    expect(tCli('en', 'cli.description')).toBe(en['cli.description']);
    expect(tCli('zh-CN', 'cli.description')).toBe(zhCN['cli.description']);
  });

  it('interpolates parameters correctly for both locales', () => {
    const params = { socket: '/tmp/test.sock' };
    expect(tCli('en', 'start.daemonRunning', params)).toBe('🚀 fleetherd daemon is running (socket: /tmp/test.sock)');
    expect(tCli('zh-CN', 'start.daemonRunning', params)).toBe('🚀 fleetherd 守护进程已启动 (socket: /tmp/test.sock)');

    const countParams = { count: 3, messages: 12 };
    expect(tCli('en', 'start.historyImported', countParams)).toBe('[history] imported 3 web UI conversation(s), 12 message(s)');
    expect(tCli('zh-CN', 'start.historyImported', countParams)).toBe('[history] 已导入 3 个 Web UI 会话，共 12 条消息');
  });

  it('falls back to key for non-existent keys', () => {
    expect(tCli('en', 'nonexistent.key' as CliMessageKey)).toBe('nonexistent.key');
    expect(tCli('zh-CN', 'nonexistent.key' as CliMessageKey)).toBe('nonexistent.key');
  });

  it('verifies doctor and setup core keys exist and produce localized output', () => {
    expect(tCli('zh-CN', 'setup.prompt.locale')).toBe('语言 / Language:');
    expect(tCli('zh-CN', 'doctor.check.configValid')).toBe('配置文件存在且有效');
    expect(tCli('zh-CN', 'doctor.check.accessControl')).toBe('安全：访问控制');
    expect(tCli('en', 'doctor.check.accessControl')).toBe('Security: access control');
  });

  it('localizes top-level newProgram description and options based on locale', () => {
    const pEn = newProgram('1.0.0', 'en');
    expect(pEn.description()).toBe(en['cli.description']);
    const optEn = pEn.options.find((o) => o.attributeName() === 'config');
    expect(optEn?.description).toBe(en['cli.option.config']);

    const pZh = newProgram('1.0.0', 'zh-CN');
    expect(pZh.description()).toBe(zhCN['cli.description']);
    const optZh = pZh.options.find((o) => o.attributeName() === 'config');
    expect(optZh?.description).toBe(zhCN['cli.option.config']);
  });
});
