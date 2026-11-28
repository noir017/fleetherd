import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { renderResult, runReverse } from './reverse.js';
import type { ScheduleTaskView, SessionListResult, SessionReadResult, SessionSearchResult, TaskReadResult } from '../ipc/protocol.js';
import { SkillLibrary } from '../daemon/skill-library.js';
import { createSkill, writeSkillFile } from '../daemon/skills-store.js';

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

describe('skills show output', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reverse-skill-show-'));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
  createSkill({ name: 'deploy-check', description: 'Use when checking a deploy', body: 'the body', now: 0 }, dir);
  writeSkillFile({ name: 'deploy-check', file: 'references/more.md', content: 'more', now: 0 }, dir);
  createSkill({ name: 'bare', description: 'Use when nothing else applies', body: 'bare body', now: 0 }, dir);
  const library = new SkillLibrary(() => dir);
  const asker = { agent: 'cc', host: 'local', harness: 'claude' };
  const show = (name: string, file?: string): string =>
    renderResult({ kind: 'skills', action: 'show', name }, library.show(name, file, asker, true, 0)).stdout;

  it('prints the skill\'s other files, which show --file reads one of', () => {
    const out = show('deploy-check');
    expect(out).toMatch(/^files: references\/more\.md$/m);
    expect(out).toContain('\n\nthe body');
  });

  it('prints no files line when one of them is what was read, or when there are none', () => {
    const one = show('deploy-check', 'references/more.md');
    expect(one).toMatch(/^file: references\/more\.md$/m);
    expect(one).not.toMatch(/^files:/m);
    expect(show('bare')).not.toMatch(/^files:/m);
  });
});

