import { describe, expect, it } from 'vitest';
import {
  bashResultText,
  buildTask,
  CATCH_UP_GRACE_MS,
  decide,
  FIXED_SESSION_WINDOW_MS,
  formatDay,
  formatInZone,
  nextRunOf,
  parseAt,
  taskCardText,
  taskView,
  zonedToEpoch,
  type BashOutcome,
  type NewTaskContext,
  type ScheduleTask,
} from './schedule.js';

/**
 * The scheduling decisions, with the clock passed in. What is pinned hardest is what would be
 * silent if wrong: a run made twice after a restart, a burst of catch-up runs, a fixed-session task
 * that outlives its window, and a time read in the wrong zone.
 */

const SH = 'Asia/Shanghai';
/** 2026-09-30 10:00 in Shanghai. */
const NOW = Date.UTC(2026, 8, 30, 2, 0, 0);
const MIN = 60_000;
const HOUR = 3_600_000;

const ctx = (over: Partial<NewTaskContext> = {}): NewTaskContext => ({
  now: NOW,
  id: 'a1b2c3',
  defaultTz: SH,
  agents: ['cc', 'oc'],
  from: { key: 'web#main#t1', platform: 'web', agent: 'cc', cwd: '/work' },
  target: { platform: 'web', address: { channel: 'main', thread: 't1' } },
  targetConversation: { key: 'web#main#t1', agent: 'cc' },
  canOpenTopic: true,
  ...over,
});

const built = (input: Parameters<typeof buildTask>[0], c = ctx()): ScheduleTask => {
  const r = buildTask(input, c);
  if (!r.ok) throw new Error(r.error);
  return r.task;
};

const refusal = (input: Parameters<typeof buildTask>[0], c = ctx()): string => {
  const r = buildTask(input, c);
  if (r.ok) throw new Error('expected a refusal');
  return r.error;
};

describe('time in a zone', () => {
  it('reads a wall-clock time in the task\'s zone, not the host\'s', () => {
    expect(zonedToEpoch(2026, 10, 1, 8, 0, 0, SH)).toBe(Date.UTC(2026, 9, 1, 0, 0, 0));
    expect(formatInZone(Date.UTC(2026, 9, 1, 0, 0, 0), SH)).toBe('2026-10-01 08:00');
  });

  it('shows seconds when a time is not on a minute, so +2m does not read as minute-precision', () => {
    // Observed 2026-09-30: `11:28` for a run due at 11:28:28 led the registering agent to tell the
    // user the task would fire early.
    expect(formatInZone(NOW + 28_000, SH)).toBe('2026-09-30 10:00:28');
  });

  it('gets a DST day right on both sides of the change', () => {
    // New York springs forward on 2026-03-08: 01:30 is EST (-5), 03:30 is EDT (-4).
    expect(zonedToEpoch(2026, 3, 8, 1, 30, 0, 'America/New_York')).toBe(Date.UTC(2026, 2, 8, 6, 30));
    expect(zonedToEpoch(2026, 3, 8, 3, 30, 0, 'America/New_York')).toBe(Date.UTC(2026, 2, 8, 7, 30));
  });

  it('names the local day in the task\'s own zone, not UTC or the host\'s', () => {
    // 23:30 UTC on 2026-10-01 is already 07:30 on the 2nd in Shanghai, and still 19:30 on the
    // 1st in New York. A daily task's topic key must follow its own tz.
    const late = Date.UTC(2026, 9, 1, 23, 30);
    expect(formatDay(late, 'Asia/Shanghai')).toBe('2026-10-02');
    expect(formatDay(late, 'America/New_York')).toBe('2026-10-01');
    expect(formatDay(late, 'UTC')).toBe('2026-10-01');
    // A catch-up run belongs to the day of its PLANNED time, even when it is made after midnight.
    expect(formatDay(Date.UTC(2026, 9, 1, 23, 30), 'Asia/Shanghai')).toBe('2026-10-02');
  });

  it.each([
    ['+30m', NOW + 30 * MIN],
    ['+2h', NOW + 2 * HOUR],
    ['+1d', NOW + 24 * HOUR],
    ['2026-10-01 08:00', Date.UTC(2026, 9, 1, 0, 0)],
    ['2026-10-01T08:00', Date.UTC(2026, 9, 1, 0, 0)],
    // Zoneless ISO is a wall-clock time in --tz, never silently UTC.
    ['2026-10-01T08:00:00', Date.UTC(2026, 9, 1, 0, 0)],
    ['2026-10-01T00:00:00Z', Date.UTC(2026, 9, 1, 0, 0)],
    ['2026-10-01T08:00:00+08:00', Date.UTC(2026, 9, 1, 0, 0)],
    // A bare clock time is the next time the clock reads it: 11:00 is later today, 08:00 tomorrow.
    ['11:00', Date.UTC(2026, 8, 30, 3, 0)],
    ['08:00', Date.UTC(2026, 9, 1, 0, 0)],
  ])('parses --at %j', (raw, want) => {
    expect(parseAt(raw, SH, NOW)).toBe(want);
  });

  it.each(['tomorrow', '2026-10-01', '25:00', '2026-13-01 08:00', '2026-10-01T08:00:00.000'])(
    'refuses %j rather than guessing',
    (raw) => {
      expect(parseAt(raw, SH, NOW)).toBeUndefined();
    }
  );
});

