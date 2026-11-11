import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HistoryStore } from '../history/store.js';
import { buildHistoryPanel, cursorOf, HISTORY_PAGE_LIMIT, HISTORY_SEARCH_LIMIT } from './history-panel.js';

/**
 * The web UI's history page, from the daemon's side.
 *
 * What matters here is what the page can and cannot say: the whole library rather than the last
 * week, a page boundary that neither repeats nor skips a conversation, a topic link only for a
 * conversation this instance could still open, and a truncated read that admits it is truncated.
 */

const dirs: string[] = [];

function tempStore(): HistoryStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetherd-history-panel-'));
  dirs.push(dir);
  return new HistoryStore(path.join(dir, 'history.db'));
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** One conversation with a title, an agent and one message, last active at `at`. */
function seed(store: HistoryStore, key: string, title: string, at: number, agent = 'cc'): number {
  const id = store.session({ key, platform: key.split('#')[0] ?? '', title, agent, at })!;
  store.message(id, { ts: at, role: 'user', kind: 'normal', text: `in ${title}` });
  return id;
}

describe('the web UI history panel', () => {
  it('lists the whole library, newest first, and says where the next page starts', () => {
    const store = tempStore();
    const now = Date.now();
    // Four hundred days old: far outside the seven-day default `sessions list` uses.
    seed(store, 'telegram#chat#1', 'ancient', now - 400 * 86_400_000);
    for (let i = 0; i < 4; i++) seed(store, `webui#main#0000000${i}`, `t${i}`, now - i * 1_000);
    const panel = buildHistoryPanel({ history: store, instance: 'webui' });

    const first = panel.list({ limit: 3 });
    expect(first.enabled).toBe(true);
    expect(first.sessions.map((s) => s.title)).toEqual(['t0', 't1', 't2']);
    expect(first.next).toBeDefined();
    expect(first.sessions[0]).toMatchObject({ agent: 'cc', platform: 'webui', messages: 1 });
    expect(first.sessions[0]!.lastAt).toBe(now);

    const second = panel.list({ limit: 3, before: first.next });
    expect(second.sessions.map((s) => s.title)).toEqual(['t3', 'ancient']);
    // The last page has nowhere to go, so the button that would fetch it is not offered.
    expect(second.next).toBeUndefined();
    store.close();
  });

  it('carries a topic only for a conversation this instance recorded, in the shape of a topic id', () => {
    const store = tempStore();
    const now = Date.now();
    seed(store, 'webui#main#abcdef12', 'here', now);
    seed(store, 'webui#main#not-a-topic', 'odd thread', now - 1_000);
    seed(store, 'telegram#chat#abcdef12', 'elsewhere', now - 2_000);
    seed(store, 'webui#main', 'no thread at all', now - 3_000);
    const panel = buildHistoryPanel({ history: store, instance: 'webui' });

    const byTitle = new Map(panel.list().sessions.map((s) => [s.title, s]));
    expect(byTitle.get('here')?.topic).toBe('abcdef12');
    expect(byTitle.get('odd thread')?.topic).toBeUndefined();
    expect(byTitle.get('elsewhere')?.topic).toBeUndefined();
    expect(byTitle.get('no thread at all')?.topic).toBeUndefined();
    store.close();
  });

  it('searches the whole library and keeps the store\'s excerpt', () => {
    const store = tempStore();
    const at = Date.now();
    seed(store, 'webui#main#abcdef12', 'deploy notes', at);
    const id = store.session({ key: 'telegram#chat#9', platform: 'telegram', title: 'chat', agent: 'oc', at: at - 1_000 })!;
    store.message(id, { ts: at - 1_000, role: 'agent', kind: 'normal', text: 'the deployment finished' });
    const panel = buildHistoryPanel({ history: store, instance: 'webui' });

    const { hits } = panel.search('deployment');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ session: id, agent: 'oc', platform: 'telegram', role: 'agent' });
    expect(hits[0]!.excerpt).toContain('deployment');
    expect(hits[0]!.at).toBe(at - 1_000);
    store.close();
  });

  it('says the answer is a floor when the library has more matches than one carries', () => {
    const store = tempStore();
    const at = Date.now();
    const id = store.session({ key: 'telegram#chat#1', platform: 'telegram', title: 'many', agent: 'cc', at })!;
    // One more than a search answer carries, so the count the page shows is not the total.
    for (let i = 0; i < HISTORY_SEARCH_LIMIT + 1; i++) {
      store.message(id, { ts: at + i, role: 'user', kind: 'normal', text: `deployment ${i}` });
    }
    const panel = buildHistoryPanel({ history: store, instance: 'webui' });

    const answer = panel.search('deployment');
    expect(answer.hits).toHaveLength(HISTORY_SEARCH_LIMIT);
    expect(answer.more).toBe(true);
    // A library with fewer matches is not a floor, and says nothing about one.
    expect(panel.search('nothing-matches-this').more).toBeUndefined();
    store.close();
  });

  it('reads one conversation whole and admits when the read was cut short', () => {
    const store = tempStore();
    const at = Date.now();
    const id = seed(store, 'webui#main#abcdef12', 'long', at);
    // One past the 500-row bound `read` applies to an unbounded read.
    for (let i = 0; i < 501; i++) store.message(id, { ts: at + i, role: 'agent', kind: 'normal', text: `line ${i}` });
    const panel = buildHistoryPanel({ history: store, instance: 'webui' });

    const read = panel.read(id);
    expect(read.session.title).toBe('long');
    expect(read.messages).toHaveLength(500);
    // The page says it in its own words: half a log presented as the whole is the failure it
    // prevents, and the store's `note` would name flags this page cannot run.
    expect(read.note).toMatch(/only the first 500 are shown/);
    expect(read.note).not.toMatch(/--around|--role|--window/);
    expect(() => panel.read(999_999)).toThrow(/no conversation/);
    store.close();
  });

  it('says nothing about folded tool calls: the page shows the folded lines as they are', () => {
    const store = tempStore();
    const at = Date.now();
    const id = seed(store, 'webui#main#abcdef12', 'tools', at);
    for (let i = 0; i < 4; i++) store.message(id, { ts: at + i, role: 'tool', kind: 'normal', text: `Bash: step ${i}` });
    store.message(id, { ts: at + 9, role: 'agent', kind: 'normal', text: 'done' });
    const panel = buildHistoryPanel({ history: store, instance: 'webui' });

    // The store says it folded a run (and its CLI note explains that); the page does not repeat it.
    const result = store.read(String(id));
    expect(result.folded).toBe(true);
    expect(result.note).toMatch(/--role tool/);
    expect(panel.read(id).note).toBeUndefined();
    store.close();
  });

  it('refuses a cursor it did not hand out rather than guessing at a page', () => {
    const store = tempStore();
    seed(store, 'webui#main#abcdef12', 'one', Date.now());
    const panel = buildHistoryPanel({ history: store, instance: 'webui' });
    expect(() => panel.list({ before: 'yesterday' })).toThrow(/not a page/);
    expect(() => panel.list({ before: '1.2.3' })).toThrow(/not a page/);
    store.close();
  });

  it('caps a page at the store\'s own ceiling whatever the caller asks for', () => {
    const store = tempStore();
    const at = Date.now();
    seed(store, 'webui#main#abcdef12', 'one', at);
    const panel = buildHistoryPanel({ history: store, instance: 'webui', max: 5000 });
    expect(HISTORY_PAGE_LIMIT).toBe(50);
    expect(panel.list({ limit: 5000 }).sessions).toHaveLength(1);
    store.close();
  });

  it('builds a cursor out of the row it names', () => {
    const at = Date.UTC(2026, 10, 10, 5, 0);
    expect(cursorOf({ id: 7, lastAt: new Date(at).toISOString() })).toBe(`${at}.7`);
  });
});