describe('task-read output', () => {
  const at = '2026-11-05T00:00:00.000Z';
  const taskRead = (data: TaskReadResult, action: Record<string, unknown> = {}): string =>
    renderResult({ kind: 'task-read', topic: 'web:main/t1', ...action }, data).stdout;

  it('prints --reply as prose: one header, then the body verbatim', () => {
    const out = taskRead(
      { topic: 'web:main/t1', messages: [], reply: { turn: 2, at, text: '第一行\n第二行，结论：合。' } },
      { reply: true }
    );
    expect(out).toMatch(/^topic: web:main\/t1$/m);
    expect(out).toMatch(/^turn: 2$/m);
    // The body is not one quoted line of `\n` escapes.
    expect(out).toContain('第一行\n第二行，结论：合。');
    expect(out).not.toContain('\\n');
    expect(out).not.toContain('count: 0');
  });

  it('accepts --reply --full, since the reply is whole either way', () => {
    const out = taskRead(
      { topic: 'web:main/t1', messages: [], reply: { turn: 2, at, text: 'ok' } },
      { reply: true, full: true }
    );
    expect(out).toContain('ok');
  });

  it('prints a single turn whole with --turn n --full, its body verbatim', () => {
    const out = taskRead(
      {
        topic: 'web:main/t1',
        messages: [{ id: 9, role: 'agent', at, text: '第一段\n第二段', turn: 3, outcome: 'done' }],
        turn: { turn: 3, at, outcome: 'done', agent: 'cc' },
      },
      { turn: '3', full: true }
    );
    expect(out).toMatch(/^turn: 3$/m);
    expect(out).toMatch(/^outcome: done$/m);
    expect(out).toMatch(/#9 agent .*\n第一段\n第二段/);
    expect(out).not.toContain('\\n');
  });

  it('keeps a plain --turn read a table, so a row keeps its fields', () => {
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

describe('task-agents output', () => {
  const detail = {
    agent: { id: 'gt', harness: 'custom', where: 'far', here: false, model: '', root: '/w', dirs: ['a', 'b'], permissions: 'ask', running: 2, cooling: true },
    models: [
      { value: 'base', name: 'Base', default: true },
      { value: 'fast', name: 'Fast', default: false },
    ],
    settings: [
      { id: 'account', label: 'Account', value: 'alice@example.com', name: 'Alice', note: '', default: true },
      { id: 'account', label: 'Account', value: 'bob@example.com', name: 'Bob', note: 'quota used up', default: false },
    ],
  };

  it('prints one agent in full as tables a model reads at a glance, and the list as before', () => {
    const out = renderResult({ kind: 'task-agents', agent: 'gt' }, detail).stdout;
    expect(out).toContain('dirs: "a, b"');
    expect(out).toContain('models[2]{value,name,default}:');
    expect(out).toContain('settings[2]{id,label,value,name,note,default}:');
    expect(out).toContain('account,Account,bob@example.com,Bob,quota used up,false');
    expect(out).toContain('task-new --agent <id> [--model <value>] [--option <id>=<value>');
    expect(out).not.toContain('error');
    const list = renderResult({ kind: 'task-agents' }, { agents: [detail.agent] }).stdout;
    expect(list).toContain('here=true: on the same machine as you');
  });

  it('says why the lists are empty when the agent could not be asked', () => {
    const out = renderResult({ kind: 'task-agents', agent: 'gt' }, { ...detail, models: [], settings: [], error: 'no answer in 45s' }).stdout;
    expect(out).toContain('error: no answer in 45s');
  });
});

describe('sessions list output', () => {
  const row = (id: number, key: string, lastAt = '2026-11-05T00:00:00.000Z'): SessionListResult['sessions'][number] => ({
    id,
    key,
    platform: 'web',
    title: `t${id}`,
    agent: 'cc',
    host: '',
    cwd: '',
    kind: 'normal',
    startedAt: lastAt,
    lastAt,
    messages: 1,
  });

  it('prints each row’s key, so the two id spaces line up', () => {
    const out = renderResult({ kind: 'sessions-list' }, {
      sessions: [row(7, 'web#main#c962cd3f')],
      days: 7,
      limit: 30,
    } satisfies SessionListResult).stdout;
    expect(out).toContain('web#main#c962cd3f');
  });

  it('says a full page may have more, and names the id and window to continue from', () => {
    const out = renderResult({ kind: 'sessions-list' }, {
      sessions: [row(9, 'web#main#a'), row(5, 'web#main#b')],
      days: 30,
      limit: 2,
    } satisfies SessionListResult).stdout;
    // Without --days the next page would fall back to 7 days, where these rows are not.
    expect(out).toContain('--days 30 --before 5');
  });

  it('says nothing about paging when the page is not full', () => {
    const out = renderResult({ kind: 'sessions-list' }, {
      sessions: [row(9, 'web#main#a')],
      days: 7,
      limit: 30,
    } satisfies SessionListResult).stdout;
    expect(out).not.toContain('--before');
  });
});

describe('sessions search output', () => {
  const search = (data: SessionSearchResult, action: Record<string, unknown> = {}): string =>
    renderResult({ kind: 'sessions-search', query: 'x', ...action }, data).stdout;

  it('names the library’s agents when --agent matches none, instead of blaming the library', () => {
    const out = search({ hits: [], limit: 10, agents: ['ag@uniagent', 'cc'] }, { agent: 'ag' });
    expect(out).toContain('no agent ag in the library');
    expect(out).toContain('ag@uniagent');
    expect(out).not.toContain('only holds conversations');
  });

  it('says the words matched nothing for a known agent, not that the agent is missing', () => {
    const out = search({ hits: [], limit: 10, agents: ['ag', 'cc'] }, { agent: 'ag' });
    expect(out).toContain('nothing matches those words for agent ag');
    expect(out).not.toContain('no agent ag in the library');
  });

  it('keeps the coverage note for a search with no agent filter', () => {
    const out = search({ hits: [], limit: 10 });
    expect(out).toContain('only holds conversations');
  });

  it('says a full hit list may have more', () => {
    const out = search(
      {
        hits: [
          { session: 1, message: 2, at: '2026-11-05T00:00:00.000Z', title: 't', agent: 'cc', platform: 'web', kind: 'normal', role: 'user', excerpt: 'x' },
        ],
        limit: 1,
      }
    );
    expect(out).toContain('there may be more');
  });
});

describe('sessions read output', () => {
  it('suggests --tail when a --role tool answer is over 50 KB, counting bytes', () => {
    // 200 Han characters are 600 bytes: the answer is under 50k characters but over 50 KB, which
    // is the bound a harness persists at.
    const many = Array.from({ length: 150 }, (_, i) => ({
      id: i + 1,
      at: '2026-11-05T00:00:00.000Z',
      role: 'tool',
      kind: 'normal',
      text: '汉'.repeat(200),
      turn: 1,
      outcome: 'done',
      agent: 'cc',
    }));
    const out = renderResult(
      { kind: 'sessions-read', session: '#7', role: 'tool' },
      { session, messages: many } satisfies SessionReadResult
    ).stdout;
    expect(Buffer.byteLength(out, 'utf8')).toBeGreaterThan(50_000);
    expect(out).toContain('--tail <n>');
    expect(out).toContain('--since <id>');
  });

  it('leaves a small --role tool answer alone', () => {
    const out = renderResult(
      { kind: 'sessions-read', session: '#7', role: 'tool' },
      {
        session,
        messages: [{ id: 1, at: '2026-11-05T00:00:00.000Z', role: 'tool', kind: 'normal', text: 'ls', turn: 1, outcome: 'done', agent: 'cc' }],
      } satisfies SessionReadResult
    ).stdout;
    expect(out).not.toContain('--tail <n>');
  });
});

describe('pods output', () => {
  it('prints the table before the gatewayKey line', () => {
    const out = renderResult({ kind: 'pod-list' }, {
      gatewayKey: 'restrict,from="192.0.2.1",command="/x" ssh-ed25519 AAAA',
      pods: [{ pod: 'laptop', ssh: 'user@192.0.2.9:10022', agents: 'cc@laptop' }],
    }).stdout;
    expect(out.indexOf('laptop')).toBeLessThan(out.indexOf('gatewayKey'));
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

describe('runReverse', () => {
  it("dials the socket it was handed, with no gateway config under the agent's HOME", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetherd-reverse-'));
    const sock = path.join(dir, 'd.sock');
    const asked: unknown[] = [];
    const server = net.createServer((c) => {
      let buf = '';
      c.on('data', (d) => {
        buf += String(d);
        if (!buf.includes('\n')) return;
        asked.push(JSON.parse(buf.slice(0, buf.indexOf('\n'))));
        c.end(JSON.stringify({ ok: true, data: { sessions: [], days: 7, limit: 30 } }) + '\n');
      });
    });
    await new Promise<void>((resolve) => server.listen(sock, resolve));
    const saved = { ...process.env };
    const exitCode = process.exitCode;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      Object.assign(process.env, {
        FLEETHERD_SOCKET: sock,
        FLEETHERD_TURN_TOKEN: 'tok',
        FLEETHERD_CONFIG_DIR: path.join(dir, 'no-config-here'),
      });
      await runReverse({ kind: 'sessions-list' });
      expect(process.exitCode).toBe(exitCode);
      expect(asked).toEqual([{ token: 'tok', action: { kind: 'sessions-list' } }]);
    } finally {
      log.mockRestore();
      process.exitCode = exitCode;
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
      server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
