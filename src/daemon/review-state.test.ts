import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  REVIEW_CAPACITY_MAX_ATTEMPTS,
  REVIEW_CAPACITY_RETRY_MS,
  REVIEW_RETRY_MS,
  ReviewStateStore,
  preferenceKey,
} from './review-state.js';

let dir: string;
let file: string;
let logs: string[];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'talkcode-review-state-'));
  file = path.join(dir, 'reviews.json');
  logs = [];
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const T0 = Date.UTC(2026, 10, 4, 12, 0);

function store(): ReviewStateStore {
  return new ReviewStateStore(file, (m) => logs.push(m));
}

describe('ReviewStateStore', () => {
  it('has no mark for a conversation that was never reviewed', () => {
    expect(store().markOf('a')).toBeUndefined();
    expect(store().ready('a', T0)).toBe(true);
  });

  it('remembers the watermark a review reached', () => {
    store().reviewed('a', 42, T0);
    const mark = store().markOf('a');
    expect(mark?.messageId).toBe(42);
    expect(mark?.at).toBe(new Date(T0).toISOString());
    expect(mark?.retryAt).toBeUndefined();
  });

  it('keeps the watermark on a failure and waits before trying again', () => {
    store().reviewed('a', 42, T0);
    store().failed('a', 'agy exited 1', T0 + 1_000);
    const mark = store().markOf('a');
    expect(mark?.messageId).toBe(42);
    expect(mark?.error).toBe('agy exited 1');
    expect(store().ready('a', T0 + 1_000)).toBe(false);
    expect(store().ready('a', T0 + 1_000 + REVIEW_RETRY_MS)).toBe(true);
  });

  it('counts consecutive failures on a batch and resets them on a review', () => {
    const s = store();
    expect(s.failed('a', 'agy exited 1', T0)).toEqual({ attempts: 1, counted: true });
    expect(s.failed('a', 'agy exited 1', T0).attempts).toBe(2);
    s.reviewed('a', 42, T0);
    expect(s.markOf('a')?.attempts).toBeUndefined();
    expect(s.failed('a', 'agy exited 1', T0).attempts).toBe(1);
  });

  it('does not count a capacity failure and waits an hour instead of six', () => {
    const s = store();
    expect(s.failed('a', 'UNAVAILABLE (503): No capacity available', T0, 'capacity')).toEqual({
      attempts: 0,
      counted: false,
    });
    const mark = s.markOf('a');
    expect(mark).toMatchObject({ messageId: 0, attempts: 0, capacity: true, capacityAttempts: 1 });
    expect(Date.parse(mark!.retryAt!)).toBe(T0 + REVIEW_CAPACITY_RETRY_MS);
    expect(s.ready('a', T0 + REVIEW_CAPACITY_RETRY_MS - 1)).toBe(false);
    expect(s.ready('a', T0 + REVIEW_CAPACITY_RETRY_MS)).toBe(true);
  });

  it('keeps the counted attempts across a capacity failure and clears its flag on a real one', () => {
    const s = store();
    expect(s.failed('a', 'agy exited 1', T0).attempts).toBe(1);
    s.failed('a', 'No capacity available', T0 + 1, 'capacity');
    expect(s.markOf('a')?.attempts).toBe(1);
    expect(s.markOf('a')?.capacity).toBe(true);
    expect(s.markOf('a')?.capacityAttempts).toBe(1);

    // The next ordinary failure is attempt 2, not a fresh start: the capacity wait was not an
    // attempt, so the batch's real count is unchanged. A non-capacity failure also ends the streak.
    expect(s.failed('a', 'agy exited 1', T0 + 2)).toEqual({ attempts: 2, counted: true });
    expect(s.markOf('a')?.capacity).toBeUndefined();
    expect(s.markOf('a')?.capacityAttempts).toBeUndefined();
  });

  it('counts capacity failures once the streak passes the cap', () => {
    const s = store();
    for (let i = 1; i <= REVIEW_CAPACITY_MAX_ATTEMPTS; i++) {
      expect(s.failed('a', 'No capacity available', T0, 'capacity')).toEqual({ attempts: 0, counted: false });
      expect(s.markOf('a')?.capacityAttempts).toBe(i);
    }

    // One past the cap: recorded as an ordinary failure, six-hour wait, and no longer flagged —
    // this is the backstop for a fault that keeps looking like a capacity drought.
    expect(s.failed('a', 'No capacity available', T0, 'capacity')).toEqual({ attempts: 1, counted: true });
    const mark = s.markOf('a');
    expect(mark).toMatchObject({ attempts: 1, capacityAttempts: REVIEW_CAPACITY_MAX_ATTEMPTS + 1 });
    expect(mark?.capacity).toBeUndefined();
    expect(Date.parse(mark!.retryAt!)).toBe(T0 + REVIEW_RETRY_MS);

    // And the next one counts too, rather than restarting the streak.
    expect(s.failed('a', 'No capacity available', T0, 'capacity')).toEqual({ attempts: 2, counted: true });
  });

  it('reads a mark written before capacity failures were distinguished', () => {
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        conversations: { a: { messageId: 42, at: new Date(T0).toISOString(), attempts: 2, error: 'agy exited 1' } },
      })
    );
    const mark = store().markOf('a');
    expect(mark).toMatchObject({ messageId: 42, attempts: 2 });
    // Absent is the old behaviour and the safe reading: an ordinary failure, six-hour wait.
    expect(mark?.capacity).toBeUndefined();
  });

  it('gives up on a batch by moving the watermark and clearing the retry', () => {
    const s = store();
    s.failed('a', 'agy exited 1', T0);
    s.gaveUp('a', 42, 'gave up after 3 attempts: agy exited 1', T0);
    const mark = s.markOf('a');
    expect(mark?.messageId).toBe(42);
    expect(mark?.retryAt).toBeUndefined();
    expect(mark?.attempts).toBeUndefined();
    expect(mark?.error).toContain('gave up after 3 attempts');
  });

  it('writes the file 0600', () => {
    store().reviewed('a', 1, T0);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('reads a file written before the daily cap was removed', () => {
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        conversations: { a: { messageId: 42, at: new Date(T0).toISOString() } },
        day: '2026-11-04',
        count: 7,
      })
    );
    const s = store();
    expect(s.markOf('a')?.messageId).toBe(42);
    // The old fields are not a reason to reject the file, and the next write drops them.
    s.reviewed('b', 1, T0);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(saved.conversations.a.messageId).toBe(42);
    expect(saved.conversations.b.messageId).toBe(1);
    expect(saved.day).toBeUndefined();
    expect(saved.count).toBeUndefined();
  });

  it('keeps a mark in memory when the file cannot be written, so the sweep does not loop', () => {
    // A directory where the file should be: every write fails, whatever the process can do.
    fs.mkdirSync(file);
    const s = store();
    s.reviewed('a', 42, T0);
    expect(s.markOf('a')?.messageId).toBe(42);
    expect(logs.some((l) => l.includes('could not write'))).toBe(true);
  });

  it('remembers a failure in memory too, so a broken reviewer is not retried on the next tick', () => {
    fs.mkdirSync(file);
    const s = store();
    s.failed('a', 'agy exited 1', T0);
    expect(s.ready('a', T0 + 60_000)).toBe(false);
    expect(s.ready('a', T0 + REVIEW_RETRY_MS)).toBe(true);
  });

  it('degrades to empty on a corrupt file instead of throwing', () => {
    fs.writeFileSync(file, '{not json');
    expect(store().markOf('a')).toBeUndefined();
    expect(logs.some((l) => l.includes('could not read'))).toBe(true);
  });
});

describe('dismissed preference suggestions', () => {
  it('names one suggestion the same however it is spaced or ended', () => {
    expect(preferenceKey('代码只推送到自建 Gitea。')).toBe(preferenceKey('代码只推送到自建Gitea'));
    expect(preferenceKey('回答先给结论')).not.toBe(preferenceKey('回答先说结论'));
  });

  it('keeps dismissals beside the watermarks, and neither write loses the other', () => {
    const s = store();
    s.reviewed('a', 42, T0);
    s.dismissPreference('回答先给结论。');
    s.failed('b', 'agy exited 1', T0);
    const again = store();
    expect([...again.dismissedPreferences()]).toEqual(['回答先给结论']);
    expect(again.markOf('a')?.messageId).toBe(42);
    expect(again.markOf('b')?.error).toBe('agy exited 1');
  });

  it('honours a dismissal it could not write, for this process', () => {
    fs.mkdirSync(file);
    const s = store();
    s.dismissPreference('回答先给结论');
    expect(s.dismissedPreferences().has('回答先给结论')).toBe(true);
  });
});
