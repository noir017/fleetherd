import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HistoryStore } from './store.js';
import { importWebuiTranscripts, toolLineFromRendered } from './import-webui.js';

const dirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'talkcode-history-import-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function kept(at: number, text: string, extra: Record<string, unknown> = {}) {
  return { msg: { id: `w${at}`, own: false, html: '', at, g: 1, buttons: [], reactions: [], ...extra }, text };
}

/** A web UI config directory with one transcript and its topic file. */
function fixture(dir: string): void {
  const at = Date.now() - 60_000;
  fs.mkdirSync(path.join(dir, 'webui-transcripts-webui'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'webui-topics-webui.json'),
    JSON.stringify({ abcdef12: { title: '跨会话查询', lastAt: at + 2 } })
  );
  fs.writeFileSync(
    path.join(dir, 'webui-transcripts-webui', 'abcdef12.json'),
    JSON.stringify([
      kept(at, '帮我实现跨会话查询', { own: true }),
      kept(at + 1, '🔧 Bash: "git status"\n🔧 Read: "src/daemon/turn-runner.ts"', { kind: 'tools' }),
      kept(at + 2, '查询做完了，测试全过。'),
    ])
  );
}

describe('importWebuiTranscripts', () => {
  it('imports a topic once, with its title, its roles and its tool lines', () => {
    const dir = tempDir();
    fixture(dir);
    const store = new HistoryStore(path.join(dir, 'history.db'));
    const first = importWebuiTranscripts(dir, store);
    expect(first).toMatchObject({ files: 1, imported: 1, skipped: 0, failed: 0, messages: 4 });

    const sessions = store.list({ days: 30 });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      key: 'webui#main#abcdef12',
      platform: 'webui',
      title: '跨会话查询',
      kind: 'normal',
      messages: 4,
    });
    // A plain read folds the two calls into one line; --role tool is what lists them.
    const read = store.read(String(sessions[0]!.id));
    expect(read.messages.map((m) => m.role)).toEqual(['user', 'tool', 'agent']);
    const tools = store.read(String(sessions[0]!.id), { role: 'tool' });
    expect(tools.messages.map((m) => m.text)).toEqual(['Bash: git status', 'Read: src/daemon/turn-runner.ts']);
    store.close();
  });

  it('splits a sub-agent report into tool rows, exactly as it did when the card rode as tools', () => {
    // The card used to be sent with `kind: 'tools'` only to borrow the web UI's folding, so the
    // import already read it as rows. It has a kind of its own now; the library must not change.
    const dir = tempDir();
    const at = Date.now() - 60_000;
    fs.mkdirSync(path.join(dir, 'webui-transcripts-webui'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'webui-topics-webui.json'), JSON.stringify({ abcdef12: { title: '子代理' } }));
    fs.writeFileSync(
      path.join(dir, 'webui-transcripts-webui', 'abcdef12.json'),
      JSON.stringify([
        kept(at, '🔔 part (cc @ near) — finished: Done: all green.\n🔔 other (cx @ far) — failed: upstream 503', {
          kind: 'report',
        }),
      ])
    );
    const store = new HistoryStore(path.join(dir, 'history.db'));
    importWebuiTranscripts(dir, store);

    const read = store.read(String(store.list({ days: 30 })[0]!.id), { role: 'tool' });
    expect(read.messages.map((m) => m.text)).toEqual(['finished: Done: all green.', 'failed: upstream 503']);
    store.close();
  });

  it('leaves settings screens out of the library, live or retired', () => {
    // A /setting screen is a control surface, not something anyone said: the page draws it in a
    // page of its own, and the daemon marks a retired one `wasSettings`. Neither should come back
    // as a search hit after the next start.
    const dir = tempDir();
    const at = Date.now() - 60_000;
    fs.mkdirSync(path.join(dir, 'webui-transcripts-webui'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'webui-topics-webui.json'),
      JSON.stringify({ abcdef12: { title: '设置' } })
    );
    fs.writeFileSync(
      path.join(dir, 'webui-transcripts-webui', 'abcdef12.json'),
      JSON.stringify([
        kept(at, '看下设置', { own: true }),
        kept(at + 1, 'Settings — saved to config.yaml, not just this conversation.', {
          settings: { level: 'list', rows: [] },
        }),
        kept(at + 2, 'Settings — superseded by a newer /setting menu.', { wasSettings: true }),
        kept(at + 3, '好了'),
      ])
    );
    const store = new HistoryStore(path.join(dir, 'history.db'));
    const summary = importWebuiTranscripts(dir, store);
    expect(summary).toMatchObject({ files: 1, imported: 1, messages: 2 });
    const read = store.read(String(store.list({ days: 30 })[0]!.id));
    expect(read.messages.map((m) => m.text)).toEqual(['看下设置', '好了']);
    store.close();
  });

  it('is idempotent across starts', () => {
    const dir = tempDir();
    fixture(dir);
    const file = path.join(dir, 'history.db');
    const first = new HistoryStore(file);
    importWebuiTranscripts(dir, first);
    first.close();

    const second = new HistoryStore(file);
    const again = importWebuiTranscripts(dir, second);
    expect(again).toMatchObject({ files: 1, imported: 0, skipped: 1, failed: 0 });
    expect(second.list({ days: 30 })[0]!.messages).toBe(4);
    second.close();
  });

  it('marks a scheduled topic and a sub-agent topic by their kind', () => {
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, 'webui-transcripts-webui'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'webui-topics-webui.json'),
      JSON.stringify({
        aaaaaaaa: { title: '晨报', scheduled: true },
        bbbbbbbb: { title: '子任务', parent: 'abcdef12' },
      })
    );
    for (const id of ['aaaaaaaa', 'bbbbbbbb']) {
      fs.writeFileSync(
        path.join(dir, 'webui-transcripts-webui', `${id}.json`),
        JSON.stringify([kept(Date.now() - 60_000, '同一个词', { own: true })])
      );
    }
    const store = new HistoryStore(path.join(dir, 'history.db'));
    importWebuiTranscripts(dir, store);
    const kinds = new Map(store.list({ days: 30 }).map((s) => [s.key, s.kind]));
    expect(kinds.get('webui#main#aaaaaaaa')).toBe('schedule');
    expect(kinds.get('webui#main#bbbbbbbb')).toBe('subagent');
    // A scheduled transcript's rows sort after an ordinary conversation's.
    const hits = store.search('同一个词');
    expect(hits[0]!.kind).toBe('subagent');
    expect(hits[1]!.kind).toBe('schedule');
    store.close();
  });

  it('skips a malformed transcript without failing the import', () => {
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, 'webui-transcripts-webui'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'webui-transcripts-webui', 'cccccccc.json'), '{not json');
    const logs: string[] = [];
    const store = new HistoryStore(path.join(dir, 'history.db'));
    const summary = importWebuiTranscripts(dir, store, (m) => logs.push(m));
    expect(summary).toMatchObject({ files: 1, imported: 0, failed: 1 });
    expect(logs.some((l) => l.includes('could not import'))).toBe(true);
    store.close();
  });

  it('takes nothing of a topic the library already recorded live', () => {
    // The duplicate this guards against was on the live gateway: every topic opened after the
    // library existed was imported again at the next restart, a second copy of every row.
    const dir = tempDir();
    const at = Date.now() - 60_000;
    fs.mkdirSync(path.join(dir, 'webui-transcripts-webui'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'webui-transcripts-webui', 'abcdef12.json'),
      JSON.stringify([
        kept(at, '帮我实现跨会话查询', { own: true }),
        kept(at + 1, '🔧 Bash: "git status" ✓ 1.2s', { kind: 'tools' }),
        kept(at + 2, '查询做完了，测试全过。'),
      ])
    );
    const store = new HistoryStore(path.join(dir, 'history.db'));
    const id = store.session({ key: 'webui#main#abcdef12', platform: 'webui', at })!;
    store.message(id, { ts: at + 1, role: 'tool', kind: 'normal', text: 'Bash: git status' });
    store.message(id, { ts: at + 2, role: 'agent', kind: 'normal', text: '查询做完了，测试全过。' });

    // The prompt is older than the first live row — the web UI stamps it on arrival, the recorder
    // when the turn starts — and is still not taken: the live recorder wrote it too.
    expect(importWebuiTranscripts(dir, store)).toMatchObject({ files: 1, imported: 0, skipped: 1 });
    expect(store.sessionOf('webui#main#abcdef12')?.messages).toBe(2);
    expect(store.imported('webui-transcripts-webui/abcdef12.json')).toBe(true);
    store.close();
  });

  it('does nothing when there is no transcript directory', () => {
    const dir = tempDir();
    const store = new HistoryStore(path.join(dir, 'history.db'));
    expect(importWebuiTranscripts(dir, store)).toMatchObject({ files: 0, imported: 0 });
    store.close();
  });
});

describe('toolLineFromRendered', () => {
  it('strips the emoji and the quotes', () => {
    expect(toolLineFromRendered('🔧 Bash: "git status"')).toBe('Bash: git status');
  });

  it('handles the subagent arrow', () => {
    expect(toolLineFromRendered('↳ 🔧 Bash: "ls"')).toBe('Bash: ls');
  });

  it('handles a subagent prefix with its own name', () => {
    expect(toolLineFromRendered('↳ cc · 🔧 Bash: "git status"')).toBe('Bash: git status');
  });

  it('keeps a line it cannot parse', () => {
    expect(toolLineFromRendered('something else entirely')).toBe('something else entirely');
  });
});
