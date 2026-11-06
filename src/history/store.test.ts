import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
import { HistoryStore } from './store.js';
import type { HistoryOutcome, HistoryTrigger } from './store.js';

const dirs: string[] = [];

function tempStore(): { store: HistoryStore; file: string; logs: string[] } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'talkcode-history-'));
  dirs.push(dir);
  const file = path.join(dir, 'history.db');
  const logs: string[] = [];
  const store = new HistoryStore(file, (m) => logs.push(m));
  return { store, file, logs };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** One conversation with a fixed cast of messages, at fixed times. */
function seed(store: HistoryStore): number {
  const at = Date.UTC(2026, 10, 1, 9, 0);
  const id = store.session({
    key: 'webui#main#abcdef12',
    platform: 'webui',
    title: '跨会话查询',
    agent: 'cc',
    host: '',
    cwd: '/home/user/workspace/talkcode',
    kind: 'normal',
    at,
  })!;
  store.message(id, { ts: at, role: 'user', kind: 'normal', text: '帮我实现跨会话查询' });
  store.message(id, { ts: at + 1_000, role: 'tool', kind: 'normal', text: 'Bash: git status' });
  store.message(id, { ts: at + 2_000, role: 'agent', kind: 'normal', text: '查询做完了，测试全过。' });
  return id;
}

