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

  it('counts a day and starts over on the next one', () => {
    const s = store();
    expect(s.takeSlot(2, T0)).toBe(true);
    expect(s.takeSlot(2, T0 + 1)).toBe(true);
    expect(s.takeSlot(2, T0 + 2)).toBe(false);
    expect(s.countToday(T0)).toBe(2);
    expect(s.countToday(T0 + 86_400_000)).toBe(0);
    expect(s.takeSlot(2, T0 + 86_400_000)).toBe(true);
  });

  it('degrades to empty on a corrupt file instead of throwing', () => {
    fs.writeFileSync(file, '{not json');
    expect(store().markOf('a')).toBeUndefined();
    expect(logs.some((l) => l.includes('could not read'))).toBe(true);
  });
});
