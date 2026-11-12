import { describe, expect, it } from 'vitest';
import { parseConfig } from './schema.js';

describe('workdir configuration', () => {
  const base = {
    platforms: { tg: { type: 'telegram', token: 't' } },
    agents: [{ id: 'cc', harness: 'opencode' }],
    routing: { default: 'cc' },
  };

  it('defaults to name sort when absent', () => {
    const cfg = parseConfig(base);
    expect(cfg.workdir.sort).toBe('name');
  });

  it('accepts workdir.sort = name', () => {
    const cfg = parseConfig({ ...base, workdir: { sort: 'name' } });
    expect(cfg.workdir.sort).toBe('name');
  });

  it('accepts workdir.sort = frecency', () => {
    const cfg = parseConfig({ ...base, workdir: { sort: 'frecency' } });
    expect(cfg.workdir.sort).toBe('frecency');
  });

  it('accepts workdirSort shorthand', () => {
    const cfg = parseConfig({ ...base, workdirSort: 'frecency' });
    expect(cfg.workdir.sort).toBe('frecency');
  });

  it('workdirSort overrides workdir.sort if both are present', () => {
    const cfg = parseConfig({ ...base, workdir: { sort: 'name' }, workdirSort: 'frecency' });
    expect(cfg.workdir.sort).toBe('frecency');
  });

  it('rejects an invalid sort value', () => {
    expect(() => parseConfig({ ...base, workdir: { sort: 'invalid' } })).toThrow();
    expect(() => parseConfig({ ...base, workdirSort: 'invalid' })).toThrow();
  });
});