describe('buildTask', () => {
  it('a fixed-session task runs in the registering topic, with its agent, for 24 hours', () => {
    const t = built({ cron: '*/30 * * * *', prompt: 'check CI' });
    expect(t.run).toEqual({ kind: 'agent', agent: 'cc', prompt: 'check CI', session: 'fixed' });
    expect(t.conversation).toBe('web#main#t1');
    expect(t.expiresAt).toBe(NOW + FIXED_SESSION_WINDOW_MS);
    expect(t.target).toEqual({ platform: 'web', channel: 'main', thread: 't1' });
  });

  it('refuses a fixed-session one-shot beyond the 24-hour window, naming the way out', () => {
    expect(refusal({ at: '+25h', prompt: 'x' })).toMatch(/only lives 24h.*--session new/);
    expect(built({ at: '+23h', prompt: 'x' }).expiresAt).toBe(NOW + FIXED_SESSION_WINDOW_MS);
  });

  it('refuses a fixed-session cron with no run inside the window', () => {
    // The 5th of the month is days away; the window is 24h.
    expect(refusal({ cron: '0 8 5 * *', prompt: 'x' })).toMatch(/no run before then/);
  });

  it('refuses a fixed-session task for an agent the topic is not answered by', () => {
    expect(refusal({ cron: '0 * * * *', prompt: 'x', agent: 'oc' })).toMatch(/answered by cc.*--session new to run oc/);
  });

  it('a new-session task has no window and keeps the registering directory', () => {
    const t = built({ cron: '0 8 * * *', prompt: 'morning brief', session: 'new', agent: 'oc' });
    expect(t.expiresAt).toBeUndefined();
    expect(t.conversation).toBeUndefined();
    expect(t.run).toEqual({ kind: 'agent', agent: 'oc', prompt: 'morning brief', session: 'new', cwd: '/work' });
  });

  it('a daily-session task takes a cron, an agent, a directory and no window', () => {
    const t = built({ cron: '0 8 * * *', prompt: 'morning brief', session: 'daily', agent: 'oc' });
    expect(t.expiresAt).toBeUndefined();
    expect(t.conversation).toBeUndefined();
    expect(t.daySession).toBeUndefined();
    expect(t.run).toEqual({ kind: 'agent', agent: 'oc', prompt: 'morning brief', session: 'daily', cwd: '/work' });
    expect(taskCardText(t, 'registered', NOW)).toContain('oc · one session a day');
  });

  it('refuses a daily one-shot and a daily bash task, each naming why', () => {
    expect(refusal({ at: '+1h', prompt: 'x', session: 'daily' })).toMatch(/needs --cron.*no rest of the day.*--session new/);
    expect(refusal({ cron: '0 8 * * *', bash: 'true', session: 'daily' })).toMatch(/--session daily is for --prompt tasks.*run by the daemon/);
  });

  it('a new-session task can name its model', () => {
    const t = built({ cron: '0 8 * * *', prompt: 'brief', session: 'new', model: ' deepseek-v4-flash ' });
    expect(t.run).toEqual({ kind: 'agent', agent: 'cc', prompt: 'brief', session: 'new', cwd: '/work', model: 'deepseek-v4-flash' });
    expect(taskCardText(t, 'registered', NOW)).toContain('cc · deepseek-v4-flash · new session each run');
    expect(taskView(t, NOW, { detail: true })).toMatchObject({ model: 'deepseek-v4-flash' });
  });

  it('a daily-session task can name its model', () => {
    const t = built({ cron: '0 8 * * *', prompt: 'brief', session: 'daily', model: 'deepseek-v4-pro' });
    expect(t.run).toMatchObject({ session: 'daily', model: 'deepseek-v4-pro' });
    expect(taskCardText(t, 'registered', NOW)).toContain('cc · deepseek-v4-pro · one session a day');
  });

  it('refuses --model on a fixed-session task and on a bash task, each naming why', () => {
    expect(refusal({ cron: '0 * * * *', prompt: 'x', model: 'deepseek-v4-flash' })).toMatch(
      /fixed-session.*\/model there.*--session new or --session daily/s
    );
    expect(refusal({ cron: '0 3 * * *', bash: 'ls', model: 'deepseek-v4-flash' })).toMatch(/--model is for --prompt tasks/);
  });

  it('refuses an empty --model rather than passing it on', () => {
    expect(refusal({ cron: '0 8 * * *', prompt: 'x', session: 'new', model: '   ' })).toMatch(/--model is empty/);
  });

  it('refuses a daily task where no topic can be opened, rather than falling back to a throwaway', () => {
    expect(refusal({ cron: '0 8 * * *', prompt: 'x', session: 'daily' }, ctx({ canOpenTopic: false }))).toMatch(
      /needs a target that can open a topic.*--session new/
    );
  });

  it('refuses a daily task for an unknown agent, like new', () => {
    expect(refusal({ cron: '0 8 * * *', prompt: 'x', session: 'daily', agent: 'zz' })).toMatch(/unknown agent "zz"/);
  });

  it('a bash task takes a timeout and no agent', () => {
    const t = built({ cron: '0 3 * * *', bash: 'du -sh /data', timeoutMs: 60_000 });
    expect(t.run).toEqual({ kind: 'bash', command: 'du -sh /data', timeoutMs: 60_000, cwd: '/work' });
    expect(refusal({ cron: '0 3 * * *', bash: 'ls', agent: 'cc' })).toMatch(/--agent and --session are for --prompt/);
    expect(refusal({ cron: '0 3 * * *', prompt: 'x', timeoutMs: 5_000 })).toMatch(/--timeout is for --bash/);
  });

  it.each([
    [{ prompt: 'x' }, /exactly one of --cron/],
    [{ cron: '0 8 * * *', at: '+1h', prompt: 'x' }, /exactly one of --cron/],
    [{ cron: '0 8 * * *' }, /exactly one of --prompt/],
    [{ cron: '0 8 * * * *', prompt: 'x' }, /not a 5-field cron/],
    [{ cron: '61 8 * * *', prompt: 'x' }, /--cron:/],
    [{ cron: '0 8 * * *', prompt: 'x', tz: 'Mars/Base' }, /unknown time zone "Mars\/Base"/],
    [{ at: 'soon', prompt: 'x' }, /not a time I can read/],
    [{ at: '2026-09-29 08:00', prompt: 'x' }, /already in the past/],
    [{ cron: '0 8 * * *', prompt: 'x', session: 'new' as const, agent: 'zz' }, /unknown agent "zz"; configured: cc, oc/],
  ])('refuses %j with a sentence naming the fix', (input, why) => {
    expect(refusal(input)).toMatch(why);
  });

  it('names the task from its prompt when no --name is given', () => {
    expect(built({ cron: '0 * * * *', prompt: 'summarise   the\nnews' }).name).toBe('summarise the news');
  });
});

