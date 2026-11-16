import { describe, expect, it } from 'vitest';
import { buildTask, type NewTaskInput, type ScheduleTask } from '../core/schedule.js';
import { panelEditInput, panelTask, panelTaskDetail, panelTasks, type PanelDetailContext } from './schedule-panel.js';

/**
 * The daemon's half of the web UI's task panel. What matters here is that the page is handed
 * absolute times and already-written sentences rather than a domain object it would have to
 * interpret, and that the list is ordered the way a person glances at it: next first.
 */

const NOW = Date.UTC(2026, 10, 4, 2, 0, 0); // 10:00 Shanghai

function task(input: NewTaskInput, id = 'a1b2c3', now = NOW): ScheduleTask {
  const r = buildTask(input, {
    now,
    id,
    defaultTz: 'Asia/Shanghai',
    agents: ['cc'],
    from: { key: 'web#main#t1', platform: 'web', agent: 'cc' },
    target: { platform: 'web', address: { channel: 'main', thread: 't1' } },
    targetConversation: { key: 'web#main#t1', agent: 'cc' },
    canOpenTopic: true,
  });
  if (!r.ok) throw new Error(r.error);
  return r.task;
}

describe('the web UI task panel', () => {
  it('hands the page the next run as an absolute time and as a sentence in the task zone', () => {
    const t = task({ name: 'Morning CI', cron: '0 8 * * *', prompt: 'summarise the failures' });

    const view = panelTask(t, NOW, false, 'web');

    expect(view.when).toBe('0 8 * * * (Asia/Shanghai)');
    // 08:00 Shanghai is 00:00 UTC on the same date.
    expect(view.next).toBe('2026-11-05 08:00');
    expect(view.nextAt).toBe(Date.UTC(2026, 10, 4, 0, 0, 0) + 24 * 3_600_000);
    expect(view.run).toBe('cc · fixed session');
    expect(view.detail).toBe('summarise the failures');
    expect(view.kind).toBe('agent');
    expect(view.running).toBe(false);
  });

  it('hands the page the tags and the registration time, for its Tags filter and Created sort', () => {
    const tagged = panelTask(task({ cron: '0 8 * * *', prompt: 'x', tags: ['ci', 'release'] }), NOW, false, 'web');
    expect(tagged.tags).toEqual(['ci', 'release']);
    expect(tagged.createdAt).toBe(NOW);
    // The DTO always spells the field, empty included: the page draws chips from it either way.
    expect(panelTask(task({ cron: '0 8 * * *', prompt: 'x' }), NOW, false, 'web').tags).toEqual([]);
  });

  it('names a topic only when the task posts into this very instance', () => {
    const here = task({ cron: '0 8 * * *', prompt: 'x' });
    expect(panelTask(here, NOW, false, 'web').targetTopic).toBe('t1');
    expect(panelTask(here, NOW, false, 'telegram').targetTopic).toBeUndefined();
  });

  it('spells out a bash task, its host and its timeout', () => {
    const t = task({ cron: '0 2 * * *', bash: 'pg_dump app', timeoutMs: 90_000 });
    const view = panelTask(t, NOW, true, 'web');

    expect(view.run).toBe('bash · 2m');
    expect(view.detail).toBe('pg_dump app');
    expect(view.kind).toBe('bash');
    expect(view.running).toBe(true);
  });

  it('formats the last run in the task zone, error and all', () => {
    const t = task({ cron: '0 8 * * *', prompt: 'x' });
    const withRun: ScheduleTask = {
      ...t,
      lastRun: { at: Date.UTC(2026, 10, 3, 0, 0, 0), status: 'failed', durationMs: 4200, error: 'exit 1' },
    };

    const view = panelTask(withRun, NOW, false, 'web');

    expect(view.last?.atText).toBe('2026-11-03 08:00');
    expect(view.last?.status).toBe('failed');
    expect(view.last?.error).toBe('exit 1');
  });

  it('orders active by next run, then paused, then ended', () => {
    const later = task({ name: 'later', cron: '0 18 * * *', prompt: 'x' }, 'bbbbbb');
    const sooner = task({ name: 'sooner', cron: '30 10 * * *', prompt: 'x' }, 'aaaaaa');
    const paused = { ...task({ name: 'paused', cron: '0 9 * * *', prompt: 'x' }, 'cccccc'), state: 'paused' as const };
    const done = { ...task({ name: 'done', at: '+1h', prompt: 'x' }, 'dddddd'), state: 'done' as const };

    const list = panelTasks([done, paused, later, sooner], NOW, () => false, 'web');

    expect(list.map((t) => t.name)).toEqual(['sooner', 'later', 'paused', 'done']);
  });

  it('keeps the store order among equals, so a refresh does not shuffle the list', () => {
    const a = { ...task({ name: 'a', cron: '0 8 * * *', prompt: 'x' }, 'aaaaaa'), state: 'paused' as const };
    const b = { ...task({ name: 'b', cron: '0 8 * * *', prompt: 'x' }, 'bbbbbb'), state: 'paused' as const };

    expect(panelTasks([a, b], NOW, () => false, 'web').map((t) => t.name)).toEqual(['a', 'b']);
    expect(panelTasks([b, a], NOW, () => false, 'web').map((t) => t.name)).toEqual(['b', 'a']);
  });
});

/**
 * A task's page. The form is filled from `fields`, so they must be the task's own raw values; what
 * it offers is `editable`, which has to agree with what editTask would refuse; and every run has
 * to say where its output went — a topic here the page can open, or a name for somewhere else.
 */
