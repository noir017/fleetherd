import { describe, expect, it } from 'vitest';
import {
  bashResultText,
  bashWakeText,
  buildTask,
  CATCH_UP_GRACE_MS,
  cleanTags,
  decide,
  editTask,
  FIXED_SESSION_WINDOW_MS,
  formatDay,
  formatInZone,
  formatWakeOn,
  MAX_TAG_LENGTH,
  MAX_TASK_TAGS,
  nextRunOf,
  normalizeTags,
  parseAt,
  parseWakeOn,
  rebaseEdit,
  SHAPE_SETTINGS,
  shapeOf,
  shouldWake,
  taskCardText,
  taskWakeCapText,
  taskView,
  zonedToEpoch,
  type BashOutcome,
  type NewTaskContext,
  type ScheduleTask,
  type TaskSetting,
  type TaskShape,
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
    // A catch-up run belongs to the day of its PLANNED time, even when it is made after midnight:
    // planned 23:50 on the 1st, made 00:20 on the 2nd, is still the 1st's topic.
    const planned = zonedToEpoch(2026, 10, 1, 23, 50, 0, 'Asia/Shanghai');
    expect(formatDay(planned, 'Asia/Shanghai')).toBe('2026-10-01');
    expect(formatDay(planned + 30 * MIN, 'Asia/Shanghai')).toBe('2026-10-02');
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

  it('supports compound cron expressions separated by semicolons', () => {
    // NOW is 2026-09-30 10:00:00 (Wednesday)
    const t = built({ cron: '20 9 * * 1-5; 30 10 * * 1-5; 0 11 * * 1-5', prompt: 'check market', session: 'daily', agent: 'oc' });
    expect(t.when).toEqual({ cron: '20 9 * * 1-5; 30 10 * * 1-5; 0 11 * * 1-5', tz: SH });

    // next run from NOW (10:00) should be 10:30
    const first = nextRunOf(t, NOW);
    expect(formatInZone(first!, SH)).toBe('2026-09-30 10:30');

    // next run from 10:30 should be 11:00
    const second = nextRunOf(t, first!);
    expect(formatInZone(second!, SH)).toBe('2026-09-30 11:00');

    // next run from 11:00 should be tomorrow 09:20 (2026-10-01)
    const third = nextRunOf(t, second!);
    expect(formatInZone(third!, SH)).toBe('2026-10-01 09:20');
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

  it('--host takes the --cwd as that machine\'s, and infers no directory without one', () => {
    // With a --cwd: stored as given, because --host says which machine it belongs to.
    expect(built({ cron: '0 8 * * *', prompt: 'brief', session: 'new', agent: 'oc', cwd: '/srv/app', host: 'box' }).run).toEqual({
      kind: 'agent',
      agent: 'oc',
      prompt: 'brief',
      session: 'new',
      cwd: '/srv/app',
    });
    // Without one: no directory at all, so the run starts in that machine's own default — the
    // caller's /work is a path on a machine the task does not run on.
    expect(built({ cron: '0 8 * * *', prompt: 'brief', session: 'new', agent: 'oc', host: 'box' }).run).toEqual({
      kind: 'agent',
      agent: 'oc',
      prompt: 'brief',
      session: 'new',
    });
    // A daily task works the same way.
    expect(built({ cron: '0 8 * * *', prompt: 'brief', session: 'daily', agent: 'oc', host: 'box' }).run).toEqual({
      kind: 'agent',
      agent: 'oc',
      prompt: 'brief',
      session: 'daily',
    });
  });

  it('refuses --host on a fixed session, which has no directory to place', () => {
    expect(refusal({ cron: '0 * * * *', prompt: 'x', host: 'box' })).toMatch(/--host names the machine a --cwd belongs to.*fixed-session task has no --cwd/);
  });

  it('runs a bash task on the machine --host names, with nothing inferred from the caller', () => {
    // Named: that machine, and only the --cwd given — the caller's /work is a path elsewhere.
    expect(built({ cron: '0 3 * * *', bash: 'ls', host: 'box' }).run).toEqual({ kind: 'bash', command: 'ls', timeoutMs: 600_000, host: 'box' });
    expect(built({ cron: '0 3 * * *', bash: 'ls', host: 'box', cwd: '/srv' }).run).toMatchObject({ host: 'box', cwd: '/srv' });
    // null is the gateway's own machine, even when the registering agent is on another.
    const fromBox = ctx({ from: { key: 'k', platform: 'web', agent: 'cc', cwd: '/srv/box', host: 'box' } });
    expect(built({ cron: '0 3 * * *', bash: 'ls', host: null }, fromBox).run).toEqual({ kind: 'bash', command: 'ls', timeoutMs: 600_000 });
    // Not named: where the registering agent runs, in its directory — as before --host applied.
    expect(built({ cron: '0 3 * * *', bash: 'ls' }, fromBox).run).toMatchObject({ host: 'box', cwd: '/srv/box' });
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

describe('editTask', () => {
  // The service builds this context: no cwd and no agent of the caller's, because an edit keeps
  // every field it does not name. Passing ctx() here would hide that (its from.cwd is /work).
  const editCtx = (over: Partial<NewTaskContext> = {}): NewTaskContext =>
    ctx({ from: { key: 'web#main#t1', platform: 'web', agent: 'cc' }, ...over });

  const edited = (task: ScheduleTask, input: Parameters<typeof editTask>[1], c = editCtx()): ScheduleTask => {
    const r = editTask(task, input, c);
    if (!r.ok) throw new Error(r.error);
    return r.task;
  };
  const refused = (task: ScheduleTask, input: Parameters<typeof editTask>[1], c = editCtx()): string => {
    const r = editTask(task, input, c);
    if (r.ok) throw new Error('expected a refusal');
    return r.error;
  };

  /** A task with a history, so "kept" can be asserted rather than "still zero". */
  const ran = (t: ScheduleTask): ScheduleTask => ({
    ...t,
    runs: 3,
    lastPlannedAt: NOW - 2 * HOUR,
    lastRun: { at: NOW - 2 * HOUR, status: 'ok', durationMs: 1_500 },
    history: [{ at: NOW - 2 * HOUR, status: 'ok', durationMs: 1_500 }],
  });

  it('changes only the fields it was given, and keeps the task\'s identity and history', () => {
    const before = ran(built({ cron: '0 8 * * *', prompt: 'brief', session: 'new', agent: 'cc', name: 'brief' }));
    const after = edited(before, { agent: 'oc', prompt: 'write the brief' });
    expect(after.id).toBe(before.id);
    expect(after.createdAt).toBe(before.createdAt);
    expect(after.createdBy).toEqual(before.createdBy);
    expect(after.target).toEqual(before.target);
    expect(after.runs).toBe(3);
    expect(after.lastRun).toEqual(before.lastRun);
    expect(after.history).toEqual(before.history);
    expect(after.lastPlannedAt).toBe(before.lastPlannedAt);
    expect(after.name).toBe('brief'); // not re-derived from the new prompt
    expect(after.run).toEqual({ kind: 'agent', agent: 'oc', prompt: 'write the brief', session: 'new', cwd: '/work' });
    expect(after.when).toEqual(before.when);
  });

  it('empties a directory or a model on null, which the web UI form sends for a field it cleared', () => {
    const before = built({ cron: '0 8 * * *', prompt: 'brief', session: 'new', model: 'm1' });
    expect(before.run).toMatchObject({ cwd: '/work', model: 'm1' });
    const after = edited(before, { cwd: null, model: null });
    expect(after.run).toEqual({ kind: 'agent', agent: 'cc', prompt: 'brief', session: 'new' });
    const bash = edited(built({ cron: '0 8 * * *', bash: 'ls' }), { cwd: null });
    expect(bash.run.cwd).toBeUndefined();
    // A fixed session has neither to empty: nothing to refuse.
    expect(edited(built({ cron: '0 8 * * *', prompt: 'x' }), { cwd: null, model: null }).run).toEqual(
      built({ cron: '0 8 * * *', prompt: 'x' }).run
    );
  });

  it('keeps a paused task paused', () => {
    const paused = { ...built({ cron: '0 8 * * *', prompt: 'x', session: 'new' }), state: 'paused' as const };
    expect(edited(paused, { name: 'renamed' }).state).toBe('paused');
  });

  it('reuses buildTask\'s refusals, word for word', () => {
    const fresh = built({ cron: '0 8 * * *', prompt: 'x', session: 'new' });
    expect(refused(fresh, { agent: 'zz' })).toMatch(/unknown agent "zz"; configured: cc, oc/);
    expect(refused(fresh, { cron: '0 8 * * * *' })).toMatch(/not a 5-field cron/);
    expect(refused(fresh, { cron: '0 9 * * *', at: '+2h' })).toMatch(/exactly one of --cron/);
    expect(refused(fresh, { at: 'soon' })).toMatch(/not a time I can read/);
    expect(refused(fresh, { at: '2026-09-29 08:00' })).toMatch(/already in the past/);
    expect(refused(fresh, { tz: 'Mars/Base' })).toMatch(/unknown time zone "Mars\/Base"/);
  });

  it('refuses what add refuses for a fixed-session task: a model, a directory, another agent', () => {
    const fixed = built({ cron: '*/30 * * * *', prompt: 'x' });
    expect(refused(fixed, { model: 'fast-model' })).toMatch(/fixed-session.*\/model there/s);
    expect(refused(fixed, { cwd: '/elsewhere' })).toMatch(/runs where its topic already works/);
    expect(refused(fixed, { agent: 'oc' })).toMatch(/answered by cc.*--session new to run oc/);
  });

  it('refuses two kinds at once', () => {
    const prompt = built({ cron: '0 8 * * *', prompt: 'x', session: 'new' });
    expect(refused(prompt, { prompt: 'x', bash: 'ls' })).toMatch(/at most one of --prompt/);
  });

  it('refuses a daily task given a one-shot time, like add', () => {
    const daily = built({ cron: '0 8 * * *', prompt: 'x', session: 'daily' });
    expect(refused(daily, { at: '+1h' })).toMatch(/needs --cron.*no rest of the day/);
  });

  it('refuses an expired or finished task instead of resurrecting it', () => {
    const fixed = built({ cron: '*/30 * * * *', prompt: 'x' });
    expect(refused({ ...fixed, state: 'expired' }, { name: 'x' })).toMatch(/has expired.*add a new task/);
    const once = built({ at: '+1h', prompt: 'x', session: 'new' });
    expect(refused({ ...once, state: 'done' }, { name: 'x' })).toMatch(/has already had its run.*add a new task/);
  });

  it('a new time rule starts now, so an edit does not catch up a run that never existed', () => {
    const before = ran(built({ cron: '0 8 * * *', prompt: 'x', session: 'new' }));
    // NOW is 10:00 Shanghai; 09:00 today is already past, but the old task last ran at 08:00.
    const after = edited(before, { cron: '0 9 * * *' });
    expect(after.lastPlannedAt).toBe(NOW);
    expect(formatInZone(nextRunOf(after, NOW)!, SH)).toBe('2026-10-01 09:00');
    expect(decide(after, NOW)).toEqual({ kind: 'wait', at: Date.UTC(2026, 9, 1, 1, 0) });
  });

  it('keeps lastPlannedAt when the time rule did not change, so a rename cannot swallow a due run', () => {
    const before = ran(built({ cron: '0 8 * * *', prompt: 'x', session: 'new' }));
    const after = edited(before, { name: 'renamed' });
    expect(after.lastPlannedAt).toBe(before.lastPlannedAt);
    expect(after.when).toEqual(before.when);
  });

  it('keeps a fixed task\'s window, and refuses a schedule with no run left inside it', () => {
    const fixed = built({ cron: '0 8 * * *', prompt: 'x' }); // registered 10:00 on the 30th, ends 10:00 on the 1st
    const kept = edited(fixed, { name: 'renamed' });
    expect(kept.expiresAt).toBe(NOW + FIXED_SESSION_WINDOW_MS);
    expect(kept.conversation).toBe('web#main#t1');
    // Edited at 22:00 that night, "18:00 daily" would first run at 18:00 on the 1st — inside the
    // 24h a NEW task would get, but past this task's own window.
    const later = editCtx({ now: NOW + 12 * HOUR });
    expect(refused(fixed, { cron: '0 18 * * *' }, later)).toMatch(
      /lives until .*24h from registration.*schedule rm a1b2c3.*--session new/
    );
  });

  it('a bash task can change its command and timeout, and keeps its host', () => {
    const bash = built({ cron: '0 3 * * *', bash: 'du -sh /data', timeoutMs: 60_000 });
    const onBox = { ...bash, run: { ...bash.run, host: 'box' } } as ScheduleTask;
    const c = editCtx({ from: { key: 'web#main#t1', platform: 'web', agent: 'cc', host: 'box' } });
    const after = edited(onBox, { bash: 'du -sh /backup', timeoutMs: 120_000 }, c);
    expect(after.run).toEqual({ kind: 'bash', command: 'du -sh /backup', timeoutMs: 120_000, cwd: '/work', host: 'box' });
    expect(refused(onBox, { agent: 'cc' }, c)).toMatch(/--agent and --session are for --prompt/);
    expect(refused(onBox, { model: 'fast-model' }, c)).toMatch(/--model is for --prompt/);
    expect(refused(onBox, { timeoutMs: 500 }, c)).toMatch(/--timeout must be between 1s and 6h/);
  });

  it('keeps a one-shot\'s exact instant when only its name changes', () => {
    const once = built({ at: '2026-10-01T08:00:00+08:00', prompt: 'x', session: 'new' });
    const after = edited(once, { name: 'renamed' });
    expect(after.when).toEqual(once.when);
    expect(after.lastPlannedAt).toBeUndefined();
  });

  it('keeps a task\'s empty directory empty when --cwd is not given', () => {
    const bare = built({ cron: '0 8 * * *', prompt: 'x', session: 'new' }, ctx({ from: { key: 'k', platform: 'web', agent: 'cc' } }));
    expect(bare.run).toEqual({ kind: 'agent', agent: 'cc', prompt: 'x', session: 'new' });
    expect(edited(bare, { name: 'x' }).run).not.toHaveProperty('cwd');
  });

  it('a daily task keeps today\'s topic unless its agent or directory changes', () => {
    const day = { day: '2026-09-30', conversation: 'web#main#new1', address: { channel: 'main', thread: 'new1' } };
    const daily = { ...built({ cron: '0 8 * * *', prompt: 'x', session: 'daily' }), daySession: day };
    expect(edited(daily, { name: 'renamed', model: 'fast-model' }).daySession).toEqual(day);
    expect(edited(daily, { agent: 'oc' })).not.toHaveProperty('daySession');
    expect(edited(daily, { cwd: '/elsewhere' })).not.toHaveProperty('daySession');
  });
});

/**
 * An edit that changes what a task is, how it runs or where it posts. The rule is still buildTask's;
 * what these pin is what the id carries across such a change and what it starts afresh — the
 * decisions the comment on editTask names, one by one.
 */
describe('editTask: kind, session and target', () => {
  const editCtx = (over: Partial<NewTaskContext> = {}): NewTaskContext =>
    ctx({ from: { key: 'web#main#t1', platform: 'web', agent: 'cc' }, ...over });
  const edited = (task: ScheduleTask, input: Parameters<typeof editTask>[1], c = editCtx()): ScheduleTask => {
    const r = editTask(task, input, c);
    if (!r.ok) throw new Error(r.error);
    return r.task;
  };
  const refused = (task: ScheduleTask, input: Parameters<typeof editTask>[1], c = editCtx()): string => {
    const r = editTask(task, input, c);
    if (r.ok) throw new Error('expected a refusal');
    return r.error;
  };
  /** A task with a past, so "kept" can be asserted rather than "still empty". */
  const lived = (t: ScheduleTask): ScheduleTask => ({
    ...t,
    tags: ['ci'],
    runs: 4,
    lastPlannedAt: NOW - 2 * HOUR,
    lastRun: { at: NOW - 2 * HOUR, status: 'failed', error: 'exit 1' },
    history: [{ at: NOW - 2 * HOUR, status: 'failed', error: 'exit 1', conversation: 'web#main#r1' }],
  });
  const identity = (t: ScheduleTask) => ({
    id: t.id,
    createdAt: t.createdAt,
    createdBy: t.createdBy,
    state: t.state,
    tags: t.tags,
    runs: t.runs,
    lastRun: t.lastRun,
    history: t.history,
    lastPlannedAt: t.lastPlannedAt,
  });
  const LATER = NOW + 6 * HOUR;
  /** A target with a conversation of its own, as the service would find it. */
  const elsewhere = (now = LATER): NewTaskContext =>
    editCtx({
      now,
      target: { platform: 'web', address: { channel: 'main', thread: 't2' } },
      targetConversation: { key: 'web#main#t2', agent: 'cc' },
    });

  it('the shape table agrees with buildTask, setting by setting', () => {
    // Each setting given alone to a task of each shape: buildTask must accept exactly what the
    // table says that shape keeps, or the form would offer a field every value of which is refused.
    const given: Record<TaskSetting, Partial<Parameters<typeof buildTask>[0]>> = {
      agent: { agent: 'cc' },
      model: { model: 'm1' },
      cwd: { cwd: '/srv' },
      host: { host: 'box' },
      timeout: { timeoutMs: 60_000 },
      wake: { wake: true },
      at: { at: '+1h', cron: undefined },
    };
    const base: Record<TaskShape, Parameters<typeof buildTask>[0]> = {
      bash: { cron: '0 * * * *', bash: 'ls' },
      fixed: { cron: '0 * * * *', prompt: 'x', session: 'fixed' },
      new: { cron: '0 * * * *', prompt: 'x', session: 'new' },
      daily: { cron: '0 * * * *', prompt: 'x', session: 'daily' },
    };
    for (const shape of Object.keys(base) as TaskShape[]) {
      for (const setting of Object.keys(given) as TaskSetting[]) {
        // `host` on a prompt task is only a declaration about a --cwd; it is the one setting a
        // shape takes without keeping (new and daily accept it, store none).
        if (setting === 'host' && (shape === 'new' || shape === 'daily')) continue;
        const r = buildTask({ ...base[shape], ...given[setting] }, ctx());
        expect([shape, setting, r.ok]).toEqual([shape, setting, SHAPE_SETTINGS[shape].includes(setting)]);
      }
    }
    expect(shapeOf(built({ cron: '0 * * * *', bash: 'ls' }).run)).toBe('bash');
    expect(shapeOf(built({ cron: '0 * * * *', prompt: 'x', session: 'daily' }).run)).toBe('daily');
  });

  it('a prompt task becomes a bash task: it keeps its id and its past, its directory, and runs where its agent did', () => {
    const before = lived(built({ cron: '0 8 * * *', prompt: 'brief', session: 'new', agent: 'oc', model: 'm1', cwd: '/srv/app' }));
    const c = editCtx({ from: { key: 'web#main#t1', platform: 'web', agent: 'oc', host: 'box' } });
    const after = edited(before, { bash: 'make check' }, c);
    // The agent and model have no place in a bash task; the directory and the machine carry over.
    expect(after.run).toEqual({ kind: 'bash', command: 'make check', timeoutMs: 600_000, cwd: '/srv/app', host: 'box' });
    expect(identity(after)).toEqual(identity(before));
    expect(after.target).toEqual(before.target);
    expect(after.name).toBe(before.name);
    // A setting the new shape has no place for, given anyway, is refused in add's words.
    expect(refused(before, { bash: 'ls', model: 'm2' }, c)).toMatch(/--model is for --prompt tasks/);
    expect(refused(before, { bash: 'ls', session: 'daily' }, c)).toMatch(/--session daily is for --prompt tasks/);
  });

  it('a fixed-session task becomes a bash task: its conversation and its window go', () => {
    const fixed = lived(built({ cron: '*/30 * * * *', prompt: 'x' }));
    const after = edited(fixed, { bash: 'ls', timeoutMs: 30_000 });
    expect(after.run).toEqual({ kind: 'bash', command: 'ls', timeoutMs: 30_000 });
    expect(after).not.toHaveProperty('conversation');
    expect(after).not.toHaveProperty('expiresAt');
  });

  it('a bash task becomes a prompt task with add\'s defaults: a fixed session in the target conversation, 24h from the edit', () => {
    const bash = lived(built({ cron: '0 * * * *', bash: 'du -sh /data', timeoutMs: 60_000 }));
    const after = edited(bash, { prompt: 'check the disk' }, editCtx({ now: LATER }));
    // The directory has no place in a fixed session (it is its topic's), and the timeout none in a prompt task.
    expect(after.run).toEqual({ kind: 'agent', agent: 'cc', prompt: 'check the disk', session: 'fixed' });
    expect(after.conversation).toBe('web#main#t1');
    expect(after.expiresAt).toBe(LATER + FIXED_SESSION_WINDOW_MS);
    expect(identity(after)).toEqual(identity(bash));

    // With a session that keeps a directory, the one it had carries over; the agent is the one named.
    const fresh = edited(bash, { prompt: 'check the disk', session: 'new', agent: 'oc' });
    expect(fresh.run).toEqual({ kind: 'agent', agent: 'oc', prompt: 'check the disk', session: 'new', cwd: '/work' });
    expect(fresh).not.toHaveProperty('expiresAt');
    expect(refused(bash, { prompt: 'x', session: 'new', timeoutMs: 5_000 })).toMatch(/--timeout is for --bash/);
  });

  it('a new-session task turned fixed starts its window now and leaves its directory and model behind', () => {
    const before = lived(built({ cron: '0 * * * *', prompt: 'x', session: 'new', model: 'm1' }));
    const after = edited(before, { session: 'fixed' }, editCtx({ now: LATER }));
    expect(after.run).toEqual({ kind: 'agent', agent: 'cc', prompt: 'x', session: 'fixed' });
    expect(after.conversation).toBe('web#main#t1');
    expect(after.expiresAt).toBe(LATER + FIXED_SESSION_WINDOW_MS);
    expect(identity(after)).toEqual(identity(before));
    // Named anyway, they are refused as add refuses them.
    expect(refused(before, { session: 'fixed', model: 'm2' })).toMatch(/fixed-session.*\/model there/s);
    expect(refused(before, { session: 'fixed', cwd: '/elsewhere' })).toMatch(/runs where its topic already works/);
  });

  it('a fixed-session task turned new has no conversation and no window; one that stays keeps its window', () => {
    const fixed = built({ cron: '*/30 * * * *', prompt: 'x' });
    const fresh = edited(fixed, { session: 'new' }, editCtx({ now: LATER }));
    expect(fresh.run).toEqual({ kind: 'agent', agent: 'cc', prompt: 'x', session: 'new' });
    expect(fresh).not.toHaveProperty('conversation');
    expect(fresh).not.toHaveProperty('expiresAt');
    // Naming the session it already has is not a new registration.
    expect(edited(fixed, { session: 'fixed' }, editCtx({ now: LATER })).expiresAt).toBe(NOW + FIXED_SESSION_WINDOW_MS);
  });

  it('new ↔ daily keeps the directory and model; daily drops today\'s topic when it stops being daily', () => {
    const fresh = built({ cron: '0 8 * * *', prompt: 'x', session: 'new', model: 'm1' });
    expect(edited(fresh, { session: 'daily' }).run).toEqual({ kind: 'agent', agent: 'cc', prompt: 'x', session: 'daily', cwd: '/work', model: 'm1' });
    const day = { day: '2026-09-30', conversation: 'web#main#new1', address: { channel: 'main', thread: 'new1' } };
    const daily = { ...built({ cron: '0 8 * * *', prompt: 'x', session: 'daily' }), daySession: day };
    expect(edited(daily, { session: 'new' })).not.toHaveProperty('daySession');
    expect(edited(daily, { bash: 'ls' })).not.toHaveProperty('daySession');
    expect(edited(daily, { prompt: 'y' }).daySession).toEqual(day);
    // A one-shot task cannot become daily, as add cannot register one.
    expect(refused(built({ at: '+2h', prompt: 'x', session: 'new' }), { session: 'daily' })).toMatch(/needs --cron/);
  });

  it('moves a task: a new target, and a fixed session there gets that conversation and a window from now', () => {
    const fixed = lived(built({ cron: '*/30 * * * *', prompt: 'x' }));
    const moved = edited(fixed, {}, elsewhere());
    expect(moved.target).toEqual({ platform: 'web', channel: 'main', thread: 't2' });
    expect(moved.conversation).toBe('web#main#t2');
    expect(moved.expiresAt).toBe(LATER + FIXED_SESSION_WINDOW_MS);
    // A change of place is not a change of time: the run planned at 08:00 was handled.
    expect(identity(moved)).toEqual(identity(fixed));
    // A topic there answered by another agent is refused, as add refuses it.
    expect(refused(fixed, {}, editCtx({ target: { platform: 'web', address: { channel: 'main', thread: 't3' } }, targetConversation: { key: 'web#main#t3', agent: 'oc' } }))).toMatch(
      /answered by oc/
    );
    // A target that names no conversation cannot hold a fixed session.
    expect(refused(fixed, {}, editCtx({ target: { platform: 'tg', address: { channel: '-100' } }, targetConversation: undefined }))).toMatch(
      /needs one conversation to run in/
    );
  });

  it('a daily task moved elsewhere opens its next topic there, and refuses a target that cannot open one', () => {
    const day = { day: '2026-09-30', conversation: 'web#main#new1', address: { channel: 'main', thread: 'new1' } };
    const daily = { ...built({ cron: '0 8 * * *', prompt: 'x', session: 'daily' }), daySession: day };
    const moved = edited(daily, {}, elsewhere());
    expect(moved.target.thread).toBe('t2');
    expect(moved).not.toHaveProperty('daySession');
    expect(refused(daily, {}, editCtx({ canOpenTopic: false, target: { platform: 'tg', address: { channel: '-100' } } }))).toMatch(
      /needs a target that can open a topic/
    );
  });

  it('a bash task moves to another machine with --host, and back to the gateway\'s with null', () => {
    const onBox = { ...built({ cron: '0 3 * * *', bash: 'ls', host: 'box', cwd: '/srv' }) };
    const c = editCtx({ from: { key: 'web#main#t1', platform: 'web', agent: 'cc', host: 'box' } });
    // Kept: the machine it runs on, from the context, and its directory.
    expect(edited(onBox, { name: 'renamed' }, c).run).toMatchObject({ host: 'box', cwd: '/srv' });
    expect(edited(onBox, { host: null }, c).run).toEqual({ kind: 'bash', command: 'ls', timeoutMs: 600_000, cwd: '/srv' });
    expect(edited(onBox, { host: 'box2', cwd: '/data' }, c).run).toMatchObject({ host: 'box2', cwd: '/data' });
  });
});

describe('rebaseEdit', () => {
  it('preserves runtime updates from current while applying edited config fields', () => {
    const before = built({ cron: '0 8 * * *', prompt: 'old', session: 'daily' });
    const editRes = editTask(before, { prompt: 'new', name: 'renamed' }, ctx());
    expect(editRes.ok).toBe(true);
    if (!editRes.ok) throw new Error(editRes.error);
    const day = { day: '2026-09-30', conversation: 'web#main#d1', address: { channel: 'main', thread: 'd1' } };
    const current: ScheduleTask = {
      ...before,
      runs: 2,
      lastPlannedAt: NOW + 60_000,
      lastRun: { at: NOW + 60_000, status: 'ok', durationMs: 500 },
      history: [{ at: NOW + 60_000, status: 'ok', durationMs: 500 }],
      daySession: day,
    };
    const rebased = rebaseEdit(before, editRes.task, current);
    expect(rebased.ok).toBe(true);
    if (!rebased.ok) throw new Error(rebased.error);
    expect(rebased.task).toMatchObject({
      name: 'renamed',
      run: { kind: 'agent', prompt: 'new', session: 'daily' },
      runs: 2,
      lastPlannedAt: NOW + 60_000,
      lastRun: { status: 'ok' },
      daySession: day,
    });
    expect(rebased.task.history).toHaveLength(1);
  });

  it('drops current daySession when the edit changes daily scope and refuses once current is done', () => {
    const before = built({ cron: '0 8 * * *', prompt: 'old', session: 'daily' });
    const editRes = editTask(before, { agent: 'oc' }, ctx());
    expect(editRes.ok).toBe(true);
    if (!editRes.ok) throw new Error(editRes.error);
    const day = { day: '2026-09-30', conversation: 'web#main#d1', address: { channel: 'main', thread: 'd1' } };
    const rebased = rebaseEdit(before, editRes.task, { ...before, daySession: day });
    expect(rebased.ok).toBe(true);
    if (rebased.ok) expect(rebased.task).not.toHaveProperty('daySession');

    const finished = rebaseEdit(before, editRes.task, { ...before, state: 'done' });
    expect(finished.ok).toBe(false);
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

  it('quotes the whole prompt rather than cutting it at 200 characters', () => {
    // The card is how the conversation that will run the prompt learns what it says; a change to
    // an unverified prototype read as "…" after 200 characters and nobody saw it (2026-11-13).
    const long = 'y'.repeat(400);
    const card = taskCardText(built({ cron: '0 8 * * *', prompt: `first line\n${long}\nlast line`, session: 'new' }), 'updated', NOW);
    expect(card).toContain(`• Prompt:\n> first line\n> ${long}\n> last line\n`);
  });

  it('keeps a bash task\'s command on one line, since a command is read as one', () => {
    const card = taskCardText(built({ at: '+2m', bash: 'for i in 1 2; do\n  echo $i\ndone' }), 'registered', NOW);
    expect(card).toContain('• Command: for i in 1 2; do echo $i done');
    expect(card).not.toContain('• Prompt:');
  });
});

describe('taskView', () => {
  it('show prints the last runs, newest first, with the topic each output went to', () => {
    const t: ScheduleTask = {
      ...built({ cron: '0 8 * * *', prompt: 'brief', session: 'new' }),
      history: [
        { at: NOW + 60_000, status: 'failed', durationMs: 1_200, error: 'exit 2', conversation: 'web#main#new1' },
        { at: NOW, status: 'ok', durationMs: 300 },
      ],
    };
    expect(taskView(t, NOW, { detail: true })).toMatchObject({
      history: [
        { at: '2026-09-30 10:01', status: 'failed', took: '1.2s', conversation: 'web#main#new1', error: 'exit 2' },
        { at: '2026-09-30 10:00', status: 'ok', took: '300ms', conversation: '', error: '' },
      ],
    });
  });

  it('list stays one row a task: no history without detail', () => {
    const t: ScheduleTask = {
      ...built({ cron: '0 8 * * *', prompt: 'brief', session: 'new' }),
      history: [{ at: NOW, status: 'ok' }],
    };
    expect(taskView(t, NOW)).not.toHaveProperty('history');
  });

  it('omits the field entirely when a task has never run', () => {
    expect(taskView(built({ cron: '0 8 * * *', prompt: 'brief', session: 'new' }), NOW, { detail: true })).not.toHaveProperty('history');
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

describe('task tags', () => {
  it('trims and lowercases every tag, drops duplicates, and keeps the order given', () => {
    expect(normalizeTags([' CI ', 'ci', 'Deploy', 'deploy'])).toEqual({ ok: true, tags: ['ci', 'deploy'] });
  });

  it('takes exactly five tags and refuses a sixth, after dedupe', () => {
    const five = ['a', 'b', 'c', 'd', 'e'];
    expect(normalizeTags(five)).toEqual({ ok: true, tags: five });
    expect(normalizeTags([...five, 'f'])).toEqual({
      ok: false,
      error: `a task takes at most ${MAX_TASK_TAGS} tags, got 6`,
    });
    // A duplicate does not use a slot: four distinct names plus a repeat is still four.
    expect(normalizeTags([...five.slice(0, 4), 'a', 'e'])).toEqual({ ok: true, tags: five });
  });

  it('caps a tag at 24 characters and refuses anything outside letters, digits and - _ . /', () => {
    const long = 'x'.repeat(MAX_TAG_LENGTH);
    expect(normalizeTags([long])).toEqual({ ok: true, tags: [long] });
    expect(normalizeTags([`${long}y`]).ok).toBe(false);
    expect(normalizeTags(['two words'])).toEqual({
      ok: false,
      error: 'tag "two words" may contain only letters, digits and - _ . /',
    });
    expect(normalizeTags(['a,b']).ok).toBe(false);
    expect(normalizeTags(['`quote`']).ok).toBe(false);
    // What the set is for: repo-ish names and Chinese both fit.
    expect(normalizeTags(['release-2026', 'a_b.c/d', '发布'])).toEqual({
      ok: true,
      tags: ['release-2026', 'a_b.c/d', '发布'],
    });
  });

  it('cleans a stored list: normalize what can be, drop the rest, keep five', () => {
    const cleaned = cleanTags([' CI ', 'ci', '发布', 'two words', '`x`', 'a', 'b', 'c', 'd', 'e']);
    // ` CI ` and `ci` are the same tag; the next invalid ones are dropped; then the five cap is
    // reached, so later tags go too.
    expect(cleaned.tags).toEqual(['ci', '发布', 'a', 'b', 'c']);
    expect(cleaned.dropped.map((d) => d.tag)).toEqual(['ci', 'two words', '`x`', 'd', 'e']);
    expect(cleaned.dropped.map((d) => d.reason)).toEqual([
      'duplicate',
      'tag "two words" may contain only letters, digits and - _ . /',
      'tag "`x`" may contain only letters, digits and - _ . /',
      `more than ${MAX_TASK_TAGS} tags`,
      `more than ${MAX_TASK_TAGS} tags`,
    ]);
    expect(cleanTags(['', '  '])).toEqual({ tags: [], dropped: [] });
  });

  it('treats an empty list as no tags, which is what --tag "" clears with', () => {
    expect(normalizeTags([])).toEqual({ ok: true, tags: [] });
    expect(normalizeTags(['', '  '])).toEqual({ ok: true, tags: [] });
  });

  it('stores tags on a new task and leaves the field off when none were given', () => {
    expect(built({ cron: '0 8 * * *', prompt: 'x', tags: ['ci', 'release'] }).tags).toEqual(['ci', 'release']);
    expect(built({ cron: '0 8 * * *', prompt: 'x' }).tags).toBeUndefined();
    expect(built({ cron: '0 8 * * *', prompt: 'x', tags: [] }).tags).toBeUndefined();
  });

  it('refuses a bad tag on add, naming the limit', () => {
    expect(refusal({ cron: '0 8 * * *', prompt: 'x', tags: ['a', 'b', 'c', 'd', 'e', 'f'] })).toMatch(/at most 5 tags/);
  });

  it('edit replaces the whole set, and an empty list removes it', () => {
    const t = built({ cron: '0 8 * * *', prompt: 'x', tags: ['ci', 'release'] });
    const replaced = editTask(t, { tags: ['ops'] }, ctx());
    expect(replaced.ok && replaced.task.tags).toEqual(['ops']);

    const cleared = editTask(t, { tags: [] }, ctx());
    expect(cleared.ok && cleared.task.tags).toBeUndefined();

    // Not naming them keeps them, exactly like every other field.
    const kept = editTask(t, { name: 'renamed' }, ctx());
    expect(kept.ok && kept.task.tags).toEqual(['ci', 'release']);
  });

  it('writes the tags on the card posted for a change', () => {
    const t = built({ cron: '0 8 * * *', prompt: 'x', tags: ['ci', 'release'] });
    expect(taskCardText(t, 'registered', NOW)).toContain('• Tags: `ci`, `release`');
  });
});

describe('waking bash tasks', () => {
  it('parses and formats --wake-on rules', () => {
    expect(parseWakeOn('any')).toEqual({ ok: true, rule: 'any' });
    expect(parseWakeOn(' ZERO ')).toEqual({ ok: true, rule: 'zero' });
    expect(parseWakeOn('nonzero')).toEqual({ ok: true, rule: 'nonzero' });
    expect(parseWakeOn('2, 1, 2, 0')).toEqual({ ok: true, rule: [0, 1, 2] });
    expect(formatWakeOn([1, 2])).toBe('1,2');
    expect(formatWakeOn('nonzero')).toBe('nonzero');
    expect(parseWakeOn('')).toMatchObject({ ok: false });
    expect(parseWakeOn('abc')).toMatchObject({ ok: false });
    expect(parseWakeOn('256')).toMatchObject({ ok: false });
    expect(parseWakeOn('-1')).toMatchObject({ ok: false });
  });

  it('matches outcomes according to shouldWake and never wakes on abort', () => {
    const ok: BashOutcome = { exitCode: 0, timedOut: false, aborted: false, tail: 'ok', bytes: 2, durationMs: 100 };
    const fail1: BashOutcome = { exitCode: 1, timedOut: false, aborted: false, tail: 'err', bytes: 3, durationMs: 100 };
    const fail2: BashOutcome = { exitCode: 2, timedOut: false, aborted: false, tail: 'err2', bytes: 4, durationMs: 100 };
    const timedOut: BashOutcome = { exitCode: null, timedOut: true, aborted: false, tail: '', bytes: 0, durationMs: 10_000 };
    const aborted: BashOutcome = { exitCode: null, timedOut: false, aborted: true, tail: '', bytes: 0, durationMs: 50 };

    expect(shouldWake('any', ok)).toBe(true);
    expect(shouldWake('any', fail1)).toBe(true);
    expect(shouldWake('any', aborted)).toBe(false);
    expect(shouldWake('zero', ok)).toBe(true);
    expect(shouldWake('zero', fail1)).toBe(false);
    expect(shouldWake('nonzero', ok)).toBe(false);
    expect(shouldWake('nonzero', fail1)).toBe(true);
    expect(shouldWake('nonzero', timedOut)).toBe(true);
    expect(shouldWake([1, 2], ok)).toBe(false);
    expect(shouldWake([1, 2], fail1)).toBe(true);
    expect(shouldWake([1, 2], fail2)).toBe(true);
    expect(shouldWake([1, 2], timedOut)).toBe(false);
  });

  it('formats the wake turn with only the source label and output tail', () => {
    const t = built({ at: '+5m', bash: 'echo hi', name: 'watch PR #42', wake: true });
    const text = bashWakeText(t, { exitCode: 0, timedOut: false, aborted: false, tail: 'all green\n', bytes: 10, durationMs: 1_500 }, 60_000);
    expect(text).toBe('↳ Scheduled task "watch PR #42" · exit 0 · 1.5s\n\nall green');

    const quiet = bashWakeText(t, { exitCode: 1, timedOut: false, aborted: false, tail: '   \n', bytes: 4, durationMs: 500 }, 60_000);
    expect(quiet).toBe('↳ Scheduled task "watch PR #42" · exit 1 · 500ms');

    const longTail = 'x'.repeat(3_500);
    const cut = bashWakeText(t, { exitCode: 1, timedOut: false, aborted: false, tail: longTail, bytes: 3_500, durationMs: 2_000 }, 60_000);
    expect(cut).toBe(`↳ Scheduled task "watch PR #42" · exit 1 · 2.0s\n\n${'x'.repeat(3_000)}`);
  });

  it('builds a waking bash task with 24h lifetime, conversation binding, and default cap 3', () => {
    const t = built({ cron: '*/5 * * * *', bash: 'check', wake: true });
    expect(t.run).toMatchObject({ kind: 'bash', wake: { on: 'any', max: 3 } });
    expect(t.conversation).toBe('web#main#t1');
    expect(t.expiresAt).toBe(NOW + FIXED_SESSION_WINDOW_MS);

    const byRule = built({ cron: '*/5 * * * *', bash: 'check', wakeOn: 'nonzero', wakeMax: 5 });
    expect(byRule.run).toMatchObject({ kind: 'bash', wake: { on: 'nonzero', max: 5 } });

    const detail = taskView({ ...byRule, wakes: 1 }, NOW, { detail: true });
    expect(detail).toMatchObject({ wakeOn: 'nonzero', wakeMax: 5, wakes: 1 });
    expect(detail.runs).toContain('wake (nonzero, max 5)');
  });

  it('refuses invalid wake combinations and missing conversation', () => {
    expect(refusal({ cron: '0 8 * * *', prompt: 'hi', wake: true })).toMatch(/for --bash tasks/);
    expect(refusal({ cron: '0 8 * * *', bash: 'ls', wakeMax: 5 })).toMatch(/--wake-max is for a waking/);
    expect(refusal({ cron: '0 8 * * *', bash: 'ls', wake: true, wakeOn: 'off' })).toMatch(/contradict/);
    expect(refusal({ cron: '0 8 * * *', bash: 'ls', wake: true, wakeMax: 0 })).toMatch(/between 1 and 100/);
    expect(refusal({ cron: '0 8 * * *', bash: 'ls', wake: true }, ctx({ targetConversation: undefined }))).toMatch(/needs one conversation/);
    expect(refusal({ at: '+48h', bash: 'ls', wake: true })).toMatch(/only lives 24h/);
  });

  it('keeps wake fields across unrelated edits, updates them, and clears on --wake-on off', () => {
    const t = { ...built({ cron: '*/5 * * * *', bash: 'check', wakeOn: 'nonzero', wakeMax: 4 }), wakes: 2 };
    const renamed = editTask(t, { name: 'new name' }, ctx({ now: NOW + 3_600_000 }));
    expect(renamed.ok).toBe(true);
    if (renamed.ok) {
      expect(renamed.task.run).toMatchObject({ kind: 'bash', wake: { on: 'nonzero', max: 4 } });
      expect(renamed.task.wakes).toBe(2);
      expect(renamed.task.expiresAt).toBe(t.expiresAt);
    }

    const tooLow = editTask(t, { wakeMax: 2 }, ctx());
    expect(tooLow.ok).toBe(false);

    const turnedOff = editTask(t, { wakeOn: 'off' }, ctx());
    expect(turnedOff.ok).toBe(true);
    if (turnedOff.ok) {
      expect(turnedOff.task.run.kind === 'bash' && turnedOff.task.run.wake).toBeUndefined();
      expect(turnedOff.task.expiresAt).toBeUndefined();
      expect(turnedOff.task.conversation).toBeUndefined();
      expect(turnedOff.task.wakes).toBeUndefined();
    }
  });

  it('marks a waking task done in decide once wakes reach wake.max', () => {
    const t = { ...built({ cron: '*/5 * * * *', bash: 'check', wake: true, wakeMax: 2 }), wakes: 2 };
    expect(decide(t, NOW + 600_000)).toEqual({ kind: 'done' });
    expect(taskWakeCapText(t)).toContain('reached its wake limit (2/2)');
  });
});