describe('decide', () => {
  const daily = (): ScheduleTask => built({ cron: '0 8 * * *', prompt: 'x', session: 'new' });
  const at8 = Date.UTC(2026, 9, 1, 0, 0); // 2026-10-01 08:00 Shanghai

  it('waits for the next planned time', () => {
    expect(decide(daily(), NOW)).toEqual({ kind: 'wait', at: at8 });
    expect(nextRunOf(daily(), NOW)).toBe(at8);
  });

  it('runs when due, and not again once that planned time is recorded', () => {
    const t = daily();
    expect(decide(t, at8 + 1_000)).toEqual({ kind: 'run', planned: at8 });
    t.lastPlannedAt = at8;
    expect(decide(t, at8 + 2_000)).toEqual({ kind: 'wait', at: at8 + 24 * HOUR });
  });

  it('catches up once inside the grace after downtime, and records a miss beyond it', () => {
    expect(decide(daily(), at8 + CATCH_UP_GRACE_MS - 1)).toEqual({ kind: 'run', planned: at8 });
    expect(decide(daily(), at8 + CATCH_UP_GRACE_MS + 1)).toEqual({ kind: 'missed', planned: at8 });
  });

  it('makes one run, the latest, after missing several — never a burst', () => {
    const t = built({ cron: '* * * * *', bash: 'true' });
    expect(decide(t, NOW + 10 * MIN + 5_000)).toEqual({ kind: 'run', planned: NOW + 10 * MIN });
  });

  it('a one-shot is done once its run is recorded', () => {
    const t = built({ at: '+1h', prompt: 'x', session: 'new' });
    expect(decide(t, NOW + HOUR)).toEqual({ kind: 'run', planned: NOW + HOUR });
    t.lastPlannedAt = NOW + HOUR;
    expect(decide(t, NOW + HOUR + 1)).toEqual({ kind: 'done' });
  });

  it('a fixed-session task stops at its window: waits for the end, then expires', () => {
    const t = built({ cron: '0 */6 * * *', prompt: 'x' }); // 12:00, 18:00, 00:00, 06:00 inside the window
    t.lastPlannedAt = Date.UTC(2026, 8, 30, 22, 0); // 06:00 next day handled
    expect(decide(t, t.lastPlannedAt + 1)).toEqual({ kind: 'wait', at: t.expiresAt });
    expect(decide(t, t.expiresAt!)).toEqual({ kind: 'expire' });
    expect(nextRunOf(t, t.lastPlannedAt + 1)).toBeUndefined();
  });
});

