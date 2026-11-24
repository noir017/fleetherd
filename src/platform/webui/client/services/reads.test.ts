import { describe, expect, it, vi } from 'vitest';

import { createReadsService, type ReadTopicLike } from './reads.js';
import { type StorageLike, StorageService } from './storage.js';

function createMemoryStorage(initial: Record<string, string> = {}): {
  storage: StorageService;
  raw: Map<string, string>;
} {
  const raw = new Map<string, string>(Object.entries(initial));
  const backend: StorageLike = {
    getItem: (k) => raw.get(k) ?? null,
    setItem: (k, v) => {
      raw.set(k, v);
    },
    removeItem: (k) => {
      raw.delete(k);
    },
  };
  return { storage: new StorageService('', backend), raw };
}

describe('services/reads', () => {
  it('loads valid counts from storage and ignores corrupt or invalid entries', () => {
    const valid = createMemoryStorage({
      aa_reads: JSON.stringify({ a: 3, b: 0, bad: -1, str: 'x', nan: null }),
    });
    const s1 = createReadsService({
      storage: valid.storage,
      getActiveTopic: () => '',
      getTopics: () => [],
    });
    expect(s1.getAll()).toEqual({ a: 3, b: 0 });

    const corrupt = createMemoryStorage({ aa_reads: '{not-json' });
    const s2 = createReadsService({
      storage: corrupt.storage,
      getActiveTopic: () => '',
      getTopics: () => [],
    });
    expect(s2.getAll()).toEqual({});

    const arrayVal = createMemoryStorage({ aa_reads: '[1,2,3]' });
    const s3 = createReadsService({
      storage: arrayVal.storage,
      getActiveTopic: () => '',
      getTopics: () => [],
    });
    expect(s3.getAll()).toEqual({});
  });

  it('persists setCount, increment, remove, keepOnly, and high-water-mark merge', () => {
    const { storage, raw } = createMemoryStorage();
    const reads = createReadsService({
      storage,
      getActiveTopic: () => '',
      getTopics: () => [],
    });

    reads.setCount('a', 2);
    expect(reads.increment('a')).toBe(3);
    expect(reads.increment('b', 4)).toBe(4);
    expect(JSON.parse(raw.get('aa_reads') ?? '{}')).toEqual({ a: 3, b: 4 });

    // Merge only raises watermarks or adds new keys; lower values do not regress.
    expect(reads.merge({ a: 1, b: 6, c: 2, bad: -5 })).toBe(true);
    expect(reads.getAll()).toEqual({ a: 3, b: 6, c: 2 });
    expect(reads.merge({ a: 3, b: 2 })).toBe(false);

    reads.remove('b');
    expect(reads.getCount('b')).toBeUndefined();

    reads.keepOnly({ c: 1 });
    expect(reads.getAll()).toEqual({ c: 2 });
    expect(JSON.parse(raw.get('aa_reads') ?? '{}')).toEqual({ c: 2 });
  });

  it('computes unreadOf, unseenReply, needsRead, and syncTopics accurately', () => {
    const { storage } = createMemoryStorage({ aa_reads: JSON.stringify({ b: 2 }) });
    let active = 'a';
    const topics: ReadTopicLike[] = [
      { id: 'a', msgCount: 5, stage: 'review' },
      { id: 'b', msgCount: 5, stage: 'idle' },
      { id: 'c', msgCount: 4, stage: 'review' },
      { id: 'sub', msgCount: 4, stage: 'review', parent: 'a' },
    ];
    const reads = createReadsService({
      storage,
      getActiveTopic: () => active,
      getTopics: () => topics,
    });

    reads.syncTopics(topics, active);
    expect(reads.getCount('a')).toBe(5);
    expect(reads.getCount('b')).toBe(2);
    expect(reads.getCount('c')).toBe(4);
    expect(reads.getCount('sub')).toBe(4);

    // Active topic is always 0 unread and never needsRead.
    expect(reads.unreadOf(topics[0]!)).toBe(0);
    expect(reads.needsRead(topics[0]!)).toBe(false);

    // b has 3 unread messages.
    expect(reads.unreadOf(topics[1]!)).toBe(3);
    expect(reads.needsRead(topics[1]!)).toBe(true);

    // c has 0 unread messages, but stage=review with no parent => unseenReply & needsRead.
    expect(reads.unreadOf(topics[2]!)).toBe(0);
    expect(reads.unseenReply(topics[2]!)).toBe(true);
    expect(reads.needsRead(topics[2]!)).toBe(true);

    // sub-agent with parent has no green dot to clear.
    expect(reads.unseenReply(topics[3]!)).toBe(false);
    expect(reads.needsRead(topics[3]!)).toBe(false);

    active = 'b';
    reads.markTopicFromList('b', topics);
    expect(reads.getCount('b')).toBe(5);
  });

  it('markAllRead stamps counts, posts api/seen sequentially, and reports failures', async () => {
    const { storage } = createMemoryStorage({ aa_reads: JSON.stringify({ a: 0, b: 0, c: 0 }) });
    const order: string[] = [];
    let inFlight = 0;
    let maxConcurrent = 0;
    const onChanged = vi.fn();
    const said: string[] = [];

    const reads = createReadsService({
      storage,
      getActiveTopic: () => '',
      getTopics: () => [],
      onChanged,
      formatMarkFailed: (n, noun) => `${n} ${noun} failed`,
      postSeen: async (id) => {
        inFlight++;
        maxConcurrent = Math.max(maxConcurrent, inFlight);
        order.push(id);
        await Promise.resolve();
        inFlight--;
        if (id === 'b') return { ok: false };
        if (id === 'c') throw new Error('network');
        return { ok: true };
      },
    });

    const list: ReadTopicLike[] = [
      { id: 'a', msgCount: 3, stage: 'review' },
      { id: 'b', msgCount: 2, stage: 'review' },
      { id: 'c', msgCount: 1, stage: 'review' },
      { id: 'd', msgCount: 4, stage: 'idle' },
      { id: 'sub', msgCount: 2, stage: 'review', parent: 'a' },
    ];

    const failed = await reads.markAllRead(list, 'topics', (msg) => said.push(msg));
    expect(failed).toBe(2);
    expect(maxConcurrent).toBe(1);
    expect(order).toEqual(['a', 'b', 'c']);
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(reads.getAll()).toEqual({ a: 3, b: 2, c: 1, d: 4, sub: 2 });
    expect(said).toEqual(['2 topics failed']);
  });

  it('reportSeen throttles per topic and respects visibility and overlay blocking', () => {
    const { storage } = createMemoryStorage();
    let now = 10000;
    let blocking = false;
    const posted: string[] = [];
    const topics: ReadTopicLike[] = [{ id: 't1', msgCount: 2, stage: 'review' }];

    const docTarget = new EventTarget();
    let visState: DocumentVisibilityState = 'visible';
    Object.defineProperty(docTarget, 'visibilityState', {
      get: () => visState,
    });

    const winTarget = new EventTarget();
    const onChanged = vi.fn();

    const reads = createReadsService({
      storage,
      getActiveTopic: () => 't1',
      getTopics: () => topics,
      isOverlayBlocking: () => blocking,
      postSeen: async (id) => {
        posted.push(id);
        return { ok: true };
      },
      onChanged,
      now: () => now,
      seenThrottleMs: 2000,
    });

    reads.attachWindowEvents(docTarget as unknown as Document, winTarget as unknown as Window);

    // Blocked by overlay -> no post.
    blocking = true;
    reads.reportSeen();
    expect(posted).toEqual([]);

    // Visible and unblocked -> posts once, throttled within 2000ms.
    blocking = false;
    reads.reportSeen();
    expect(posted).toEqual(['t1']);

    now += 1500;
    reads.reportSeen();
    expect(posted).toEqual(['t1']);

    // Hidden -> no post even after throttle window.
    now += 1000;
    visState = 'hidden';
    docTarget.dispatchEvent(new Event('visibilitychange'));
    expect(posted).toEqual(['t1']);

    // Visible again -> visibilitychange triggers reportSeen.
    visState = 'visible';
    docTarget.dispatchEvent(new Event('visibilitychange'));
    expect(posted).toEqual(['t1', 't1']);

    // Cross-tab storage event merges higher watermarks and notifies onChanged.
    const storageEv = new Event('storage') as Event & { key: string | null; newValue: string | null };
    storageEv.key = 'aa_reads';
    storageEv.newValue = JSON.stringify({ t1: 7, t2: 4 });
    winTarget.dispatchEvent(storageEv);
    expect(reads.getAll()).toEqual({ t1: 7, t2: 4 });
    expect(onChanged).toHaveBeenCalledTimes(1);

    // Disposing detaches listeners.
    reads.dispose();
    now += 5000;
    docTarget.dispatchEvent(new Event('visibilitychange'));
    expect(posted).toEqual(['t1', 't1']);
  });
});
