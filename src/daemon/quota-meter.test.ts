import { describe, expect, it, vi } from 'vitest';
import type { AgentDef } from '../config/schema.js';
import type { AgyCliRunner } from './agy-cli.js';
import { createQuotaMeter, hasQuotaSource, runQuotaCommand, runQuotaCommandFor, type QuotaCommandRunner } from './quota-meter.js';

const def = (over: Partial<AgentDef> = {}) => ({ id: 'agy', harness: 'agy', env: { HOME: '/h' }, ...over }) as unknown as AgentDef;
const OUT = 'Gemini Models\tWeekly Limit Remaining\t74%\t2026-11-07T04:24:11Z';

describe('createQuotaMeter', () => {
  it('shares one run between callers, and keeps the reading for a minute', async () => {
    const cli = vi.fn<AgyCliRunner>(async () => ({ ok: true, output: OUT }));
    const m = createQuotaMeter({ agy: cli });
    await Promise.all([m.refresh(def(), '/w'), m.refresh(def(), '/w')]);
    await m.refresh(def(), '/w');
    expect(cli).toHaveBeenCalledTimes(1);
    expect(m.read(def())).toEqual([{ id: 'gemini-weekly', remaining: 0.74, resetsAt: Date.parse('2026-11-07T04:24:11Z') }]);
  });

  it('keeps the last reading when a run fails', async () => {
    let fail = false;
    const cli: AgyCliRunner = async () => (fail ? { ok: false, error: 'offline' } : { ok: true, output: OUT });
    vi.useFakeTimers({ now: Date.now() });
    try {
      const m = createQuotaMeter({ agy: cli });
      await m.refresh(def(), '/w');
      fail = true;
      vi.advanceTimersByTime(61_000);
      await m.refresh(def(), '/w');
      expect(m.read(def())?.[0]?.remaining).toBe(0.74);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reads per account: another HOME is another reading', async () => {
    const cli = vi.fn<AgyCliRunner>(async () => ({ ok: true, output: OUT }));
    const m = createQuotaMeter({ agy: cli });
    await m.refresh(def(), '/w');
    expect(m.read(def({ env: { HOME: '/other' } }))).toBeUndefined();
  });

  it('reads quotaCommand instead of agy when one is set, and keys the reading by it', async () => {
    // Through a model gateway agy's own /usage prints nothing, so the command is the only source —
    // agy must not be asked at all, and an agent without the command must not see its reading.
    const cli = vi.fn<AgyCliRunner>(async () => ({ ok: true, output: '' }));
    const command = vi.fn<QuotaCommandRunner>(async () => ({ ok: true, output: OUT }));
    const m = createQuotaMeter({ agy: cli, command });
    const withCommand = def({ quotaCommand: 'cpa-quota' });
    await m.refresh(withCommand, '/w');
    expect(cli).not.toHaveBeenCalled();
    expect(command).toHaveBeenCalledWith('cpa-quota', '/w', expect.any(Object));
    expect(m.read(withCommand)?.[0]?.id).toBe('gemini-weekly');
    expect(m.read(def())).toBeUndefined();
  });

  it('keeps no reading from a command that prints another shape', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const m = createQuotaMeter({ command: async () => ({ ok: true, output: 'all good' }) });
      await m.refresh(def({ quotaCommand: 'x' }), '/w');
      expect(m.read(def({ quotaCommand: 'x' }))).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('hasQuotaSource', () => {
  it('is agy, or any harness with a quotaCommand', () => {
    expect(hasQuotaSource({ harness: 'agy' })).toBe(true);
    expect(hasQuotaSource({ harness: 'claude' })).toBe(false);
    expect(hasQuotaSource({ harness: 'claude', quotaCommand: 'cpa-quota' })).toBe(true);
  });
});

describe('runQuotaCommand', () => {
  it('runs the command in a shell and answers with its stdout', async () => {
    const r = await runQuotaCommand(`printf 'Gemini Models\\tWeekly Limit Remaining\\t%s\\tx\\n' "$Q"; echo noise >&2`, '/', { ...process.env, Q: '74%' });
    expect(r).toEqual({ ok: true, output: 'Gemini Models\tWeekly Limit Remaining\t74%\tx' });
  });

  it('reports a failing command instead of throwing', async () => {
    const r = await runQuotaCommand('exit 3', '/', process.env);
    expect(r.ok).toBe(false);
  });
});

describe('runQuotaCommandFor', () => {
  it('runs the agent’s command here with the agent’s environment', async () => {
    const local = vi.fn<QuotaCommandRunner>(async () => ({ ok: true, output: OUT }));
    const r = await runQuotaCommandFor(def({ quotaCommand: 'cpa-quota', env: { HOME: '/h', CPA_URL: 'u' } }), '/w', local);
    expect(r).toEqual({ ok: true, output: OUT });
    expect(local.mock.calls[0]?.[0]).toBe('cpa-quota');
    expect(local.mock.calls[0]?.[2]['CPA_URL']).toBe('u');
  });

  it('refuses an agent that has none', async () => {
    expect((await runQuotaCommandFor(def(), '/w')).ok).toBe(false);
  });
});
