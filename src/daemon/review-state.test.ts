import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REVIEW_RETRY_MS, ReviewStateStore } from './review-state.js';

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
