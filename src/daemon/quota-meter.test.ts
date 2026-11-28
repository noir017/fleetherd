import { describe, expect, it, vi } from 'vitest';
import type { AgentDef } from '../config/schema.js';
import type { AgyCliRunner } from './agy-cli.js';
import { agyQuota } from './harness/agy.js';
import { claudeProbeInterval } from './harness/claude.js';
import type { HarnessQuota, QuotaReading } from './harness/profile.js';
import { createQuotaMeter, hasQuotaSource, runQuotaCommand, runQuotaCommandFor, type QuotaCommandRunner } from './quota-meter.js';
import { extractAccountFromHeaders, parseQuotaOutput, scopeQuotaPools } from './quota-meter.js';

const def = (over: Partial<AgentDef> = {}) => ({ id: 'agy', harness: 'agy', env: { HOME: '/h' }, ...over }) as unknown as AgentDef;
const RESET = '2099-11-07T04:24:11Z';
const OUT = `Gemini Models\tWeekly Limit Remaining\t74%\t${RESET}`;
const agyMeter = (cli: AgyCliRunner, command?: QuotaCommandRunner) =>
  createQuotaMeter({ harnessQuota: (d) => (d.harness === 'agy' ? agyQuota(cli) : undefined), ...(command ? { command } : {}) });

