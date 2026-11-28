import { describe, expect, it, vi } from 'vitest';
import { agyCompactionPoint, agyContextWindow, markActivePools, parseAgyUsagePools } from './agy-meters.js';

describe('agyCompactionPoint', () => {
  it('knows where agy compacts, which is well under the model window', () => {
    // Google's model list, read on 1.5.2 (agy-relay.ts): the budget, not the window.
    expect(agyCompactionPoint('gemini-3.8-flash-high')).toBe(256_000);
    expect(agyCompactionPoint('Gemini 3.8 Flash (Low)')).toBe(256_000);
    expect(agyCompactionPoint('claude-sonnet-4-6')).toBe(160_000);
    expect(agyCompactionPoint('Claude Opus 4.6 (Thinking)')).toBe(160_000);
    expect(agyCompactionPoint('gpt-oss-120b-medium')).toBe(80_000);
  });

  it('has no compaction point for a model nobody measured', () => {
    // A Gemini newer than 3.8 has its own budget; 128k was read for older ones and is not a default.
    expect(agyCompactionPoint('gemini-4.0-pro')).toBeUndefined();
    expect(agyCompactionPoint('gemini-2.5-pro')).toBeUndefined();
    expect(agyCompactionPoint('claude-opus-5-5-medium')).toBeUndefined();
    expect(agyCompactionPoint(undefined)).toBeUndefined();
  });
});

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
    // 1M is Gemini 3.8 Flash's window, not every Gemini's.
    expect(agyContextWindow('gemini-4.0-pro')).toBeUndefined();
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

  it('drops a row whose window it cannot name rather than inventing one', () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    const pools = parseAgyUsagePools(`${raw}\nMystery Pool\tMonthly Limit Remaining\t50%\t2026-11-01T00:00:00Z`);
    expect(pools?.map((p) => p.id)).toEqual(['3p-5h', '3p-weekly', 'gemini-5h', 'gemini-weekly']);
    vi.restoreAllMocks();
  });

  it('names any other family after itself, and a Claude subscription’s rows as claude pools', () => {
    const claude = [
      'Claude (alice 12%, bob 40%)\tFive Hour Limit Remaining\t74%\t2026-11-28T15:00:00Z',
      'Claude (alice 30%, bob 50%)\tWeekly Limit Remaining\t60%\t2026-12-02T09:00:00Z',
      'Claude Opus\tWeekly Limit Remaining\t90%\t2026-12-02T09:00:00Z',
      'Claude Sonnet Models\tWeekly Limit Remaining\t95%\t',
      'Mystery Pool\tFive Hour Limit Remaining\t50%\t',
    ].join('\n');
    expect(parseAgyUsagePools(claude)).toEqual([
      { id: 'claude-5h', remaining: 0.74, resetsAt: Date.parse('2026-11-28T15:00:00Z') },
      { id: 'claude-opus-weekly', remaining: 0.9, resetsAt: Date.parse('2026-12-02T09:00:00Z') },
      { id: 'claude-sonnet-weekly', remaining: 0.95 },
      { id: 'claude-weekly', remaining: 0.6, resetsAt: Date.parse('2026-12-02T09:00:00Z') },
      { id: 'mystery-pool-5h', remaining: 0.5 },
    ]);
    // agy's own names keep their ids: Claude next to GPT is agy's third-party pool, not a subscription.
    expect(parseAgyUsagePools('Claude and GPT models\tWeekly Limit Remaining\t100%\t')).toEqual([{ id: '3p-weekly', remaining: 1 }]);
    expect(parseAgyUsagePools('Claude (alice@example.com)\tFive Hour Limit Remaining\t80%\t')).toEqual([
      { id: 'claude-5h', remaining: 0.8, account: 'alice@example.com' },
    ]);
  });

  it('keeps a pool whose reset time is unreadable, without the time', () => {
    expect(parseAgyUsagePools('Gemini Models\tWeekly Limit Remaining\t50%\tsoon')).toEqual([
      { id: 'gemini-weekly', remaining: 0.5 },
    ]);
  });

  it('extracts per-account tags without mistaking aggregated summaries for accounts, and deduplicates rows', () => {
    const multi = [
      'Gemini Models (alice@example.com)\tFive Hour Limit Remaining\t88%\t2026-11-20T15:55:01Z',
      'Gemini Models (alice@example.com)\tWeekly Limit Remaining\t94%\t2026-11-24T10:55:01Z',
      'Gemini Models (bob@example.com)\tFive Hour Limit Remaining\t99%\t2026-11-20T16:30:26Z',
      'Gemini Models (bob@example.com)\tWeekly Limit Remaining\t96%\t2026-11-26T03:30:26Z',
      // Duplicate row for the same account+pool replaces rather than multiplying.
      'Gemini Models (alice@example.com)\tFive Hour Limit Remaining\t85%\t2026-11-20T15:55:01Z',
    ].join('\n');
    expect(parseAgyUsagePools(multi)).toEqual([
      { id: 'gemini-5h', remaining: 0.85, resetsAt: Date.parse('2026-11-20T15:55:01Z'), account: 'alice@example.com' },
      { id: 'gemini-weekly', remaining: 0.94, resetsAt: Date.parse('2026-11-24T10:55:01Z'), account: 'alice@example.com' },
      { id: 'gemini-5h', remaining: 0.99, resetsAt: Date.parse('2026-11-20T16:30:26Z'), account: 'bob@example.com' },
      { id: 'gemini-weekly', remaining: 0.96, resetsAt: Date.parse('2026-11-26T03:30:26Z'), account: 'bob@example.com' },
    ]);
    // Aggregated CPA summary keeps no account field.
    expect(
      parseAgyUsagePools('Gemini Models (alice 100%, bob 62%, carol 0%)\tFive Hour Limit Remaining\t54%\t2026-11-14T08:13:48Z'),
    ).toEqual([{ id: 'gemini-5h', remaining: 0.54, resetsAt: Date.parse('2026-11-14T08:13:48Z') }]);
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

  it('marks a Claude subscription’s per-model pool only for that model, its others for any Claude', () => {
    const claude = [
      { id: 'claude-5h', remaining: 1 },
      { id: 'claude-opus-weekly', remaining: 1 },
      { id: 'claude-sonnet-weekly', remaining: 1 },
      { id: 'claude-fable-weekly', remaining: 1 },
    ];
    expect(markActivePools(claude, 'claude-opus-4-8').map((p) => p.active)).toEqual([true, true, false, false]);
    expect(markActivePools(claude, 'sonnet').map((p) => p.active)).toEqual([true, false, true, false]);
    expect(markActivePools(claude, 'claude-fable-5-2').map((p) => p.active)).toEqual([true, false, false, true]);
    expect(markActivePools(claude, 'default').map((p) => p.active)).toEqual([false, false, false, false]);
  });

  it('marks nothing when the model is not known — a guess would be highlighted as fact', () => {
    expect(markActivePools(pools, undefined)).toEqual(pools);
  });
});
