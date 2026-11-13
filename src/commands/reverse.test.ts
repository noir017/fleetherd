import { describe, expect, it } from 'vitest';
import { renderResult } from './reverse.js';
import type { ScheduleTaskView, SessionReadResult, TaskReadResult } from '../ipc/protocol.js';

/** What an agent reads for `sessions read`: the row fields it must not have to guess at. */

const session: SessionReadResult['session'] = {
  id: 7,
  key: 'tg#x#',
  platform: 'tg',
  title: '话题',
  agent: 'cc',
  host: '',
  cwd: '',
  kind: 'normal',
  startedAt: '2026-11-05T00:00:00.000Z',
  lastAt: '2026-11-05T00:00:00.000Z',
  messages: 1,
};

const read = (data: SessionReadResult): string =>
  renderResult({ kind: 'sessions-read', session: '#7' }, data).stdout;

describe('sessions read output', () => {
  it('prints a row from before turns as unknown, never as a guessed number', () => {
    const out = read({
      session,
      messages: [
        {
          id: 3,
          at: '2026-11-05T00:00:00.000Z',
          role: 'user',
          kind: 'normal',
          text: '旧问题',
          turn: null,
          outcome: null,
          agent: '',
        },
      ],
    });
    // The table's turn and outcome columns say ?, unknown — not a number and not done.
    expect(out).toMatch(/user,\?,unknown,/);
    expect(out).toContain('旧问题');
  });

  it('carries the store note when a filtered read has nothing to show', () => {
    // Right after `/new` there is no finished turn in the new generation; the note is the
    // answer, and must not be replaced by "this conversation has no messages".
    const note = 'no turn of conversation 7 has ended normally for agent cc in generation 1 yet';
    const out = read({ session, messages: [], note });
    expect(out).toContain(note);
    expect(out).not.toContain('this conversation has no messages');
  });

  it('says a filtered read matched nothing, not that the conversation is empty', () => {
    const out = renderResult(
      { kind: 'sessions-read', session: '#7', grep: '找不到' },
      { session, messages: [] }
    ).stdout;
    expect(out).toContain('no rows match this filter');
    expect(out).not.toContain('this conversation has no messages');
  });
});

describe('task-read output', () => {
  const at = '2026-11-05T00:00:00.000Z';
  const taskRead = (data: TaskReadResult, action: Record<string, unknown> = {}): string =>
    renderResult({ kind: 'task-read', topic: 'web:main/t1', ...action }, data).stdout;

  it('prints --reply on its own, not as an empty message list', () => {
    const out = taskRead(
      { topic: 'web:main/t1', messages: [], reply: { turn: 2, at, text: 'Verdict: merge after one fix.' } },
      { reply: true }
    );
    expect(out).toContain('Verdict: merge after one fix.');
    expect(out).not.toContain('count: 0');
  });

  it('carries the turn record beside its rows, so a failed turn’s error is readable', () => {
    const out = taskRead({
      topic: 'web:main/t1',
      messages: [{ id: 9, role: 'user', at, text: 'go', turn: 3, outcome: 'failed' }],
      turn: { turn: 3, at, outcome: 'failed', agent: 'cc', detail: 'Process exited 1:\nboom' },
    });
    expect(out).toContain('#9');
    expect(out).toContain('failed');
    expect(out).toContain('Process exited 1:');
  });

  it('says why there is no reply, not that the topic is empty', () => {
    const note = 'no turn in this topic has ended normally yet — nothing to reply with';
    const out = taskRead({ topic: 'web:main/t1', messages: [], note }, { reply: true });
    expect(out).toContain(note);
    expect(out).not.toContain('nothing has been said there yet');
  });
});

describe('schedule run --wait output', () => {
  const task: ScheduleTaskView = {
    id: 'a1b2c3',
    name: 'backup',
    tags: '',
    state: 'active',
    when: '`0 3 * * *` (Asia/Shanghai)',
    next: '2026-11-14 03:00',
    runs: 'gateway · bash · 10m limit',
    target: 'web:main/t1',
    last: 'ok 2026-11-13 03:00',
    count: 4,
    expires: '',
    here: true,
  };

  it('prints the run\'s own record beside the task, so the agent need not poll', () => {
    const out = renderResult({ kind: 'schedule-op', id: 'a1b2c3', op: 'run', waitMs: 600_000 }, {
      task,
      run: { at: '2026-11-13 10:00', status: 'failed', took: '1.2s', conversation: '', error: 'exit 2' },
    }).stdout;
    expect(out).toContain('failed');
    expect(out).toContain('1.2s');
    expect(out).toContain('exit 2');
  });

  it('carries the note when the wait ran out, so "no result" is not read as "no run"', () => {
    const note = 'still running after 10m; its output is posted to web:main/t1 when it ends';
    const out = renderResult({ kind: 'schedule-op', id: 'a1b2c3', op: 'run', waitMs: 600_000 }, { task, note }).stdout;
    expect(out).toContain(note);
    expect(out).not.toContain('run:');
  });
});