describe('HistoryStore', () => {
  it('creates the database and its WAL companions 0600', () => {
    const { store, file } = tempStore();
    // A write creates the WAL and SHM files; SQLite creates them under the process umask (0644),
    // not the database's own mode, so the store has to lock them down too.
    seed(store);
    for (const suffix of ['', '-wal', '-shm']) {
      expect(fs.existsSync(`${file}${suffix}`), `${file}${suffix} exists`).toBe(true);
      expect(fs.statSync(`${file}${suffix}`).mode & 0o777, `${file}${suffix}`).toBe(0o600);
    }
    store.close();
  });

  it('finds a two-character Chinese word', () => {
    const { store } = tempStore();
    seed(store);
    const hits = store.search('查询');
    expect(hits).toHaveLength(2);
    expect(hits.every((h) => h.excerpt.includes('查询'))).toBe(true);
    store.close();
  });

  it('finds a longer Chinese phrase', () => {
    const { store } = tempStore();
    seed(store);
    const hits = store.search('跨会话查询');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.title).toBe('跨会话查询');
    store.close();
  });

  it('falls back to LIKE for a single character', () => {
    const { store } = tempStore();
    seed(store);
    const hits = store.search('查');
    expect(hits.length).toBe(2);
    store.close();
  });

  it('finds English words, in a tool call only when asked to', () => {
    const { store } = tempStore();
    seed(store);
    // The only row with these words is a tool call, and a search leaves those out by default.
    expect(store.search('git status')).toHaveLength(0);
    const hits = store.search('git status', { tools: true });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.role).toBe('tool');
    expect(hits[0]!.excerpt).toBe('Bash: git status');
    store.close();
  });

  it('puts scheduled-task hits after ordinary conversations', () => {
    const { store } = tempStore();
    const at = Date.UTC(2026, 10, 2, 9, 0);
    const normal = store.session({ key: 'tg#1#', platform: 'tg', agent: 'cc', kind: 'normal', at })!;
    const task = store.session({ key: 'schedule#t1#2026', platform: 'tg', agent: 'cc', kind: 'schedule', at })!;
    // The scheduled row is NEWER, so only the kind ordering can put it second.
    store.message(normal, { ts: at, role: 'user', kind: 'normal', text: '检查部署状态' });
    store.message(task, { ts: at + 1_000, role: 'user', kind: 'schedule', text: '检查部署状态' });
    const hits = store.search('部署');
    expect(hits.map((h) => h.kind)).toEqual(['normal', 'schedule']);
    store.close();
  });

  it('filters by agent and by age', () => {
    const { store } = tempStore();
    const now = Date.now();
    const a = store.session({ key: 'a', platform: 'tg', agent: 'cc', at: now })!;
    const b = store.session({ key: 'b', platform: 'tg', agent: 'oc', at: now - 10 * 86_400_000 })!;
    store.message(a, { ts: now, role: 'user', kind: 'normal', text: '同一个词' });
    store.message(b, { ts: now - 10 * 86_400_000, role: 'user', kind: 'normal', text: '同一个词' });
    expect(store.search('同一个词', { agent: 'oc' })).toHaveLength(1);
    expect(store.search('同一个词', { days: 1 })).toHaveLength(1);
    expect(store.search('同一个词', { days: 30 })).toHaveLength(2);
    store.close();
  });

  it('reads a window around a hit', () => {
    const { store } = tempStore();
    const id = seed(store);
    const hit = store.search('查询').find((h) => h.role === 'agent')!;
    const read = store.read(`#${id}`, { around: hit.message, window: 1 });
    expect(read.session.id).toBe(id);
    expect(read.messages.map((m) => m.role)).toEqual(['tool', 'agent']);
    expect(read.messages[1]!.id).toBe(hit.message);
    store.close();
  });

  it('reads a conversation whole and rejects an id from another one', () => {
    const { store } = tempStore();
    const id = seed(store);
    const all = store.read(String(id));
    expect(all.messages).toHaveLength(3);
    expect(all.messages.map((m) => m.role)).toEqual(['user', 'tool', 'agent']);
    expect(() => store.read(String(id), { around: 999 })).toThrow(/not in conversation/);
    expect(() => store.read('nope')).toThrow(/no conversation/);
    store.close();
  });

  it('lists recent conversations, newest first', () => {
    const { store } = tempStore();
    const at = Date.now();
    const old = store.session({ key: 'old', platform: 'tg', title: 'old', at: at - 10 * 86_400_000 })!;
    const recent = store.session({ key: 'recent', platform: 'tg', title: 'recent', at })!;
    store.message(old, { ts: at - 10 * 86_400_000, role: 'user', kind: 'normal', text: 'old' });
    store.message(recent, { ts: at, role: 'user', kind: 'normal', text: 'recent' });
    expect(store.list({ days: 7 }).map((s) => s.key)).toEqual(['recent']);
    expect(store.list({ days: 30 }).map((s) => s.key)).toEqual(['recent', 'old']);
    store.close();
  });

  it('keeps a conversation named after it is created', () => {
    const { store } = tempStore();
    const id = seed(store);
    store.setTitle('webui#main#abcdef12', '新名字');
    expect(store.read(String(id)).session.title).toBe('新名字');
    store.close();
  });

  it('swallows a write failure instead of throwing at the caller', () => {
    const { store, logs } = tempStore();
    const id = seed(store);
    store.close();
    // A closed database is the simplest stand-in for a full disk: the write cannot succeed.
    expect(() => store.message(id, { ts: 1, role: 'user', kind: 'normal', text: 'after close' })).not.toThrow();
    expect(logs.some((l) => l.includes('could not record'))).toBe(true);
  });

  it('degrades to a silent store when the file cannot be opened', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'talkcode-history-'));
    dirs.push(dir);
    // A directory where the file should be: DatabaseSync cannot open it.
    const file = path.join(dir, 'history.db');
    fs.mkdirSync(file);
    const logs: string[] = [];
    const store = new HistoryStore(file, (m) => logs.push(m));
    expect(store.available).toBe(false);
    expect(store.session({ key: 'k', platform: 'tg', at: 1 })).toBeUndefined();
    expect(() => store.message(undefined, { ts: 1, role: 'user', kind: 'normal', text: 'x' })).not.toThrow();
    expect(() => store.search('x')).toThrow(/unavailable/);
    expect(logs.some((l) => l.includes('could not open'))).toBe(true);
  });

  it('is idempotent per imported source', () => {
    const { store } = tempStore();
    const at = Date.UTC(2026, 10, 4, 9, 0);
    const meta = { key: 'webui#main#12345678', platform: 'webui', title: 't', kind: 'normal' as const, at };
    const messages = [{ ts: at, role: 'user' as const, kind: 'normal' as const, text: '导入一次' }];
    expect(store.importSession('webui-transcripts-webui/12345678.json', meta, messages)).toBe('imported');
    expect(store.importSession('webui-transcripts-webui/12345678.json', meta, messages)).toBe('skipped');
    expect(store.list({ days: 30 })[0]!.messages).toBe(1);
    store.close();
  });

  describe('review windows', () => {
    /** A conversation with a scheduled turn and a sub-agent turn mixed into it. */
    function seeded(store: HistoryStore): { id: number; last: number } {
      const at = Date.UTC(2026, 10, 4, 9, 0);
      const id = store.session({ key: 'telegram#chat#1', platform: 'telegram', title: '部署', kind: 'normal', at })!;
      store.message(id, { ts: at, role: 'user', kind: 'normal', text: '第一句' });
      store.message(id, { ts: at + 1, role: 'agent', kind: 'normal', text: '好的' });
      store.message(id, { ts: at + 2, role: 'user', kind: 'schedule', text: '定时任务的话' });
      store.message(id, { ts: at + 3, role: 'user', kind: 'subagent', text: '子代理的话' });
      store.message(id, { ts: at + 4, role: 'user', kind: 'normal', text: '第二句' });
      const last = store.session({ key: 'telegram#chat#1', platform: 'telegram', at: at + 5 })!;
      return { id: last, last: at + 4 };
    }

    it('finds a session by its key without reading its messages', () => {
      const { store } = tempStore();
      seeded(store);
      const row = store.sessionOf('telegram#chat#1');
      expect(row?.title).toBe('部署');
      expect(row?.kind).toBe('normal');
      expect(row?.messages).toBe(5);
      expect(store.sessionOf('nope')).toBeUndefined();
      store.close();
    });

    it('counts only the person\'s own turns and leaves scheduled and sub-agent ones out', () => {
      const { store } = tempStore();
      seeded(store);
      const window = store.reviewWindow('telegram#chat#1', 0, 10_000)!;
      expect(window.userMessages).toBe(2);
      expect(window.messages.map((m) => m.text)).toEqual(['第一句', '好的', '第二句']);
      expect(window.dropped).toBe(0);
      store.close();
    });

    it('returns only what came after the watermark', () => {
      const { store } = tempStore();
      seeded(store);
      const first = store.reviewWindow('telegram#chat#1', 0, 10_000)!;
      const second = store.reviewWindow('telegram#chat#1', first.messages[0]!.id, 10_000)!;
      expect(second.userMessages).toBe(1);
      expect(second.messages.map((m) => m.text)).toEqual(['好的', '第二句']);
      store.close();
    });

    it('keeps what the person said before what the agent said when the budget is short', () => {
      const { store } = tempStore();
      seeded(store);
      const window = store.reviewWindow('telegram#chat#1', 0, 6)!;
      // Both of the person's messages (3 + 3) fill the budget; the agent's "好的" is what goes,
      // although it is newer than "第一句".
      expect(window.messages.map((m) => m.text)).toEqual(['第一句', '第二句']);
      expect(window.dropped).toBe(1);
      expect(window.lastMessageId).toBeGreaterThan(window.messages[0]!.id);
      store.close();
    });

    it('leaves tool calls out, and hands over the ones that touched a skill', () => {
      const { store } = tempStore();
      const at = Date.UTC(2026, 10, 6, 9, 0);
      const id = store.session({ key: 'web#main#vlt', platform: 'web', title: 'vlt', kind: 'normal', at })!;
      const add = (i: number, role: 'user' | 'agent' | 'tool', text: string): void =>
        store.message(id, { ts: at + i, role, kind: 'normal', text });
      add(0, 'user', '整理成 skill');
      add(1, 'tool', 'Bash: ls');
      add(2, 'tool', 'Write: /w/agent-skills/skills/vlt/SKILL.md\n{"file_path":"/w/agent-skills/skills/vlt/SKILL.md"}');
      add(3, 'tool', 'Read: /home/u/.talkcode/skills/email-reader/SKILL.md');
      add(4, 'agent', '写好了');
      const window = store.reviewWindow('web#main#vlt', 0, 10_000)!;
      expect(window.messages.map((m) => m.role)).toEqual(['user', 'agent']);
      expect(window.dropped).toBe(0);
      expect(window.skillCalls).toEqual([
        'Write: /w/agent-skills/skills/vlt/SKILL.md\n{"file_path":"/w/agent-skills/skills/vlt/SKILL.md"}',
        'Read: /home/u/.talkcode/skills/email-reader/SKILL.md',
      ]);
      store.close();
    });

    it('drops the oldest replies first, and cuts one oversized message to its head and tail', () => {
      const { store } = tempStore();
      const at = Date.UTC(2026, 10, 6, 10, 0);
      const id = store.session({ key: 'web#main#long', platform: 'web', title: 'long', kind: 'normal', at })!;
      const add = (i: number, role: 'user' | 'agent', text: string): void =>
        store.message(id, { ts: at + i, role, kind: 'normal', text });
      add(0, 'user', '问');
      add(1, 'agent', 'a'.repeat(5_000));
      add(2, 'agent', 'b'.repeat(5_000));
      add(3, 'user', `开头${'x'.repeat(20_000)}结尾`);
      const window = store.reviewWindow('web#main#long', 0, 14_000)!;
      // 1 + ~8k for the person, then the newer reply (5k) fits and the older one does not.
      expect(window.messages.map((m) => m.text[0])).toEqual(['问', 'b', '开']);
      const pasted = window.messages[2]!.text;
      expect(pasted.startsWith('开头')).toBe(true);
      expect(pasted.endsWith('结尾')).toBe(true);
      expect(pasted).toMatch(/\[… \d+ characters cut …\]/);
      expect(pasted.length).toBeLessThan(8_100);
      expect(window.dropped).toBe(1);
      store.close();
    });

    it('reports the newest message id so a review starts after it', () => {
      const { store } = tempStore();
      seeded(store);
      const window = store.reviewWindow('telegram#chat#1', 0, 10_000)!;
      const all = store.read('telegram#chat#1');
      expect(window.lastMessageId).toBe(all.messages[all.messages.length - 1]!.id);
      store.close();
    });
  });

  describe('review results', () => {
    const at = Date.UTC(2026, 10, 4, 12, 0);

    function review(store: HistoryStore, key = 'review:web#main#abcdef12:1'): number {
      const id = store.session({ key, platform: 'web', title: '复盘：跨会话查询', kind: 'review', at })!;
      store.message(id, { ts: at, role: 'user', kind: 'review', text: '读下面的对话记录' });
      store.message(id, { ts: at, role: 'agent', kind: 'review', text: '{"changes":[]}' });
      return id;
    }

    it('keeps what each change became, and reads it back with its lane', () => {
      const { store } = tempStore();
      const id = review(store);
      store.recordReview(id, {
        reviewedKey: 'web#main#abcdef12',
        reviewedTitle: '跨会话查询',
        platform: 'web',
        channel: 'main',
        thread: 'abcdef12',
        outcome: 'changed',
        changes: [
          { action: 'patch', name: 'deploy-check', reason: '两次漏了测试', applied: true, revertId: '0001-abc' },
          { action: 'create', name: 'Bad Name', applied: false, error: 'invalid skill name' },
        ],
        preferences: ['回答先给结论'],
        invalid: ['change #3: name is required'],
        at,
      });
      const [row] = store.reviewSessions();
      expect(row!.session.kind).toBe('review');
      expect(row!.record).toMatchObject({
        reviewedKey: 'web#main#abcdef12',
        reviewedTitle: '跨会话查询',
        platform: 'web',
        channel: 'main',
        thread: 'abcdef12',
        outcome: 'changed',
        preferences: ['回答先给结论'],
        invalid: ['change #3: name is required'],
      });
      expect(row!.record!.changes).toEqual([
        { action: 'patch', name: 'deploy-check', reason: '两次漏了测试', applied: true, revertId: '0001-abc' },
        { action: 'create', name: 'Bad Name', applied: false, error: 'invalid skill name' },
      ]);
      store.close();
    });

    it('leaves an old review without a record, and hands back its raw answer', () => {
      const { store } = tempStore();
      review(store);
      const [row] = store.reviewSessions();
      expect(row!.record).toBeUndefined();
      expect(store.reviewAnswer(row!.session.id)).toBe('{"changes":[]}');
      store.close();
    });

    it('answers no answer for a failed run, which wrote only the prompt', () => {
      const { store } = tempStore();
      const id = store.session({ key: 'review:web#main#abcdef12:2', platform: 'web', kind: 'review', at })!;
      store.message(id, { ts: at, role: 'user', kind: 'review', text: '读下面的对话记录' });
      expect(store.reviewAnswer(id)).toBeUndefined();
      store.close();
    });

    it('lists the newest review first, and leaves ordinary conversations out', () => {
      const { store } = tempStore();
      seed(store);
      review(store, 'review:web#main#abcdef12:1');
      review(store, 'review:web#main#abcdef12:2');
      const rows = store.reviewSessions();
      expect(rows.map((r) => r.session.key)).toEqual([
        'review:web#main#abcdef12:2',
        'review:web#main#abcdef12:1',
      ]);
      expect(store.list({ days: 30 }).every((r) => r.kind !== 'review')).toBe(true);
      store.close();
    });

    it('replaces a result written twice for the same session rather than adding a row', () => {
      const { store } = tempStore();
      const id = review(store);
      const base = {
        reviewedKey: 'web#main#abcdef12',
        reviewedTitle: '跨会话查询',
        platform: 'web',
        changes: [],
        preferences: [],
        invalid: [],
        at,
      };
      store.recordReview(id, { ...base, outcome: 'nothing' });
      store.recordReview(id, { ...base, outcome: 'preferences', preferences: ['先给结论'] });
      const rows = store.reviewSessions();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.record?.outcome).toBe('preferences');
      store.close();
    });
  });
});

