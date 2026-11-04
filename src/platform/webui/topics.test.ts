import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { MAX_TOPICS, TopicStore } from './topics.js';

let dir = '';
let file = '';
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webui-topics-'));
  file = path.join(dir, 'topics.json');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('TopicStore', () => {
  it('mints ids that carry no character the address form gives meaning to', () => {
    // A topic id travels as the lane half of `main/<id>`, which `parseAddress` splits on `/`
    // and refuses to see twice — so an id containing one would break `--channel` and the
    // listen allowlist, far from here.
    const id = new TopicStore(file).create().id;
    expect(id).toMatch(/^[0-9a-f]{8}$/);
  });

  it('survives a restart, which is the whole reason it is a file', () => {
    // Losing it does not just empty the page: conversations.json still holds the agent binding
    // and session id under `<instance>#main#<id>`, so every context would still be alive and
    // no longer reachable.
    const first = new TopicStore(file);
    const a = first.create('alpha');
    first.touch(a.id, 12_345);

    const reopened = new TopicStore(file);
    expect(reopened.get(a.id)).toEqual({ id: a.id, title: 'alpha', lastAt: 12_345 });
  });

  it('orders most recently active first', () => {
    const store = new TopicStore(file);
    const a = store.create('a');
    const b = store.create('b');
    store.touch(a.id, 100);
    store.touch(b.id, 200);
    expect(store.list().map((t) => t.title)).toEqual(['b', 'a']);
  });

  it('always has a topic to be in, including on a fresh install', () => {
    const store = new TopicStore(file);
    expect(store.list()).toHaveLength(0);
    const current = store.current();
    expect(store.has(current.id)).toBe(true);
    // And it does not keep minting them once one exists.
    expect(store.current().id).toBe(current.id);
  });

  it('seeds a blank name from the first thing said, and never overwrites a real one', () => {
    const store = new TopicStore(file);
    const t = store.create();
    expect(store.seed(t.id, '  fix the   login timeout  ')).toBe(true);
    expect(store.get(t.id)?.title).toBe('fix the login timeout');
    expect(store.seed(t.id, 'something else')).toBe(false);
    expect(store.get(t.id)?.title).toBe('fix the login timeout');
  });

  it('is not seeded by a command, which says how the topic is set up rather than what it is about', () => {
    const store = new TopicStore(file);
    const t = store.create();
    expect(store.seed(t.id, '/agent oc2')).toBe(false);
    expect(store.get(t.id)?.title).toBe('');
    expect(store.seed(t.id, 'fix the login timeout')).toBe(true);
    expect(store.get(t.id)?.title).toBe('fix the login timeout');
  });

  it('truncates a long seed rather than putting a paragraph in the switcher', () => {
    const store = new TopicStore(file);
    const t = store.create();
    store.seed(t.id, 'x'.repeat(200));
    expect(store.get(t.id)?.title.length).toBeLessThanOrEqual(33);
    expect(store.get(t.id)?.title.endsWith('…')).toBe(true);
  });

  it('renames, which is what the harness-generated title lands on', () => {
    const store = new TopicStore(file);
    const t = store.create();
    expect(store.rename(t.id, '  [cc] 修复登录超时  ')).toBe(true);
    expect(store.get(t.id)?.title).toBe('[cc] 修复登录超时');
    expect(store.rename(t.id, '   ')).toBe(false);
    expect(store.rename('nope', 'x')).toBe(false);
  });

  it('deletes a topic and persists the removal across restarts', () => {
    const store = new TopicStore(file);
    const a = store.create('first');
    const b = store.create('second');
    expect(store.has(a.id)).toBe(true);
    expect(store.delete(a.id)).toBe(true);
    expect(store.has(a.id)).toBe(false);
    expect(store.delete(a.id)).toBe(false);
    expect(store.delete('nonexistent')).toBe(false);

    // Reopened store no longer has the deleted topic
    const reopened = new TopicStore(file);
    expect(reopened.has(a.id)).toBe(false);
    expect(reopened.has(b.id)).toBe(true);
  });

  it('forgets every topic in one write, leaving current() to mint the replacement', () => {
    const store = new TopicStore(file);
    store.create('first');
    store.create('second');

    expect(store.clear()).toBe(2);
    expect(store.list()).toEqual([]);
    // Empty rather than pre-seeded: `current()` is the one place that decides the page is never
    // without a room to be in, and two places deciding it is how they come to disagree.
    expect(new TopicStore(file).list()).toEqual([]);
    expect(store.clear()).toBe(0);

    const fresh = store.current();
    expect(new TopicStore(file).list().map((t) => t.id)).toEqual([fresh.id]);
  });

  it('still refuses past its cap on its own — making room is the caller' + "'s decision", () => {
    // The store cannot see whether a topic is mid-turn, asking, or a scheduled task's target, so it
    // never evicts by itself; `WebRoom.createTopic` asks `evictable` and deletes first.
    const store = new TopicStore(file);
    for (let i = 0; i < MAX_TOPICS; i += 1) store.create();
    expect(store.full()).toBe(true);
    expect(() => store.create()).toThrow(/already has 64 topics/);
  });

  it('remembers a star across a restart, and writes nothing for a topic without one', () => {
    const store = new TopicStore(file);
    const a = store.create('keep me');
    const b = store.create('plain');
    expect(store.star(a.id, true)).toBe(true);
    expect(store.star('ffffffff', true)).toBe(false);

    const reopened = new TopicStore(file);
    expect(reopened.get(a.id)?.starred).toBe(true);
    // Absent rather than false, on disk and in memory: a file from someone who never stars
    // anything is exactly what it was before stars existed.
    expect(reopened.get(b.id)).not.toHaveProperty('starred');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, Record<string, unknown>>;
    expect(raw[b.id]).not.toHaveProperty('starred');

    expect(reopened.star(a.id, false)).toBe(true);
    expect(new TopicStore(file).get(a.id)).not.toHaveProperty('starred');
  });

  it('trusts only a literal true as a star, since a star exempts a topic from every sweep', () => {
    fs.writeFileSync(file, JSON.stringify({ aaaaaaaa: { title: 'x', lastAt: 1, starred: 'yes' }, bbbbbbbb: { title: 'y', lastAt: 1, starred: true } }));
    const store = new TopicStore(file);
    expect(store.get('aaaaaaaa')).not.toHaveProperty('starred');
    expect(store.get('bbbbbbbb')?.starred).toBe(true);
  });

  it('offers the least recently active topic for eviction, never a starred one, never one in use', () => {
    const store = new TopicStore(file);
    const oldest = store.create('oldest');
    const older = store.create('older');
    const old = store.create('old');
    const recent = store.create('recent');
    store.touch(oldest.id, 1);
    store.touch(older.id, 2);
    store.touch(old.id, 3);
    store.touch(recent.id, 4);

    expect(store.evictable(() => false)?.id).toBe(oldest.id);
    store.star(oldest.id, true);
    expect(store.evictable(() => false)?.id).toBe(older.id);
    // `inUse` is the caller's: a topic it claims is skipped, and the next oldest is offered.
    expect(store.evictable((t) => t.id === older.id)?.id).toBe(old.id);
    // Nothing is offered when every topic is starred or claimed — the caller refuses then.
    expect(store.evictable(() => true)).toBeUndefined();
    // And choosing deletes nothing; that is the caller's too.
    expect(store.list()).toHaveLength(4);
  });

  it('leaves starred topics behind when the rest are cleared', () => {
    const store = new TopicStore(file);
    const kept = store.create('kept');
    store.create('gone');
    store.create('gone too');
    store.star(kept.id, true);

    expect(store.clear()).toBe(2);
    expect(new TopicStore(file).list().map((t) => t.id)).toEqual([kept.id]);
    // A list that is all stars has nothing to clear, and writes nothing.
    const before = fs.statSync(file).mtimeMs;
    expect(store.clear()).toBe(0);
    expect(fs.statSync(file).mtimeMs).toBe(before);
  });

  it('keeps a scheduled run marked as one across a restart', () => {
    // The page needs this on every later load: it is what keeps the run out of the switcher and
    // in the panel's Sessions tab. The title cannot stand in for it — a run can be renamed.
    const store = new TopicStore(file);
    const run = store.create('[cc] ⏰ Morning CI · 2026-11-04 08:00', undefined, { scheduled: true });
    const normal = store.create('[cc] an ordinary topic');

    const reopened = new TopicStore(file);
    expect(reopened.get(run.id)?.scheduled).toBe(true);
    expect(reopened.get(normal.id)).not.toHaveProperty('scheduled');
  });

  it('recognises the scheduled runs a file written before the flag existed', () => {
    // `openScheduledConversation` names a run `[agent] ⏰ <task> · <time>` and the automatic
    // namer never replaces that title, so it is the one trace an older file has left.
    fs.writeFileSync(
      file,
      JSON.stringify({
        aaaaaaaa: { title: '[cc] ⏰ Morning CI · 2026-11-04 08:00', lastAt: 5 },
        bbbbbbbb: { title: '[cc] a clock in the middle ⏰ is not a run', lastAt: 4 },
        cccccccc: { title: '⏰ no agent tag, so not one of ours', lastAt: 3 },
      })
    );

    const store = new TopicStore(file);
    expect(store.get('aaaaaaaa')?.scheduled).toBe(true);
    expect(store.get('bbbbbbbb')).not.toHaveProperty('scheduled');
    expect(store.get('cccccccc')).not.toHaveProperty('scheduled');
    // Adopted once, into the file: the next start does not have to guess again.
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).aaaaaaaa.scheduled).toBe(true);
  });

  it('starts empty on a corrupt file rather than taking the daemon down', () => {
    fs.writeFileSync(file, 'not json at all');
    expect(new TopicStore(file).list()).toEqual([]);
  });

  it('drops malformed entries rather than trusting them', () => {
    fs.writeFileSync(
      file,
      JSON.stringify({
        'aaaaaaaa': { title: 'good', lastAt: 5 },
        'not-an-id': { title: 'bad', lastAt: 5 },
        'bbbbbbbb': 'not an object',
        'cccccccc': { title: 42, lastAt: 'soon' },
      })
    );
    const store = new TopicStore(file);
    expect(store.list().map((t) => t.id).sort()).toEqual(['aaaaaaaa', 'cccccccc']);
    // The salvageable one keeps what was readable and defaults the rest.
    expect(store.get('cccccccc')).toEqual({ id: 'cccccccc', title: '', lastAt: 0 });
  });
});
