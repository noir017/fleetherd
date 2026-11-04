import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HistoryStore } from './store.js';

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

  it('finds English words', () => {
    const { store } = tempStore();
    seed(store);
    const hits = store.search('git status');
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

    it('keeps the newest messages when the budget is short and says how many it left out', () => {
      const { store } = tempStore();
      seeded(store);
      const window = store.reviewWindow('telegram#chat#1', 0, 6)!;
      // "第二句" is 3 chars and is always kept (the newest row), "好的" would be 2 more — under the
      // budget — and "第一句" would exceed it.
      expect(window.messages.map((m) => m.text)).toEqual(['好的', '第二句']);
      expect(window.dropped).toBe(1);
      expect(window.lastMessageId).toBeGreaterThan(window.messages[0]!.id);
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
});