/**
 * Turns: the row per turn, the turn on each message, and the reads that select by them.
 *
 * The old-schema case is built with raw SQL on purpose. A migration test that used this store to
 * create its "old" file would be testing the new schema against itself.
 */
describe('HistoryStore turns', () => {
  it('adds the turn column to an old database, and old rows read as unknown', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'talkcode-history-old-'));
    dirs.push(dir);
    const file = path.join(dir, 'history.db');
    const raw = new Sqlite(file);
    raw.exec(`
      CREATE TABLE sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE, platform TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL DEFAULT '', agent TEXT NOT NULL DEFAULT '', host TEXT NOT NULL DEFAULT '',
        cwd TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT 'normal',
        started_at INTEGER NOT NULL, last_at INTEGER NOT NULL
      );
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER NOT NULL, ts INTEGER NOT NULL,
        role TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'normal', text TEXT NOT NULL
      );
      INSERT INTO sessions (key, platform, title, agent, started_at, last_at)
        VALUES ('tg#old#', 'tg', '旧对话', 'cc', 1000, 1000);
      INSERT INTO messages (session_id, ts, role, kind, text) VALUES (1, 1000, 'user', 'normal', '旧问题');
      INSERT INTO messages (session_id, ts, role, kind, text) VALUES (1, 1001, 'agent', 'normal', '旧回答');
    `);
    raw.close();

    const store = new HistoryStore(file);
    const read = store.read('tg#old#', { role: 'user' });
    const session = read.session.id;
    expect(read.messages).toHaveLength(1);
    // Unknown, not guessed: the row predates turns and belongs to none.
    expect(read.messages[0]).toMatchObject({ text: '旧问题', turn: null, outcome: null, agent: '' });

    // The new column is writable, and a turn opened now starts at 1 in this conversation.
    const turn = store.startTurn(session, { agent: 'cc', generation: 0, trigger: 'person', at: 2000 })!;
    store.message(session, { ts: 2000, role: 'user', kind: 'normal', text: '新问题', turn });
    store.endTurn(turn, { outcome: 'done', at: 2100 });
    const last = store.read(String(session), { turn: 'last' });
    expect(last.messages).toHaveLength(1);
    expect(last.messages[0]).toMatchObject({ turn: 1, outcome: 'done', agent: 'cc', text: '新问题' });
    store.close();
  });

  it('stores every trigger and every outcome, in one row per turn', () => {
    const { store, file } = tempStore();
    const at = Date.UTC(2026, 10, 2, 9, 0);
    const session = store.session({ key: 'tg#turns#', platform: 'tg', agent: 'cc', at })!;
    const rows: Array<{ trigger: HistoryTrigger; outcome?: HistoryOutcome; agent: string }> = [
      { trigger: 'person', outcome: 'done', agent: 'cc' },
      { trigger: 'schedule', outcome: 'stopped', agent: 'oc' },
      { trigger: 'delegate', outcome: 'failed', agent: 'cc' },
      { trigger: 'update', outcome: 'done', agent: 'oc' },
      { trigger: 'continue', outcome: 'done', agent: 'cc' },
      { trigger: 'background', outcome: 'done', agent: 'cc' },
    ];
    rows.forEach((r, i) => {
      const turn = store.startTurn(session, {
        agent: r.agent,
        generation: i >= 3 ? 1 : 0,
        trigger: r.trigger,
        at: at + i * 1_000,
      })!;
      store.message(session, { ts: at + i * 1_000, role: 'user', kind: 'normal', text: `第${i + 1}轮`, turn });
      if (r.outcome) store.endTurn(turn, { outcome: r.outcome, at: at + i * 1_000 + 500 });
    });

    // The trigger and generation are not printed by read — they are the data the next phase reads
    // — so they are checked in the file itself.
    store.close();
    const raw = new Sqlite(file);
    const turns = raw.prepare('SELECT seq, agent, generation, trigger, outcome FROM turns ORDER BY seq').all() as Array<
      Record<string, unknown>
    >;
    raw.close();
    expect(turns).toHaveLength(6);
    expect(turns.map((t) => `${t.seq}:${t.agent}:${t.generation}:${t.trigger}:${t.outcome}`)).toEqual([
      '1:cc:0:person:done',
      '2:oc:0:schedule:stopped',
      '3:cc:0:delegate:failed',
      '4:oc:1:update:done',
      '5:cc:1:continue:done',
      '6:cc:1:background:done',
    ]);
  });

  it('selects the last turn, the last normal end, the last n, and one by number', () => {
    const { store } = tempStore();
    const { session } = seedThreeTurns(store);
    expect(store.read(String(session), { turn: 'last' }).messages.map((m) => m.text)).toEqual([
      '第三轮问题',
      '第三轮回答',
    ]);
    const done = store.read(String(session), { turn: 'done' });
    // Turn 3 also ended normally; `done` means the NEWEST normal end, not the first.
    expect(done.messages.map((m) => `${m.turn}:${m.outcome}`)).toEqual(['3:done', '3:done']);
    expect(store.read(String(session), { turn: '2' }).messages.map((m) => m.text)).toEqual([
      '第二轮问题：继续查询',
      'Bash: npm test',
      '第二轮回答',
    ]);
    const lastTwo = store.read(String(session), { turns: 2 });
    expect(lastTwo.messages.map((m) => m.turn)).toEqual([2, 2, 2, 3, 3]);
    // Asking for more turns than exist is not a cut, so it carries no cut note — only the one
    // saying turn 2's tool call was folded.
    expect(store.read(String(session), { turns: 150 }).note).toMatch(/^Each run of tool calls is folded/);
    // A running turn reads as running, not as an outcome that never happened.
    const running = store.startTurn(session, { agent: 'cc', generation: 0, trigger: 'person', at: 99_000 })!;
    store.message(session, { ts: 99_000, role: 'user', kind: 'normal', text: '还在跑', turn: running });
    expect(store.read(String(session), { turn: 'last' }).messages[0]).toMatchObject({ turn: 4, outcome: 'running' });
    store.close();
  });

  it('takes the newest n rows with limit, oldest first, without a cut note', () => {
    const { store } = tempStore();
    const { session } = seedThreeTurns(store);
    const newest = store.read(String(session), { limit: 2 });
    expect(newest.messages.map((m) => m.text)).toEqual(['第三轮问题', '第三轮回答']);
    expect(newest.note).toBeUndefined();
    // A role filter narrows first, then the newest n of what matched.
    expect(store.read(String(session), { role: 'agent', limit: 2 }).messages.map((m) => m.text)).toEqual([
      '第二轮回答',
      '第三轮回答',
    ]);
    store.close();
  });

  it('reads one turn’s record, whole error and all, and has none to read when nothing ran', () => {
    const { store } = tempStore();
    const { session } = seedThreeTurns(store);
    expect(store.turnRecord(String(session), 'last')).toEqual({
      turn: 3,
      at: new Date(Date.UTC(2026, 10, 2, 9, 0) + 22).toISOString(),
      outcome: 'done',
      agent: 'cc',
      detail: '',
    });
    // `done` is the newest turn that ended normally; turn 3 did, so it is the answer.
    expect(store.turnRecord(String(session), 'done')?.turn).toBe(3);

    // The error is kept as the turn runner wrote it — the whole message, not the 300-character
    // opening the chat's ❌ notice carries.
    const error = `Process exited 1:\n${'  at step (file.ts:1:1)\n'.repeat(400)}`;
    const failed = store.startTurn(session, { agent: 'cc', generation: 0, trigger: 'person', at: 99_000 })!;
    store.endTurn(failed, { outcome: 'failed', at: 99_500, detail: error });
    const record = store.turnRecord(String(session), 'last')!;
    expect(record.outcome).toBe('failed');
    expect(record.detail).toBe(error);

    // A conversation with no turns yet answers "none", not an error; a turn number that names no
    // turn is still a wrong request.
    const fresh = store.session({ key: 'tg#fresh#', platform: 'tg', agent: 'cc', at: 5 })!;
    expect(store.turnRecord(String(fresh), 'last')).toBeUndefined();
    expect(() => store.turnRecord(String(session), '9')).toThrow(/there is no turn 9/);
    store.close();
  });

  it('names a turn by its number for a card that quotes it', () => {
    const { store } = tempStore();
    const { session } = seedThreeTurns(store);
    // The id is what the rows carry; the number is what `--turn <n>` takes. A card that quotes a
    // turn needs the second, because "last" can be a later turn by the time it is read.
    expect(store.turnSeq(1)).toBe(1);
    expect(store.turnSeq(3)).toBe(3);
    expect(store.turnSeq(999)).toBeUndefined();
    expect(store.turnRecord(String(session), '2')?.turn).toBe(store.turnSeq(2));
    store.close();
  });

  it('combines role, grep, since and tail', () => {
    const { store } = tempStore();
    const { session } = seedThreeTurns(store);
    const tools = store.read(String(session), { role: 'tool' });
    expect(tools.messages.map((m) => m.text)).toEqual(['Bash: git status', 'Bash: npm test']);
    expect(tools.messages.every((m) => m.role === 'tool' && m.turn !== null)).toBe(true);
    expect(store.read(String(session), { role: 'tool', tail: 1 }).messages.map((m) => m.text)).toEqual([
      'Bash: npm test',
    ]);
    expect(store.read(String(session), { grep: '查询' }).messages.map((m) => m.text)).toEqual([
      '第一轮回答：查询做完了',
      '第二轮问题：继续查询',
    ]);
    // The watermark is exclusive, and belongs to this conversation.
    const anchor = store.search('第二轮问题')[0]!.message;
    const since = store.read(String(session), { since: anchor });
    expect(since.messages.map((m) => m.text)).toEqual([
      'Bash: npm test',
      '第二轮回答',
      '第三轮问题',
      '第三轮回答',
    ]);
    expect(() => store.read(String(session), { since: 999_999 })).toThrow(/not in conversation/);
    const combined = store.read(String(session), { turns: 2, role: 'agent', grep: '回答' });
    expect(combined.messages.map((m) => `${m.turn}:${m.outcome}`)).toEqual(['2:stopped', '3:done']);
    store.close();
  });

  it('keeps the newest rows of a tail read and says what it left out', () => {
    const { store } = tempStore();
    const at = Date.UTC(2026, 10, 3, 9, 0);
    const session = store.session({ key: 'tg#long#', platform: 'tg', agent: 'cc', at })!;
    const turn = store.startTurn(session, { agent: 'cc', generation: 0, trigger: 'person', at })!;
    const text = 'x'.repeat(90_000);
    for (let i = 0; i < 3; i += 1) {
      store.message(session, { ts: at + i, role: 'agent', kind: 'normal', text: `${i}:${text}`, turn });
    }
    store.endTurn(turn, { outcome: 'done', at: at + 3 });
    const tail = store.read(String(session), { turn: 'last' });
    // 200k budget: the newest two fit, the oldest is the one dropped.
    expect(tail.messages).toHaveLength(2);
    expect(tail.messages.map((m) => m.text.slice(0, 2))).toEqual(['1:', '2:']);
    expect(tail.note).toMatch(/1 older message\(s\) were left out/);
    // An unfiltered read is unchanged: oldest first, same five fields, dropping later rows.
    const all = store.read(String(session));
    expect(all.messages.map((m) => m.text.slice(0, 2))).toEqual(['0:', '1:']);
    expect(all.note).toMatch(/1 later message\(s\)/);
    expect('turn' in all.messages[0]!).toBe(false);
    store.close();
  });

  it('marks a turn left running when the library is opened again as restart', () => {
    const { store, file } = tempStore();
    const at = Date.UTC(2026, 10, 4, 9, 0);
    const session = store.session({ key: 'tg#crash#', platform: 'tg', agent: 'cc', at })!;
    const turn = store.startTurn(session, { agent: 'cc', generation: 0, trigger: 'person', at })!;
    store.message(session, { ts: at + 10, role: 'user', kind: 'normal', text: '没跑完', turn });
    store.close();

    const reopened = new HistoryStore(file);
    const read = reopened.read(String(session), { turn: 'last' });
    expect(read.messages[0]).toMatchObject({ turn: 1, outcome: 'restart' });
    reopened.close();
    // A second open must not re-mark it (and must not lose the first end time).
    const again = new HistoryStore(file);
    expect(again.read(String(session), { turn: 'last' }).messages[0]!.outcome).toBe('restart');
    again.close();
  });

  it('says why a turn it does not have cannot be read', () => {
    const { store } = tempStore();
    const { session } = seedThreeTurns(store);
    expect(() => store.read(String(session), { turn: '9' })).toThrow(/has 3 turn\(s\); there is no turn 9/);
    expect(() => store.read(String(session), { turn: 'soon' })).toThrow(/--turn takes last, done/);
    expect(() => store.read(String(session), { turn: 'last', turns: 2 })).toThrow(/use one/);
    expect(() => store.read(String(session), { tail: 5 })).toThrow(/--tail reads tool lines/);
    // Two directions cannot share one cursor.
    expect(() => store.read(String(session), { since: 1, turn: 'last' })).toThrow(/cannot be combined/);
    expect(() => store.read(String(session), { since: 1, turns: 2 })).toThrow(/cannot be combined/);
    expect(() => store.read(String(session), { since: 1, role: 'tool', tail: 2 })).toThrow(/cannot be combined/);
    expect(() => store.read(String(session), { since: 1, limit: 2 })).toThrow(/cannot be combined/);
    const old = store.session({ key: 'tg#pre#', platform: 'tg', at: 5 })!;
    expect(() => store.read(String(old), { turn: 'last' })).toThrow(/no recorded turns/);
    store.close();
  });

  it('scopes --turn done to the current agent and generation', () => {
    const { store } = tempStore();
    const at = Date.UTC(2026, 10, 5, 9, 0);
    const session = store.session({ key: 'tg#context#', platform: 'tg', agent: 'cc', at })!;
    const add = (turn: number, ts: number, text: string): void =>
      store.message(session, { ts, role: 'user', kind: 'normal', text, turn });
    const t1 = store.startTurn(session, { agent: 'cc', generation: 0, trigger: 'person', at })!;
    add(t1, at, 'cc 答完的');
    store.endTurn(t1, { outcome: 'done', at: at + 1 });

    // /new, then another agent: its only turn fails. The previous context's finished answer is
    // not this context's "last completed turn" — and a context with nothing finished answers
    // empty with a note, rather than throwing at a legitimate question.
    const t2 = store.startTurn(session, { agent: 'oc', generation: 1, trigger: 'person', at: at + 10 })!;
    add(t2, at + 10, 'oc 失败');
    store.endTurn(t2, { outcome: 'failed', at: at + 11 });
    const none = store.read(String(session), { turn: 'done' });
    expect(none.messages).toEqual([]);
    expect(none.note).toMatch(/for agent oc in generation 1 yet/);

    const t3 = store.startTurn(session, { agent: 'oc', generation: 1, trigger: 'person', at: at + 20 })!;
    add(t3, at + 20, 'oc 答完');
    store.endTurn(t3, { outcome: 'done', at: at + 21 });
    expect(store.read(String(session), { turn: 'done' }).messages.map((m) => m.text)).toEqual(['oc 答完']);
    // An explicit number still reaches the older context: it asks for a turn, not "the last one".
    expect(store.read(String(session), { turn: '1' }).messages.map((m) => m.text)).toEqual(['cc 答完的']);
    store.close();
  });

  it('reads --turn done from the live context, not the newest turn row', () => {
    const { store } = tempStore();
    const at = Date.UTC(2026, 10, 5, 10, 0);
    const session = store.session({ key: 'tg#reset#', platform: 'tg', agent: 'cc', at })!;
    const t1 = store.startTurn(session, { agent: 'cc', generation: 0, trigger: 'person', at })!;
    store.message(session, { ts: at, role: 'user', kind: 'normal', text: '重置前', turn: t1 });
    store.endTurn(t1, { outcome: 'done', at: at + 1 });

    // `/new` bumps the generation in conversations.json; the library has no turn in it yet, so
    // its newest row is still turn 1. Without the live context, `done` answers with that — the
    // answer the person asked to discard.
    const afterNew = store.read(String(session), { turn: 'done', current: () => ({ agent: 'cc', generation: 1 }) });
    expect(afterNew.messages).toEqual([]);
    expect(afterNew.note).toMatch(/for agent cc in generation 1 yet/);
    expect(afterNew.note).toMatch(/newest recorded turn is from generation 0/);

    // A store used without the callback falls back to the newest turn's context (unchanged).
    expect(store.read(String(session), { turn: 'done' }).messages.map((m) => m.text)).toEqual(['重置前']);

    // Once the new generation has a finished turn, that is what `done` answers.
    const t2 = store.startTurn(session, { agent: 'cc', generation: 1, trigger: 'person', at: at + 10 })!;
    store.message(session, { ts: at + 10, role: 'user', kind: 'normal', text: '重置后', turn: t2 });
    store.endTurn(t2, { outcome: 'done', at: at + 11 });
    const live = { current: () => ({ agent: 'cc', generation: 1 }) };
    expect(store.read(String(session), { turn: 'done', ...live }).messages.map((m) => m.text)).toEqual(['重置后']);
    store.close();
  });

  it('reads --since forward, keeping the oldest rows and naming where to resume', () => {
    const { store } = tempStore();
    const at = Date.UTC(2026, 10, 5, 11, 0);
    const session = store.session({ key: 'tg#since#', platform: 'tg', agent: 'cc', at })!;
    const turn = store.startTurn(session, { agent: 'cc', generation: 0, trigger: 'person', at })!;
    store.message(session, { ts: at, role: 'user', kind: 'normal', text: '水位', turn });
    const anchor = store.read(String(session)).messages[0]!.id;
    for (let i = 1; i <= 600; i += 1) {
      store.message(session, { ts: at + i, role: 'agent', kind: 'normal', text: `m${i}`, turn });
    }

    const first = store.read(String(session), { since: anchor });
    // The earliest 500 after the watermark — not the newest, which would leave a permanent gap.
    expect(first.messages).toHaveLength(500);
    expect(first.messages[0]!.text).toBe('m1');
    expect(first.messages[499]!.text).toBe('m500');
    expect(first.note).toMatch(new RegExp(`Continue with --since ${first.messages[499]!.id}\\.`));

    // The id in the note is exactly where the next read starts: no row is lost or repeated.
    const next = store.read(String(session), { since: first.messages[499]!.id });
    expect(next.messages.map((m) => m.text)).toEqual(Array.from({ length: 100 }, (_, i) => `m${501 + i}`));
    store.close();
  });

  it('pages --since by id, so a late import with old timestamps cannot repeat rows', () => {
    const { store } = tempStore();
    const at = Date.UTC(2026, 10, 5, 11, 30);
    const session = store.session({ key: 'tg#import-order#', platform: 'tg', agent: 'cc', at })!;
    const turn = store.startTurn(session, { agent: 'cc', generation: 0, trigger: 'person', at })!;
    store.message(session, { ts: at, role: 'user', kind: 'normal', text: '水位', turn });
    const anchor = store.read(String(session)).messages[0]!.id;
    for (let i = 1; i <= 600; i += 1) {
      store.message(session, { ts: at + i, role: 'agent', kind: 'normal', text: `live${i}`, turn });
    }
    // A web UI transcript folded in later: newest ids, timestamps older than everything above.
    // Ordering the read by (ts, id) while resuming by id would put these on both pages.
    for (let i = 1; i <= 5; i += 1) {
      store.message(session, { ts: at - 1_000 + i, role: 'user', kind: 'normal', text: `imported${i}` });
    }

    const first = store.read(String(session), { since: anchor });
    const second = store.read(String(session), { since: first.messages[499]!.id });
    const all = [...first.messages, ...second.messages];
    expect(first.messages).toHaveLength(500);
    expect(second.messages).toHaveLength(105);
    expect(new Set(all.map((m) => m.id)).size).toBe(605);
    // The imported rows are at the end, in write order — exactly where the id cursor reaches them.
    expect(all.slice(-5).map((m) => m.text)).toEqual(['imported1', 'imported2', 'imported3', 'imported4', 'imported5']);
    store.close();
  });

  it('cuts a --since read at the character budget from the same end and says where to resume', () => {
    const { store } = tempStore();
    const at = Date.UTC(2026, 10, 5, 12, 0);
    const session = store.session({ key: 'tg#since-long#', platform: 'tg', agent: 'cc', at })!;
    const turn = store.startTurn(session, { agent: 'cc', generation: 0, trigger: 'person', at })!;
    store.message(session, { ts: at, role: 'user', kind: 'normal', text: '水位', turn });
    const anchor = store.read(String(session)).messages[0]!.id;
    const text = 'x'.repeat(90_000);
    for (let i = 0; i < 3; i += 1) {
      store.message(session, { ts: at + i + 1, role: 'agent', kind: 'normal', text: `${i}:${text}`, turn });
    }

    const cut = store.read(String(session), { since: anchor });
    expect(cut.messages.map((m) => m.text.slice(0, 2))).toEqual(['0:', '1:']);
    expect(cut.note).toMatch(/1 later message\(s\) were left out/);
    expect(cut.note).toMatch(new RegExp(`Continue with --since ${cut.messages[1]!.id}\\.`));
    store.close();
  });

  it('keeps the newest 100 turns when --turns asks for more, and says so', () => {
    const { store } = tempStore();
    const at = Date.UTC(2026, 10, 5, 13, 0);
    const session = store.session({ key: 'tg#many-turns#', platform: 'tg', agent: 'cc', at })!;
    for (let i = 1; i <= 101; i += 1) {
      const turn = store.startTurn(session, { agent: 'cc', generation: 0, trigger: 'person', at: at + i })!;
      store.message(session, { ts: at + i, role: 'user', kind: 'normal', text: `t${i}`, turn });
      store.endTurn(turn, { outcome: 'done', at: at + i });
    }
    const read = store.read(String(session), { turns: 150 });
    // 101 turns exist; the newest 100 start at turn 2.
    expect(read.messages).toHaveLength(100);
    expect(read.messages[0]!.turn).toBe(2);
    expect(read.note).toMatch(/--turns takes at most 100; the newest 100 are shown/);
    store.close();
  });

  it('plans a turn read on the (session, turn) index', () => {
    const { store, file } = tempStore();
    const { session } = seedThreeTurns(store);
    store.close();
    const raw = new Sqlite(file);
    const plan = raw
      .prepare('EXPLAIN QUERY PLAN SELECT id FROM messages WHERE session_id = ? AND turn = ?')
      .all(session, 1) as Array<{ detail: string }>;
    raw.close();
    // A bare `turn` index cannot narrow by session; the planner would walk the conversation's
    // messages from its start instead.
    expect(plan.some((p) => p.detail.includes('messages_session_turn'))).toBe(true);
  });
});