describe("the web UI task page", () => {
  const lanes: Record<string, { platformId: string; address: { channel: string; thread?: string } }> = {
    'web#main#r1': { platformId: 'web', address: { channel: 'main', thread: 'r1' } },
    'tg#-100#7': { platformId: 'tg', address: { channel: '-100', thread: '7' } },
    'web#main#': { platformId: 'web', address: { channel: 'main' } },
  };
  const ctx: PanelDetailContext = { now: NOW, running: false, instance: 'web', agents: ['cc', 'oc'], laneOf: (k) => lanes[k] };

  it('hands the form the raw values and only the fields an edit of that kind can change', () => {
    const fixed = panelTaskDetail(task({ name: 'CI', cron: '0 8 * * *', prompt: 'summarise' }), ctx);
    expect(fixed.fields).toEqual({ name: 'CI', cron: '0 8 * * *', tz: 'Asia/Shanghai', prompt: 'summarise', agent: 'cc', session: 'fixed' });
    // A fixed session runs in a person's topic, which keeps its own directory and model.
    expect(fixed.editable).toEqual(['name', 'cron', 'tz', 'at', 'prompt', 'agent']);
    expect(fixed.agents).toEqual(['cc', 'oc']);
    expect(fixed.task.id).toBe('a1b2c3');

    const fresh = panelTaskDetail(task({ cron: '0 8 * * *', prompt: 'p', session: 'new', cwd: '/srv/app', model: 'm1' }), ctx);
    expect(fresh.fields).toMatchObject({ session: 'new', cwd: '/srv/app', model: 'm1' });
    expect(fresh.editable).toEqual(['name', 'cron', 'tz', 'at', 'prompt', 'agent', 'model', 'cwd']);

    // A daily session takes only a cron: a one-shot has no rest of the day to join.
    expect(panelTaskDetail(task({ cron: '0 8 * * *', prompt: 'p', session: 'daily' }), ctx).editable).not.toContain('at');

    const bash = panelTaskDetail(task({ cron: '0 2 * * *', bash: 'pg_dump app', timeoutMs: 90_000 }), ctx);
    expect(bash.fields).toEqual({ name: 'pg_dump app', cron: '0 2 * * *', tz: 'Asia/Shanghai', command: 'pg_dump app', timeoutMs: 90_000 });
    expect(bash.editable).toEqual(['name', 'cron', 'tz', 'at', 'command', 'timeout', 'cwd']);
  });

  it('gives a one-shot time as the wall clock in its own zone, the form --at reads', () => {
    const once = panelTaskDetail(task({ at: '2026-11-05 09:30', prompt: 'p', session: 'new' }), ctx);
    expect(once.fields).toMatchObject({ at: '2026-11-05 09:30', tz: 'Asia/Shanghai' });
    expect(once.fields.cron).toBeUndefined();
  });

  it('says why a task that is over cannot be edited', () => {
    const t = task({ cron: '0 8 * * *', prompt: 'p' });
    expect(panelTaskDetail(t, ctx).locked).toBeUndefined();
    expect(panelTaskDetail({ ...t, state: 'expired' }, ctx).locked).toMatch(/has expired/);
    expect(panelTaskDetail({ ...t, state: 'done' }, ctx).locked).toMatch(/one-time task and has already had its run/);
  });

  it('turns each run into a topic of this page, a named place elsewhere, or nothing it cannot know', () => {
    const t = task({ cron: '0 8 * * *', prompt: 'p', session: 'new' });
    const page = panelTaskDetail(
      {
        ...t,
        history: [
          { at: NOW, status: 'ok', durationMs: 4000, conversation: 'web#main#r1' },
          { at: NOW - 1, status: 'failed', error: 'boom', conversation: 'tg#-100#7' },
          { at: NOW - 2, status: 'ok', conversation: 'web#main#' },
          { at: NOW - 3, status: 'ok', conversation: 'swept#key' },
          { at: NOW - 4, status: 'missed', error: 'the gateway was down' },
        ],
      },
      ctx
    );
    expect(page.runs).toEqual([
      { at: NOW, atText: '2026-11-04 10:00', status: 'ok', durationMs: 4000, topic: 'r1' },
      { at: NOW - 1, atText: '2026-11-04 09:59:59', status: 'failed', error: 'boom', where: 'tg:-100/7' },
      // The channel itself is no topic to open: named, like a chat elsewhere.
      { at: NOW - 2, atText: '2026-11-04 09:59:59', status: 'ok', where: 'web:main' },
      { at: NOW - 3, atText: '2026-11-04 09:59:59', status: 'ok' },
      { at: NOW - 4, atText: '2026-11-04 09:59:59', status: 'missed', error: 'the gateway was down' },
    ]);
    // A task written before run history existed still shows its last run.
    expect(panelTaskDetail({ ...t, lastRun: { at: NOW, status: 'ok' } }, ctx).runs).toEqual([{ at: NOW, atText: '2026-11-04 10:00', status: 'ok' }]);
  });

  it('turns the page edit into schedule edit input: command is --bash, nulls pass through', () => {
    expect(panelEditInput({ command: 'ls', cwd: null, model: null, name: 'n' })).toEqual({ bash: 'ls', cwd: null, model: null, name: 'n' });
    expect(panelEditInput({ prompt: 'p' })).toEqual({ prompt: 'p' });
  });
});
