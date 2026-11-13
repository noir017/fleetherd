import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SESSION_TTL_MS, SessionStore } from './store.js';

/**
 * The state file is what makes a daemon restart (or an idle child being reclaimed) keep its
 * context, so the things worth pinning are persistence, the 0600 mode, and pruning: a record that
 * outlives the API's retention turns the next turn into a failed continuation.
 */

const dirs: string[] = [];
function storeFile(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'api-agent-store-'));
  dirs.push(dir);
  return path.join(dir, 'api-agent', 'antigravity.json');
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('SessionStore', () => {
  it('persists a record across instances, with the ids the next turn needs', () => {
    const file = storeFile();
    const first = new SessionStore({ file, log: () => {} });
    first.put({ sessionId: 's1', model: 'gemini-4-hydrogen', lastInteractionId: 'v1_a', environmentId: 'env_a' });

    const second = new SessionStore({ file, log: () => {} });
    expect(second.get('s1')).toMatchObject({
      sessionId: 's1',
      model: 'gemini-4-hydrogen',
      lastInteractionId: 'v1_a',
      environmentId: 'env_a',
    });
    expect(second.get('nope')).toBeUndefined();
  });

  it('writes the file 0600 in a 0700 directory, and leaves no temp file behind', () => {
    const file = storeFile();
    const store = new SessionStore({ file, log: () => {} });
    store.put({ sessionId: 's1' });

    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(readdirSync(path.dirname(file))).toEqual(['antigravity.json']);
  });

  it('drops records older than the TTL when loading, and when writing', () => {
    const file = storeFile();
    let now = 1_000_000_000_000;
    const clock = (): number => now;
    const store = new SessionStore({ file, now: clock, log: () => {} });
    store.put({ sessionId: 'old', lastInteractionId: 'v1_old' });
    now += SESSION_TTL_MS + 1;
    store.put({ sessionId: 'fresh', lastInteractionId: 'v1_new' });

    expect(store.get('old')).toBeUndefined();
    expect(store.get('fresh')).toBeDefined();
    expect(store.size()).toBe(1);

    const reloaded = new SessionStore({ file, now: clock, log: () => {} });
    expect(reloaded.size()).toBe(1);
    expect(reloaded.get('fresh')).toBeDefined();
  });

  it('starts empty on a corrupt file instead of failing the agent', () => {
    const file = storeFile();
    const store = new SessionStore({ file, log: () => {} });
    store.put({ sessionId: 's1' });
    writeFileSync(file, '{not json');

    const lines: string[] = [];
    const reloaded = new SessionStore({ file, log: (line) => lines.push(line) });
    expect(reloaded.size()).toBe(0);
    expect(lines.join('\n')).toContain('not valid JSON');
    // The next write repairs it.
    reloaded.put({ sessionId: 's2' });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ version: 1, sessions: { s2: {} } });
  });

  it('deletes a record and persists the deletion', () => {
    const file = storeFile();
    const store = new SessionStore({ file, log: () => {} });
    store.put({ sessionId: 's1', lastInteractionId: 'v1_a' });
    store.delete('s1');
    expect(new SessionStore({ file, log: () => {} }).get('s1')).toBeUndefined();
  });

  it('returns copies, so a caller cannot mutate stored state by accident', () => {
    const store = new SessionStore({ file: storeFile(), log: () => {} });
    const record = store.put({ sessionId: 's1', lastInteractionId: 'v1_a' });
    record.lastInteractionId = 'mutated';
    expect(store.get('s1')?.lastInteractionId).toBe('v1_a');
  });
});