/**
 * Tool calls: one row per call however many times the harness re-sends it, and reads that fold a
 * run of calls into one line unless the read asks for the calls themselves.
 */
describe('HistoryStore tool calls', () => {
  function toolSession(store: HistoryStore): { session: number; at: number; turn: number } {
    const at = Date.UTC(2026, 10, 6, 9, 0);
    const session = store.session({ key: 'web#main#tools', platform: 'web', agent: 'cbc', at })!;
    const turn = store.startTurn(session, { agent: 'cbc', generation: 0, trigger: 'person', at })!;
    return { session, at, turn };
  }

  it('rewrites the row of a call it has already recorded, keeping when the call started', () => {
    const { store } = tempStore();
    const { session, at, turn } = toolSession(store);
    const write = (ts: number, text: string, call?: string, t = turn): void =>
      store.message(session, { ts, role: 'tool', kind: 'normal', text, turn: t, ...(call ? { call } : {}) });
    write(at, 'Write: {"content":"---\\nname: v"}', 'call-1');
    write(at + 1, 'Write: {"content":"---\\nname: vlt\\n"}', 'call-1');
    write(at + 2, 'Write: /skills/vlt/SKILL.md\n{"file_path":"/skills/vlt/SKILL.md","content":"---\\nname: vlt\\n"}', 'call-1');
    const rows = store.read(String(session), { role: 'tool' }).messages;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.text).toMatch(/^Write: \/skills\/vlt\/SKILL\.md\n/);
    expect(rows[0]!.at).toBe(new Date(at).toISOString());
    // The index follows the text: the final path is found, the first frame's words are not.
    expect(store.search('SKILL.md', { tools: true })).toHaveLength(1);
    expect(store.search('"name: v"', { tools: true })).toHaveLength(0);
    // Without an id every write is a row, as before; the same id in another turn is another call.
    write(at + 3, 'Bash: ls');
    write(at + 4, 'Bash: ls');
    const next = store.startTurn(session, { agent: 'cbc', generation: 0, trigger: 'person', at: at + 5 })!;
    write(at + 5, 'Edit: a.ts', 'call-1', next);
    expect(store.read(String(session), { role: 'tool' }).messages).toHaveLength(4);
    store.close();
  });

  it('adds the call column to a file that predates it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'talkcode-history-nocall-'));
    dirs.push(dir);
    const file = path.join(dir, 'history.db');
    const raw = new Sqlite(file);
    raw.exec(`
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER NOT NULL, ts INTEGER NOT NULL,
        role TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'normal', text TEXT NOT NULL, turn INTEGER
      );
    `);
    raw.close();
    const store = new HistoryStore(file);
    const { session, at, turn } = toolSession(store);
    store.message(session, { ts: at, role: 'tool', kind: 'normal', text: 'Bash: a', turn, call: 'c' });
    store.message(session, { ts: at, role: 'tool', kind: 'normal', text: 'Bash: b', turn, call: 'c' });
    expect(store.read(String(session), { role: 'tool' }).messages.map((m) => m.text)).toEqual(['Bash: b']);
    store.close();
  });

  /** user, three calls, a reply, one call, user — in one turn — then one call in the next. */
  function seedRuns(store: HistoryStore): { session: number; ids: number[] } {
    const { session, at, turn } = toolSession(store);
    const rows: Array<['user' | 'agent' | 'tool', string, number?]> = [
      ['user', '把 vlt 整理成技能'],
      ['tool', 'Bash: cat SKILL.md\n{"command":"cat SKILL.md"}'],
      ['tool', 'Bash: git status'],
      ['tool', 'reviewer · Edit: SKILL.md'],
      ['agent', '写好了'],
      ['tool', 'Write: notes.md\n{"file_path":"notes.md","content":"x"}'],
      ['user', '提交吧'],
    ];
    rows.forEach(([role, text], i) => store.message(session, { ts: at + i, role, kind: 'normal', text, turn }));
    const next = store.startTurn(session, { agent: 'cbc', generation: 0, trigger: 'person', at: at + 100 })!;
    store.message(session, { ts: at + 100, role: 'tool', kind: 'normal', text: 'Bash: git push', turn: next });
    const ids = store.read(String(session), { role: 'tool' }).messages.map((m) => m.id);
    return { session, ids };
  }

  it('folds each run of calls in a plain read, one call to its first line, and says so', () => {
    const { store } = tempStore();
    const { session, ids } = seedRuns(store);
    const read = store.read(String(session));
    expect(read.messages.map((m) => m.text)).toEqual([
      '把 vlt 整理成技能',
      '[3 tool calls: Bash ×2, Edit]',
      '写好了',
      'Write: notes.md',
      '提交吧',
      // A new turn starts a new run, even with no other row between.
      'Bash: git push',
    ]);
    // A run reads at its first call, which is what --around takes.
    expect(read.messages[1]!.id).toBe(ids[0]);
    expect(read.note).toBe('Each run of tool calls is folded into one line; --role tool lists them with their arguments.');
    store.close();
  });

  it('lists the calls whole for --role tool and --grep, and does not fold a window', () => {
    const { store } = tempStore();
    const { session, ids } = seedRuns(store);
    const tools = store.read(String(session), { role: 'tool' });
    expect(tools.messages).toHaveLength(5);
    expect(tools.messages[0]!.text).toBe('Bash: cat SKILL.md\n{"command":"cat SKILL.md"}');
    expect(tools.note).toBeUndefined();
    expect(store.read(String(session), { grep: 'git' }).messages.map((m) => m.text)).toEqual([
      'Bash: git status',
      'Bash: git push',
    ]);
    const window = store.read(String(session), { around: ids[1]!, window: 1 });
    expect(window.messages.map((m) => m.role)).toEqual(['tool', 'tool', 'tool']);
    store.close();
  });

  it('counts folded rows against --limit, and resumes --since after a run, not inside it', () => {
    const { store } = tempStore();
    const { session, ids } = seedRuns(store);
    expect(store.read(String(session), { limit: 3 }).messages.map((m) => m.text)).toEqual([
      'Write: notes.md',
      '提交吧',
      'Bash: git push',
    ]);
    const first = store.read(String(session), { turn: '1' });
    expect(first.messages.map((m) => m.text)).toContain('[3 tool calls: Bash ×2, Edit]');
    const userId = store.read(String(session), { role: 'user' }).messages[0]!.id;
    const since = store.read(String(session), { since: userId });
    expect(since.messages[0]!.text).toBe('[3 tool calls: Bash ×2, Edit]');
    expect(since.messages[0]!.id).toBe(ids[0]);
    store.close();
  });

  it('says nothing about folding when the rows it returns hold no call', () => {
    const { store } = tempStore();
    const { session } = seedRuns(store);
    const read = store.read(String(session), { limit: 2, turn: '1' });
    expect(read.messages.map((m) => m.text)).toEqual(['Write: notes.md', '提交吧']);
    expect(read.note).toMatch(/^Each run of tool calls is folded/);
    const plain = store.read(String(session), { turn: '1', limit: 1 });
    expect(plain.messages.map((m) => m.text)).toEqual(['提交吧']);
    expect(plain.note).toBeUndefined();
    store.close();
  });
});

