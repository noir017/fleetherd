import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ScheduleStore } from './schedule-store.js';
import { Scheduler, type ScheduleExecutor, type ScheduleRunResult } from './scheduler.js';
import { buildTask, type NewTaskInput, type ScheduleTask } from '../core/schedule.js';

/**
 * The scheduler against a real store file and a fake clock. The cases that matter are the ones a
 * user would only notice days later: a run repeated after a restart, a run lost across one, two
 * runs of one task on top of each other, and a task file that half-loads.
 */

const NOW = Date.UTC(2026, 8, 30, 2, 0, 0); // 10:00 Shanghai
const MIN = 60_000;

let dir: string;
let file: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-sched-'));
  file = path.join(dir, 'schedules.json');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** A manual clock: timers fire only when advance() passes them. */
function makeClock(start = NOW) {
  let t = start;
  let timers: Array<{ fn: () => void; at: number }> = [];
  return {
    now: () => t,
    schedule(fn: () => void, ms: number) {
      const entry = { fn, at: t + ms };
      timers.push(entry);
      return () => {
        timers = timers.filter((e) => e !== entry);
      };
    },
    async advance(ms: number) {
      const end = t + ms;
      for (;;) {
        const due = timers.filter((e) => e.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        t = Math.max(t, due.at);
        timers = timers.filter((e) => e !== due);
        due.fn();
        await new Promise((r) => setTimeout(r, 0));
      }
      t = end;
    },
  };
}

function task(input: NewTaskInput, id = 'a1b2c3', now = NOW): ScheduleTask {
  const r = buildTask(input, {
    now,
    id,
    defaultTz: 'Asia/Shanghai',
    agents: ['cc'],
    from: { key: 'web#main#t1', platform: 'web', agent: 'cc' },
    target: { platform: 'web', address: { channel: 'main', thread: 't1' } },
    targetConversation: { key: 'web#main#t1', agent: 'cc' },
  });
  if (!r.ok) throw new Error(r.error);
  return r.task;
}

function executor(result: ScheduleRunResult = { status: 'ok' }) {
  const runs: Array<{ id: string; planned: number }> = [];
  const hold: Array<() => void> = [];
  let holding = false;
  const exec: ScheduleExecutor & { notified: string[] } = {
    notified: [],
    run: (t, planned) => {
      runs.push({ id: t.id, planned });
      if (!holding) return Promise.resolve(result);
      return new Promise((res) => hold.push(() => res(result)));
    },
    notify: (t, event) => void exec.notified.push(`${t.id}:${event}`),
  };
  return {
    exec,
    runs,
    holdRuns: () => {
      holding = true;
    },
    release: async () => {
      holding = false;
      for (const h of hold.splice(0)) h();
      await new Promise((r) => setTimeout(r, 0));
    },
  };
}

describe('Scheduler', () => {
  it('runs a task at its planned time and records the outcome', async () => {
    const clock = makeClock();
    const e = executor({ status: 'ok' });
    const s = new Scheduler(new ScheduleStore(file), clock, e.exec);
    s.start();
    s.add(task({ at: '+5m', bash: 'true' }));
    await clock.advance(4 * MIN);
    expect(e.runs).toEqual([]);
    await clock.advance(MIN);
    expect(e.runs).toEqual([{ id: 'a1b2c3', planned: NOW + 5 * MIN }]);
    const saved = new ScheduleStore(file).get('a1b2c3')!;
    expect(saved).toMatchObject({ state: 'done', runs: 1, lastRun: { status: 'ok' } });
    s.stop();
  });

  it('does not repeat a run after a restart, and catches up one it missed by less than an hour', async () => {
    const e = executor();
    const first = new Scheduler(new ScheduleStore(file), makeClock(), e.exec);
    first.start();
    first.add(task({ cron: '*/10 * * * *', bash: 'true' }));
    // Pretend the 10:10 run happened, then the daemon went down until 10:35.
    first.stop();
    const store = new ScheduleStore(file);
    store.put({ ...store.get('a1b2c3')!, lastPlannedAt: NOW + 10 * MIN });

    const c2 = makeClock(NOW + 35 * MIN);
    const second = new Scheduler(new ScheduleStore(file), c2, e.exec);
    second.start();
    await c2.advance(0);
    // One catch-up run for the LATEST missed time (10:30), not three for 10:20 and 10:30.
    expect(e.runs).toEqual([{ id: 'a1b2c3', planned: NOW + 30 * MIN }]);
    await c2.advance(5 * MIN); // 10:40
    expect(e.runs.map((r) => r.planned)).toEqual([NOW + 30 * MIN, NOW + 40 * MIN]);
    second.stop();
  });

  it('while held for a restart, lets the run in flight finish, starts none, and leaves what fell due to the next gateway', async () => {
    const clock = makeClock();
    const e = executor();
    const s = new Scheduler(new ScheduleStore(file), clock, e.exec);
    s.start();
    s.add(task({ cron: '*/10 * * * *', bash: 'true' }));
    e.holdRuns();
    await clock.advance(10 * MIN); // 10:10 starts, and is still going
    expect(s.inFlight).toBe(1);

    s.hold();
    await e.release(); // finishes, and is recorded as usual
    expect(s.inFlight).toBe(0);
    expect(new ScheduleStore(file).get('a1b2c3')).toMatchObject({ runs: 1, lastRun: { status: 'ok' } });
    await clock.advance(10 * MIN); // 10:20 falls due while held: not run, not recorded as missed
    expect(e.runs.map((r) => r.planned)).toEqual([NOW + 10 * MIN]);
    expect(s.runNow('a1b2c3')).toMatch(/restarting/);

    // The next gateway, a few minutes later, catches 10:20 up.
    const c2 = makeClock(NOW + 25 * MIN);
    const next = new Scheduler(new ScheduleStore(file), c2, e.exec);
    next.start();
    await c2.advance(0);
    expect(e.runs.map((r) => r.planned)).toEqual([NOW + 10 * MIN, NOW + 20 * MIN]);
    next.stop();
  });

  it('records a run missed by more than an hour instead of making it late', async () => {
    const store = new ScheduleStore(file);
    store.put(task({ at: '+5m', bash: 'true' }));
    const e = executor();
    const clock = makeClock(NOW + 5 * MIN + 2 * 3_600_000);
    const s = new Scheduler(new ScheduleStore(file), clock, e.exec);
    s.start();
    await clock.advance(0);
    expect(e.runs).toEqual([]);
    expect(new ScheduleStore(file).get('a1b2c3')).toMatchObject({ state: 'done', lastRun: { status: 'missed' } });
    s.stop();
  });

  it('skips a run while the previous one of the same task is still going', async () => {
    const clock = makeClock();
    const e = executor();
    const s = new Scheduler(new ScheduleStore(file), clock, e.exec);
    s.start();
    s.add(task({ cron: '* * * * *', bash: 'sleep 999' }));
    e.holdRuns();
    await clock.advance(MIN); // 10:01 starts and hangs
    await clock.advance(MIN); // 10:02 is due while 10:01 runs
    expect(e.runs).toHaveLength(1);
    expect(new ScheduleStore(file).get('a1b2c3')!.lastRun).toMatchObject({ status: 'skipped' });
    await e.release();
    s.stop();
  });

  it('expires a fixed-session task at the end of its window and says so', async () => {
    const clock = makeClock();
    const e = executor();
    const s = new Scheduler(new ScheduleStore(file), clock, e.exec);
    s.start();
    s.add(task({ at: '+1h', prompt: 'check' }));
    await clock.advance(25 * 3_600_000);
    expect(e.runs).toHaveLength(1);
    // A one-shot is done after its run; a recurring fixed task is the one that expires.
    s.add(task({ cron: '0 * * * *', prompt: 'hourly' }, 'b2c3d4', clock.now()));
    await clock.advance(25 * 3_600_000);
    expect(new ScheduleStore(file).get('b2c3d4')!.state).toBe('expired');
    expect(e.exec.notified).toEqual(['b2c3d4:expired']);
    expect(e.runs.filter((r) => r.id === 'b2c3d4')).toHaveLength(24);
    s.stop();
    // The fake clock ticks a minute at a time through 25 simulated hours, so this runs ~1500
    // timers: 5s (the default) is a machine-speed test, not a test of the scheduler.
  }, 30_000);

  it('pausing stops runs; resuming does not replay what was skipped', async () => {
    const clock = makeClock();
    const e = executor();
    const s = new Scheduler(new ScheduleStore(file), clock, e.exec);
    s.start();
    s.add(task({ cron: '*/10 * * * *', bash: 'true' }));
    expect(s.setPaused('a1b2c3', true)).toMatchObject({ state: 'paused' });
    await clock.advance(30 * MIN);
    expect(e.runs).toEqual([]);
    expect(s.setPaused('a1b2c3', false)).toMatchObject({ state: 'active' });
    await clock.advance(0);
    expect(e.runs).toEqual([]);
    await clock.advance(10 * MIN);
    expect(e.runs).toEqual([{ id: 'a1b2c3', planned: NOW + 40 * MIN }]);
    s.stop();
  });

  it('refuses to resume an expired task, and says why', () => {
    const store = new ScheduleStore(file);
    store.put({ ...task({ cron: '0 * * * *', prompt: 'x' }), state: 'expired' });
    const s = new Scheduler(store, makeClock(), executor().exec);
    expect(s.setPaused('a1b2c3', false)).toMatch(/has expired/);
  });

  it('run now makes an extra run without disturbing the schedule', async () => {
    const clock = makeClock();
    const e = executor();
    const s = new Scheduler(new ScheduleStore(file), clock, e.exec);
    s.start();
    s.add(task({ at: '+1h', bash: 'true' }));
    s.runNow('a1b2c3');
    await clock.advance(0);
    expect(e.runs).toHaveLength(1);
    expect(new ScheduleStore(file).get('a1b2c3')).toMatchObject({ state: 'active', runs: 1 });
    await clock.advance(3_600_000);
    expect(e.runs).toHaveLength(2);
    expect(new ScheduleStore(file).get('a1b2c3')!.state).toBe('done');
    s.stop();
  });
});

describe('ScheduleStore', () => {
  it('writes the file owner-only', () => {
    new ScheduleStore(file).put(task({ at: '+1h', bash: 'true' }));
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('drops a bad entry and keeps the rest', () => {
    const good = task({ at: '+1h', bash: 'true' });
    fs.writeFileSync(file, JSON.stringify({ version: 1, tasks: [good, { id: 'zz99', name: 'broken' }] }));
    const store = new ScheduleStore(file);
    expect(store.list().map((t) => t.id)).toEqual(['a1b2c3']);
  });
});