describe('taskCardText', () => {
  it('says what will run, when, where, and how to manage it', () => {
    const card = taskCardText(built({ cron: '0 8 * * *', prompt: 'morning brief', session: 'new' }), 'registered', NOW);
    expect(card).toContain('`#a1b2c3`');
    expect(card).toContain('`0 8 * * *` (Asia/Shanghai) · next 2026-10-01 08:00');
    expect(card).toContain('cc · new session each run');
    expect(card).toContain('`web:main/t1`');
    expect(card).toContain('morning brief');
    expect(card).toContain('/setting schedule');
  });

  it('shows a fixed-session task\'s end', () => {
    expect(taskCardText(built({ cron: '0 * * * *', prompt: 'x' }), 'registered', NOW)).toContain('until 2026-10-01 10:00');
  });

  it('does not repeat a one-shot\'s time as its "next" run', () => {
    const card = taskCardText(built({ at: '+2m', bash: 'date' }), 'registered', NOW);
    expect(card).toContain('• When: once at 2026-09-30 10:02 (Asia/Shanghai)\n');
    expect(card).not.toContain('next');
  });
});

describe('bashResultText', () => {
  const t = (): ScheduleTask => built({ cron: '0 3 * * *', bash: 'backup.sh', name: 'backup' });
  const outcome = (over: Partial<BashOutcome> = {}): BashOutcome => ({
    exitCode: 0,
    timedOut: false,
    aborted: false,
    tail: 'done\n',
    bytes: 5,
    durationMs: 3_200,
    ...over,
  });

  it('says the exit code and duration, with the output fenced', () => {
    const { text, attach } = bashResultText(t(), outcome(), 600_000);
    expect(text).toBe('⏰ `#a1b2c3` **backup** · ✅ exit 0 · 3.2s\n```\ndone\n```');
    expect(attach).toBe(false);
  });

  it('fences output that itself contains a fence with a longer one', () => {
    const { text } = bashResultText(t(), outcome({ tail: 'a\n```\nb', bytes: 9 }), 600_000);
    expect(text).toContain('\n````\na\n```\nb\n````');
  });

  it('keeps the end of long output inline and asks for the log to be attached', () => {
    const tail = 'x'.repeat(5_000) + 'END';
    const { text, attach } = bashResultText(t(), outcome({ tail, bytes: 90_000 }), 600_000);
    expect(attach).toBe(true);
    expect(text).toMatch(/END\n```\n…last 3000 characters of 90000 bytes; the full output is attached\.$/);
  });

  it.each([
    [{ exitCode: 2 }, '❌ exit 2'],
    [{ exitCode: null, timedOut: true }, '❌ timed out after 10m'],
    [{ exitCode: null, aborted: true }, '⏹ the gateway stopped while it ran'],
    [{ exitCode: null, spawnError: 'working directory /x does not exist' }, '❌ working directory /x does not exist'],
  ])('reports %j as %j', (over, head) => {
    expect(bashResultText(t(), outcome(over), 600_000).text.split('\n')[0]).toContain(head);
  });

  it('says so when there was no output at all', () => {
    expect(bashResultText(t(), outcome({ tail: '  \n', bytes: 3 }), 600_000).text).toMatch(/\n\(no output\)$/);
  });
});