/** A raw connection, for building an old file and for reading what `read` does not print. */
const Sqlite = (
  createRequire(import.meta.url)('node:sqlite') as {
    DatabaseSync: new (file: string) => {
      exec(sql: string): void;
      prepare(sql: string): { all(...params: unknown[]): unknown[] };
      close(): void;
    };
  }
).DatabaseSync;

/**
 * Three turns in one conversation: done, stopped, and a third still ending as done. Tool and
 * person rows are mixed so role, text and turn filters have something to disagree about.
 */
function seedThreeTurns(store: HistoryStore): { session: number } {
  const at = Date.UTC(2026, 10, 2, 9, 0);
  const session = store.session({ key: 'tg#three#', platform: 'tg', agent: 'cc', at })!;
  const add = (ts: number, role: 'user' | 'agent' | 'tool', text: string, turn: number): void => {
    store.message(session, { ts, role, kind: 'normal', text, turn });
  };
  const t1 = store.startTurn(session, { agent: 'cc', generation: 0, trigger: 'person', at })!;
  add(at, 'user', '第一轮问题', t1);
  add(at + 1, 'tool', 'Bash: git status', t1);
  add(at + 2, 'agent', '第一轮回答：查询做完了', t1);
  store.endTurn(t1, { outcome: 'done', at: at + 3 });
  const t2 = store.startTurn(session, { agent: 'cc', generation: 0, trigger: 'person', at: at + 10 })!;
  add(at + 10, 'user', '第二轮问题：继续查询', t2);
  add(at + 11, 'tool', 'Bash: npm test', t2);
  add(at + 12, 'agent', '第二轮回答', t2);
  store.endTurn(t2, { outcome: 'stopped', at: at + 13 });
  const t3 = store.startTurn(session, { agent: 'cc', generation: 0, trigger: 'person', at: at + 20 })!;
  add(at + 20, 'user', '第三轮问题', t3);
  add(at + 21, 'agent', '第三轮回答', t3);
  store.endTurn(t3, { outcome: 'done', at: at + 22 });
  return { session };
}