describe('createQuotaMeter', () => {
  it('shares one run between callers, and a run begun in the last ten seconds answers for a new one', async () => {
    const cli = vi.fn<AgyCliRunner>(async () => ({ ok: true, output: OUT }));
    vi.useFakeTimers({ now: Date.parse('2026-11-28T00:00:00Z') });
    try {
      const m = agyMeter(cli);
      await Promise.all([m.refresh(def(), '/w'), m.refresh(def(), '/w')]);
      vi.advanceTimersByTime(9_999);
      await m.refresh(def(), '/w');
      expect(cli).toHaveBeenCalledTimes(1);
      expect(m.read(def())).toEqual([{ id: 'gemini-weekly', remaining: 0.74, resetsAt: Date.parse(RESET) }]);
      vi.advanceTimersByTime(1);
      await m.refresh(def(), '/w');
      expect(cli).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the last reading when a run fails, and says so once per run of failures', async () => {
    let fail = false;
    const cli: AgyCliRunner = async () => (fail ? { ok: false, error: 'offline' } : { ok: true, output: OUT });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    vi.useFakeTimers({ now: Date.parse('2026-11-28T00:00:00Z') });
    try {
      const m = agyMeter(cli);
      await m.refresh(def(), '/w');
      fail = true;
      vi.advanceTimersByTime(11_000);
      await m.refresh(def(), '/w');
      vi.advanceTimersByTime(11_000);
      await m.refresh(def(), '/w');
      expect(m.read(def())?.[0]?.remaining).toBe(0.74);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(debug).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
      warn.mockRestore();
      debug.mockRestore();
    }
  });

  it('leaves out a window past its reset, which has refilled since it was read', async () => {
    const m = agyMeter(async () => ({ ok: true, output: 'Gemini Models\tWeekly Limit Remaining\t74%\t2020-01-01T00:00:00Z' }));
    await m.refresh(def(), '/w');
    expect(m.read(def())).toEqual([]);
  });

  it('reads per account: another HOME is another reading', async () => {
    const cli = vi.fn<AgyCliRunner>(async () => ({ ok: true, output: OUT }));
    const m = agyMeter(cli);
    await m.refresh(def(), '/w');
    expect(m.read(def({ env: { HOME: '/other' } }))).toBeUndefined();
  });

  it('reads quotaCommand instead of the harness’s own source when one is set, and keys the reading by it', async () => {
    // Through a model gateway agy's own /usage prints nothing, so the command is the only source —
    // agy must not be asked at all, and an agent without the command must not see its reading.
    const cli = vi.fn<AgyCliRunner>(async () => ({ ok: true, output: '' }));
    const command = vi.fn<QuotaCommandRunner>(async () => ({ ok: true, output: OUT }));
    const m = agyMeter(cli, command);
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

describe('createQuotaMeter: a harness source with an interval of its own (claude’s relay probe)', () => {
  const cc = (over: Partial<AgentDef> = {}) => def({ id: 'cc', harness: 'claude', ...over });
  const later = Date.parse('2099-01-01T00:00:00Z');
  const POOLS = [{ id: 'claude-5h', remaining: 0.6, resetsAt: later }];
  const rig = (reading: () => Promise<QuotaReading>) => {
    const read = vi.fn<HarnessQuota['read']>(reading);
    const source: HarnessQuota = { read, key: (d) => `agent:${d.id}`, interval: (f) => claudeProbeInterval(f, () => 0.5) };
    return { read, m: createQuotaMeter({ harnessQuota: (d) => (d.harness === 'claude' ? source : undefined) }) };
  };

  it('reads only when a session asks, and then not again until its interval has passed', async () => {
    const { read, m } = rig(async () => ({ ok: true, pools: POOLS }));
    vi.useFakeTimers({ now: Date.parse('2026-11-28T00:00:00Z') });
    try {
      // No session asking — no turn — is no read, however long it has been.
      vi.advanceTimersByTime(3_600_000);
      expect(read).not.toHaveBeenCalled();
      await Promise.all([m.refresh(cc(), '/w'), m.refresh(cc(), '/w')]);
      expect(read).toHaveBeenCalledTimes(1);
      expect(m.read(cc())).toEqual(POOLS);
      vi.advanceTimersByTime(10 * 60_000 - 1);
      await m.refresh(cc(), '/w');
      expect(read).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1);
      await m.refresh(cc(), '/w');
      expect(read).toHaveBeenCalledTimes(2);
      // Keyed by the agent: another claude agent is another source.
      expect(m.read(cc({ id: 'cc2' }))).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('backs off after a failure instead of retrying every turn', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { read, m } = rig(async () => ({ ok: false, reason: 'probe answered HTTP 502' }));
    vi.useFakeTimers({ now: Date.parse('2026-11-28T00:00:00Z') });
    try {
      await m.refresh(cc(), '/w');
      vi.advanceTimersByTime(15 * 60_000 - 1);
      await m.refresh(cc(), '/w');
      expect(read).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1);
      await m.refresh(cc(), '/w');
      expect(read).toHaveBeenCalledTimes(2);
      vi.advanceTimersByTime(30 * 60_000 - 1);
      await m.refresh(cc(), '/w');
      expect(read).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
      warn.mockRestore();
    }
  });

  it('stops asking a source that said there is nothing to read, until the agent is redefined', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { read, m } = rig(async () => ({ ok: false, final: true, reason: 'no ANTHROPIC_BASE_URL' }));
    vi.useFakeTimers({ now: Date.parse('2026-11-28T00:00:00Z') });
    try {
      const agent = cc();
      await m.refresh(agent, '/w');
      vi.advanceTimersByTime(86_400_000);
      await m.refresh(agent, '/w');
      expect(read).toHaveBeenCalledTimes(1);
      await m.refresh(cc(), '/w');
      expect(read).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
      warn.mockRestore();
    }
  });

  it('stands down for an agent whose harness reports its quota by itself, merging the reports pool by pool', async () => {
    const { read, m } = rig(async () => ({ ok: true, pools: POOLS }));
    m.record(cc(), [{ id: 'claude-weekly', remaining: 0.9, resetsAt: later }]);
    m.record(cc(), [{ id: 'claude-5h', remaining: 0.5, resetsAt: later }]);
    m.record(cc(), [{ id: 'claude-weekly', remaining: 0.8, resetsAt: later }]);
    await m.refresh(cc(), '/w');
    expect(read).not.toHaveBeenCalled();
    expect(m.read(cc())).toEqual([
      { id: 'claude-5h', remaining: 0.5, resetsAt: later },
      { id: 'claude-weekly', remaining: 0.8, resetsAt: later },
    ]);
  });

  it('ignores reports from an agent with a quotaCommand, whose command is its quota', async () => {
    const command = vi.fn<QuotaCommandRunner>(async () => ({ ok: true, output: OUT }));
    const m = createQuotaMeter({ command });
    const withCommand = cc({ quotaCommand: 'pool-quota' });
    m.record(withCommand, [{ id: 'claude-5h', remaining: 0.1 }]);
    expect(m.read(withCommand)).toBeUndefined();
    await m.refresh(withCommand, '/w');
    expect(m.read(withCommand)?.map((p) => p.id)).toEqual(['gemini-weekly']);
  });
});

describe('claudeProbeInterval', () => {
  it('is 8–12 minutes at random, and backs off from 15 minutes to 2 hours after failures', () => {
    expect(claudeProbeInterval(0, () => 0)).toBe(8 * 60_000);
    expect(claudeProbeInterval(0, () => 0.999999)).toBeCloseTo(12 * 60_000, -2);
    expect([1, 2, 3, 4, 5].map((f) => claudeProbeInterval(f) / 60_000)).toEqual([15, 30, 60, 120, 120]);
  });
});

describe('hasQuotaSource', () => {
  it('is a harness with a source of its own (agy, claude), or any harness with a quotaCommand', () => {
    expect(hasQuotaSource({ harness: 'agy' })).toBe(true);
    expect(hasQuotaSource({ harness: 'claude' })).toBe(true);
    expect(hasQuotaSource({ harness: 'codex' })).toBe(false);
    expect(hasQuotaSource({ harness: 'codex', quotaCommand: 'cpa-quota' })).toBe(true);
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

describe('parseQuotaOutput', () => {
  it('parses generic JSON pool arrays with ISO or epoch reset times', () => {
    const json = JSON.stringify([
      { id: 'gemini-weekly', remaining: 0.98, resetsAt: '2026-11-24T10:55:01Z' },
      { id: 'custom-1h', remaining: 0.5, resetsAt: 1795172100000 },
    ]);
    expect(parseQuotaOutput(json)).toEqual([
      { id: 'custom-1h', remaining: 0.5, resetsAt: 1795172100000 },
      { id: 'gemini-weekly', remaining: 0.98, resetsAt: Date.parse('2026-11-24T10:55:01Z') },
    ]);
  });

  it('falls back to TSV parsing for agy-shaped tables including 1h windows', () => {
    expect(parseQuotaOutput('Gemini Models\tOne Hour Limit Remaining\t80%\t2026-11-20T11:00:00Z')).toEqual([
      { id: 'gemini-1h', remaining: 0.8, resetsAt: Date.parse('2026-11-20T11:00:00Z') },
    ]);
  });

  it('preserves account/profile in JSON output and deduplicates per account', () => {
    const json = JSON.stringify([
      { id: 'gemini-5h', remaining: 0.88, profile: 'alice@example.com' },
      { id: 'gemini-5h', remaining: 0.99, account: 'bob@example.com' },
      { id: 'gemini-5h', remaining: 0.8, profile: 'alice@example.com' },
    ]);
    expect(parseQuotaOutput(json)).toEqual([
      { id: 'gemini-5h', remaining: 0.8, account: 'alice@example.com' },
      { id: 'gemini-5h', remaining: 0.99, account: 'bob@example.com' },
    ]);
  });
});

describe('scopeQuotaPools', () => {
  const POOLS = [
    { id: 'gemini-5h', remaining: 0.88, account: 'alice@example.com' },
    { id: 'gemini-weekly', remaining: 0.94, account: 'alice@example.com' },
    { id: 'gemini-5h', remaining: 0.99, account: 'bob@example.com' },
    { id: 'gemini-weekly', remaining: 0.96, account: 'bob@example.com' },
  ];

  it('filters multi-account pools to the session’s active account', () => {
    const opts = [{ id: 'account', name: 'Account', current: 'bob@example.com', options: [{ value: 'bob@example.com', name: 'bob@example.com' }] }];
    expect(scopeQuotaPools(POOLS, opts)).toEqual([
      { id: 'gemini-5h', remaining: 0.99, account: 'bob@example.com' },
      { id: 'gemini-weekly', remaining: 0.96, account: 'bob@example.com' },
    ]);
  });

  it('returns empty when the session’s active account has not reported yet, instead of another account’s quota', () => {
    const opts = [{ id: 'account', name: 'Account', current: 'carol@example.com', options: [{ value: 'carol@example.com', name: 'carol@example.com' }] }];
    expect(scopeQuotaPools(POOLS, opts)).toEqual([]);
  });

  it('passes through pools with no account tags or when no account option exists', () => {
    const plain = [{ id: 'gemini-5h', remaining: 0.5 }];
    expect(scopeQuotaPools(plain, [])).toEqual(plain);
    expect(scopeQuotaPools(POOLS, [])).toEqual(POOLS);
  });

  it('matches observed upstream accountKey/account and hides multi-account pools before first observation when required', () => {
    const keyed = parseQuotaOutput(
      JSON.stringify([
        { id: 'gemini-5h', remaining: 0.65, account: 'alice@example.com', accountKey: 'idx-a' },
        { id: 'gemini-5h', remaining: 0.88, account: 'bob@example.com', accountKey: 'idx-b' },
      ])
    )!;
    expect(scopeQuotaPools(keyed, [], undefined, true)).toEqual([]);
    expect(scopeQuotaPools(keyed, [], 'idx-a', true)).toEqual([
      { id: 'gemini-5h', remaining: 0.65, account: 'alice@example.com', accountKey: 'idx-a' },
    ]);
    expect(
      extractAccountFromHeaders(
        { 'x-cpa-trace-id': '20261128220431-idx-a-01a22278' },
        { header: 'X-CPA-TRACE-ID', pattern: '^[^-]+-([^-]+-[^-]+)-' }
      )
    ).toBe('idx-a');
    expect(
      extractAccountFromHeaders(
        { 'x-cpa-trace-id': '20261128220431-79275454af114a4a-01a22278' },
        { header: 'X-CPA-TRACE-ID', pattern: '^[^-]+-([^-]+)-' }
      )
    ).toBe('79275454af114a4a');
  });
});
