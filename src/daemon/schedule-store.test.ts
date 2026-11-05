import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScheduleStore } from './schedule-store.js';

/**
 * The task file's shape across versions. What matters: a file written before a field existed
 * still loads (no migration step), and an entry the scheduler could not run is dropped loudly
 * rather than taken in.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function fileWith(tasks: unknown[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-store-'));
  dirs.push(dir);
  const file = path.join(dir, 'schedules.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, tasks }));
  return file;
}

const base = {
  id: 'a1b2c3',
  name: 'brief',
  when: { cron: '0 8 * * *', tz: 'Asia/Shanghai' },
  target: { platform: 'web', channel: 'main', thread: 't1' },
  state: 'active',
  createdAt: 1,
  createdBy: { conversation: 'web#main#t1', platform: 'web' },
  runs: 0,
};

describe('ScheduleStore', () => {
  it('loads a task written before daily sessions existed, with nothing added', () => {
    const store = new ScheduleStore(
      fileWith([{ ...base, run: { kind: 'agent', agent: 'cc', prompt: 'x', session: 'new' } }])
    );
    expect(store.get('a1b2c3')).toMatchObject({ run: { session: 'new' } });
    expect(store.get('a1b2c3')!.daySession).toBeUndefined();
  });

  it('keeps the day session a daily task remembers', () => {
    const daySession = { day: '2026-11-04', conversation: 'web#main#t9', address: { channel: 'main', thread: 't9' } };
    const store = new ScheduleStore(
      fileWith([{ ...base, run: { kind: 'agent', agent: 'cc', prompt: 'x', session: 'daily' }, daySession }])
    );
    expect(store.get('a1b2c3')!.daySession).toEqual(daySession);
  });

  it('drops a daily task with a one-shot time, and says which field is wrong', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = new ScheduleStore(
      fileWith([
        {
          ...base,
          when: { at: 1_800_000_000_000, tz: 'Asia/Shanghai' },
          run: { kind: 'agent', agent: 'cc', prompt: 'x', session: 'daily' },
        },
      ])
    );
    expect(store.list()).toEqual([]);
    expect(error.mock.calls[0]!.join(' ')).toMatch(/daily-session task needs a cron/);
  });

  it('keeps a model a new or daily task names', () => {
    for (const session of ['new', 'daily'] as const) {
      const store = new ScheduleStore(
        fileWith([{ ...base, run: { kind: 'agent', agent: 'cc', prompt: 'x', session, model: 'deepseek-v4-flash' } }])
      );
      expect(store.get('a1b2c3')!.run).toMatchObject({ session, model: 'deepseek-v4-flash' });
    }
  });

  it('drops a fixed-session task that names a model, and says why', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = new ScheduleStore(
      fileWith([
        {
          ...base,
          conversation: 'web#main#t1',
          run: { kind: 'agent', agent: 'cc', prompt: 'x', session: 'fixed', model: 'deepseek-v4-flash' },
        },
      ])
    );
    expect(store.list()).toEqual([]);
    expect(error.mock.calls[0]!.join(' ')).toMatch(/fixed-session task cannot name a model/);
  });

  it('round-trips a daily task through a reload', () => {
    const file = fileWith([{ ...base, run: { kind: 'agent', agent: 'cc', prompt: 'x', session: 'daily' } }]);
    const store = new ScheduleStore(file);
    store.put({
      ...store.get('a1b2c3')!,
      daySession: { day: '2026-11-04', conversation: 'web#main#t9', address: { channel: 'main', thread: 't9' } },
    });
    expect(new ScheduleStore(file).get('a1b2c3')!.daySession).toMatchObject({ day: '2026-11-04' });
  });
});
