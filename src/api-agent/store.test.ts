import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SESSION_TTL_MS, SessionStore } from './store.js';

/**
 * The state files are what make a daemon restart (or an idle child being reclaimed) keep its
 * context, so what is worth pinning is persistence, the 0600 mode, one file per session (two
 * agents of one backend used to overwrite each other), and pruning by mtime: a record that
 * outlives the API's retention turns the next turn into a failed continuation.
 */

const dirs: string[] = [];
function storeDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'api-agent-store-'));
  dirs.push(dir);
  return path.join(dir, 'api-agent', 'antigravity');
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('SessionStore', () => {
  it('persists a record across instances, with the ids the next turn needs', () => {
    const dir = storeDir();
    const first = new SessionStore({ dir, log: () => {} });
    first.put({ sessionId: 's1', model: 'gemini-4-hydrogen', lastInteractionId: 'v1_a', environmentId: 'env_a' });

    const second = new SessionStore({ dir, log: () => {} });
    expect(second.get('s1')).toMatchObject({
      sessionId: 's1',
      model: 'gemini-4-hydrogen',
      lastInteractionId: 'v1_a',
      environmentId: 'env_a',
    });
    expect(second.get('nope')).toBeUndefined();
  });

  it('writes one file per session, 0600 in a 0700 directory, with no temp file left behind', () => {
    const dir = storeDir();
    const store = new SessionStore({ dir, log: () => {} });
    store.put({ sessionId: 's1' });
    store.put({ sessionId: 's2' });

    expect(readdirSync(dir).sort()).toEqual(['s1.json', 's2.json']);
    expect(statSync(path.join(dir, 's1.json')).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('two sessions never clobber each other, which is what the single-file map did', () => {
    const dir = storeDir();
    const a = new SessionStore({ dir, log: () => {} });
    a.put({ sessionId: 'conv-a', lastInteractionId: 'v1_a' });
    // A second agent process of the same backend, with its own store and its own session.
    const b = new SessionStore({ dir, log: () => {} });
    b.put({ sessionId: 'conv-b', lastInteractionId: 'v1_b' });

    const reread = new SessionStore({ dir, log: () => {} });
    expect(reread.get('conv-a')?.lastInteractionId).toBe('v1_a');
    expect(reread.get('conv-b')?.lastInteractionId).toBe('v1_b');
  });

  it('patch updates only the named fields, keeping a model that changed mid-turn', () => {
    const store = new SessionStore({ dir: storeDir(), log: () => {} });
    store.put({ sessionId: 's1', model: 'gemini-4-hydrogen', lastInteractionId: 'v1_a', environmentId: 'env_a' });
    store.patch('s1', { environmentId: 'env_b' });
    // A /model switch lands while the turn is running.
    store.put({ sessionId: 's1', model: 'gemini-3.8-flash', lastInteractionId: 'v1_a', environmentId: 'env_b' });
    store.patch('s1', { lastInteractionId: 'v1_b' });

    expect(store.get('s1')).toMatchObject({
      model: 'gemini-3.8-flash',
      lastInteractionId: 'v1_b',
      environmentId: 'env_b',
    });
  });

  it('clearContext drops the continuation ids but keeps the model', () => {
    const store = new SessionStore({ dir: storeDir(), log: () => {} });
    store.put({ sessionId: 's1', model: 'gemini-3.8-flash', lastInteractionId: 'v1_a', environmentId: 'env_a' });
    store.clearContext('s1');

    expect(store.get('s1')).toMatchObject({ model: 'gemini-3.8-flash' });
    expect(store.get('s1')?.lastInteractionId).toBeUndefined();
    expect(store.get('s1')?.environmentId).toBeUndefined();
  });

  it('prunes files whose mtime is older than the TTL', () => {
    const dir = storeDir();
    const store = new SessionStore({ dir, log: () => {} });
    store.put({ sessionId: 'old', lastInteractionId: 'v1_old' });
    store.put({ sessionId: 'fresh', lastInteractionId: 'v1_new' });

    const old = new Date(Date.now() - SESSION_TTL_MS - 60_000);
    utimesSync(path.join(dir, 'old.json'), old, old);
    const reloaded = new SessionStore({ dir, log: () => {} });

    expect(reloaded.get('old')).toBeUndefined();
    expect(reloaded.get('fresh')).toBeDefined();
    expect(readdirSync(dir)).toEqual(['fresh.json']);
  });

  it('starts empty on a corrupt file instead of failing the agent', () => {
    const dir = storeDir();
    const store = new SessionStore({ dir, log: () => {} });
    store.put({ sessionId: 's1' });
    writeFileSync(path.join(dir, 's1.json'), '{not json');

    const lines: string[] = [];
    const reloaded = new SessionStore({ dir, log: (line) => lines.push(line) });
    expect(reloaded.get('s1')).toBeUndefined();
    expect(lines.join('\n')).toContain('not valid JSON');
    // The next write repairs it.
    reloaded.put({ sessionId: 's1', lastInteractionId: 'v1_a' });
    expect(JSON.parse(readFileSync(path.join(dir, 's1.json'), 'utf8'))).toMatchObject({
      version: 1,
      session: { sessionId: 's1', lastInteractionId: 'v1_a' },
    });
  });

  it('refuses a session id that is not a plain filename', () => {
    const store = new SessionStore({ dir: storeDir(), log: () => {} });
    expect(() => store.put({ sessionId: '../escape' })).toThrow(/invalid session id/);
    expect(() => store.get('..')).toThrow(/invalid session id/);
  });

  it('deletes a record and its file', () => {
    const dir = storeDir();
    const store = new SessionStore({ dir, log: () => {} });
    store.put({ sessionId: 's1', lastInteractionId: 'v1_a' });
    store.delete('s1');
    expect(new SessionStore({ dir, log: () => {} }).get('s1')).toBeUndefined();
    expect(readdirSync(dir)).toEqual([]);
  });

  it('returns copies, so a caller cannot mutate stored state by accident', () => {
    const store = new SessionStore({ dir: storeDir(), log: () => {} });
    const record = store.put({ sessionId: 's1', lastInteractionId: 'v1_a' });
    record.lastInteractionId = 'mutated';
    expect(store.get('s1')?.lastInteractionId).toBe('v1_a');
  });

  it('does not create the directory until there is something to write', () => {
    const dir = storeDir();
    new SessionStore({ dir, log: () => {} });
    expect(() => statSync(dir)).toThrow();
  });
});
