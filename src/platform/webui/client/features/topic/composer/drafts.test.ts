// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDraftStore, DRAFT_IDLE_MS, DRAFT_MAX, DRAFTS_STORAGE_KEY, parseStoredDrafts } from './drafts.js';

describe('composer/drafts', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('parses valid stored drafts and ignores corrupt or non-string entries', () => {
    expect(parseStoredDrafts(null)).toEqual({});
    expect(parseStoredDrafts('{bad json')).toEqual({});
    expect(parseStoredDrafts(JSON.stringify({ t1: 'hello', t2: '', t3: 123 }))).toEqual({
      t1: { text: 'hello', s: 5, e: 5, files: [] },
    });
  });

  it('persists drafts per topic without clobbering another tab entry on disk', () => {
    localStorage.setItem(DRAFTS_STORAGE_KEY, JSON.stringify({ other: 'from-tab-2' }));
    const store = createDraftStore(localStorage);

    store.stash('t1', 'draft text', 2, 5, []);
    expect(store.get('t1')).toEqual({ text: 'draft text', s: 2, e: 5, files: [] });
    expect(JSON.parse(localStorage.getItem(DRAFTS_STORAGE_KEY) || '{}')).toEqual({
      other: 'from-tab-2',
      t1: 'draft text',
    });

    store.stash('t1', '', 0, 0, []);
    expect(store.has('t1')).toBe(false);
    expect(JSON.parse(localStorage.getItem(DRAFTS_STORAGE_KEY) || '{}')).toEqual({
      other: 'from-tab-2',
    });
  });

  it('keeps drafts exceeding DRAFT_MAX in memory only', () => {
    const store = createDraftStore(localStorage);
    const huge = 'x'.repeat(DRAFT_MAX + 1);
    store.stash('t1', huge, huge.length, huge.length, []);
    expect(store.get('t1')?.text).toBe(huge);
    expect(JSON.parse(localStorage.getItem(DRAFTS_STORAGE_KEY) || '{}')).toEqual({});
  });

  it('supports appendText, appendFile, prune, keepOnly, and debounced stash', () => {
    const store = createDraftStore(localStorage);
    store.seed('t1', 'hello');
    store.appendText('t1', 'world');
    expect(store.get('t1')?.text).toBe('hello world');

    store.appendFile('t2', { name: 'a.txt', mime: 'text/plain', data: 'YQ==' });
    expect(store.get('t2')?.files).toHaveLength(1);

    const onStash = vi.fn();
    store.scheduleStash(onStash);
    vi.advanceTimersByTime(DRAFT_IDLE_MS - 1);
    expect(onStash).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onStash).toHaveBeenCalledTimes(1);

    store.prune({ t1: 1 });
    expect(store.has('t1')).toBe(true);
    expect(store.has('t2')).toBe(false);

    store.keepOnly({});
    expect(store.has('t1')).toBe(false);
    expect(localStorage.getItem(DRAFTS_STORAGE_KEY)).toBeNull();
  });

  it('stashes on pagehide and visibilitychange(hidden) until disposed', () => {
    const store = createDraftStore(localStorage);
    const onStash = vi.fn();
    const sub = store.attachWindowEvents(document, window, onStash);

    window.dispatchEvent(new Event('pagehide'));
    expect(onStash).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(onStash).toHaveBeenCalledTimes(2);

    sub.dispose();
    window.dispatchEvent(new Event('pagehide'));
    expect(onStash).toHaveBeenCalledTimes(2);
  });
});
