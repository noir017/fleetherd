import { describe, expect, it, vi } from 'vitest';
import { agyContextWindow, markActivePools, parseAgyUsagePools } from './agy-meters.js';

describe('agyContextWindow', () => {
  it('knows the windows measured off agy’s own status line, in either spelling', () => {
    // agy names a model by id in `init` and by display name on its default; both must resolve.
    expect(agyContextWindow('gemini-3.8-flash-high')).toBe(1_048_576);
    expect(agyContextWindow('Gemini 3.8 Flash (Low)')).toBe(1_048_576);
    expect(agyContextWindow('claude-sonnet-4-6')).toBe(250_000);
    expect(agyContextWindow('Claude Opus 4.6 (Thinking)')).toBe(250_000);
    expect(agyContextWindow('claude-opus-4-6-thinking')).toBe(250_000);
    expect(agyContextWindow('gpt-oss-120b-medium')).toBe(131_072);
    expect(agyContextWindow('GPT-OSS 120B (Medium)')).toBe(131_072);
  });

  it('has no window for a model nobody measured — no guessed denominator', () => {
    // Opus 5.5 was listed by agy for a while (2026-10-03); its window was never read.
    expect(agyContextWindow('claude-opus-5-5-medium')).toBeUndefined();
    expect(agyContextWindow('Some Future Model')).toBeUndefined();
    expect(agyContextWindow(undefined)).toBeUndefined();
    expect(agyContextWindow('')).toBeUndefined();
  });
});

describe('parseAgyUsagePools', () => {
  // Verbatim from `agy -p=/usage` on agy 1.4.7 (2026-10-27).
  const raw = [
    'Gemini Models\tWeekly Limit Remaining\t74%\t2026-10-31T04:24:11Z',
    'Gemini Models\tFive Hour Limit Remaining\t86%\t2026-10-27T06:49:21Z',
    'Claude and GPT models\tWeekly Limit Remaining\t100%\t2026-11-03T06:27:38Z',
    'Claude and GPT models\tFive Hour Limit Remaining\t100%\t2026-10-27T11:27:38Z',
  ].join('\n');

  it('renames the rows to the pool ids the status line used, in its order', () => {
    // The web UI's labels and markActivePools key on `gemini-5h`-shaped ids.
    expect(parseAgyUsagePools(raw)).toEqual([
      { id: '3p-5h', remaining: 1, resetsAt: Date.parse('2026-10-27T11:27:38Z') },
      { id: '3p-weekly', remaining: 1, resetsAt: Date.parse('2026-11-03T06:27:38Z') },
      { id: 'gemini-5h', remaining: 0.86, resetsAt: Date.parse('2026-10-27T06:49:21Z') },
      { id: 'gemini-weekly', remaining: 0.74, resetsAt: Date.parse('2026-10-31T04:24:11Z') },
    ]);
  });

  it('drops a row it cannot name rather than inventing an id for it', () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    const pools = parseAgyUsagePools(`${raw}\nMystery Pool\tMonthly Limit Remaining\t50%\t2026-11-01T00:00:00Z`);
    expect(pools?.map((p) => p.id)).toEqual(['3p-5h', '3p-weekly', 'gemini-5h', 'gemini-weekly']);
    vi.restoreAllMocks();
  });

  it('keeps a pool whose reset time is unreadable, without the time', () => {
    expect(parseAgyUsagePools('Gemini Models\tWeekly Limit Remaining\t50%\tsoon')).toEqual([
      { id: 'gemini-weekly', remaining: 0.5 },
    ]);
  });

  it('has no pools for output that is not the table', () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    expect(parseAgyUsagePools('')).toBeUndefined();
    expect(parseAgyUsagePools('You are currently not signed in.')).toBeUndefined();
    vi.restoreAllMocks();
  });
});

describe('markActivePools', () => {
  const pools = [
    { id: 'gemini-5h', remaining: 1 },
    { id: '3p-5h', remaining: 1 },
    { id: 'tokens', remaining: 1 },
  ];

  it('marks the third-party pools for a Claude or GPT model, the Gemini ones otherwise', () => {
    expect(markActivePools(pools, 'Claude Opus 5.5 (Medium)').map((p) => p.active)).toEqual([false, true, undefined]);
    expect(markActivePools(pools, 'claude-opus-5-5-medium').map((p) => p.active)).toEqual([false, true, undefined]);
    expect(markActivePools(pools, 'Gemini 3.8 Flash (High)').map((p) => p.active)).toEqual([true, false, undefined]);
  });

  it('marks nothing when the model is not known — a guess would be highlighted as fact', () => {
    expect(markActivePools(pools, undefined)).toEqual(pools);
  });
});
