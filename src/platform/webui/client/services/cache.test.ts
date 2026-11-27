import { afterEach, describe, expect, it, vi } from 'vitest';

import { CACHE_CORE } from '../../cache-script.js';
import {
  type CacheCore,
  type CacheMessage,
  type CacheStoredRecord,
  collectCacheableMessages,
  createCacheService,
} from './cache.js';

function loadRealCacheCore(): CacheCore {
  const fn = new Function(
    `${CACHE_CORE}; return { STORE, cacheOpen, newer, cacheRecord, cachePut, cacheEvict };`,
  ) as () => CacheCore;
  return fn();
}

interface FakeIdbOptions {
  failOpen?: Error | string;
  throwOnTx?: Error;
  failWriteCount?: number;
  initial?: Record<string, CacheStoredRecord>;
}

function createFakeIdb(opts: FakeIdbOptions = {}): {
  factory: IDBFactory;
  records: Map<string, CacheStoredRecord>;
  evictedAll: () => boolean;
} {
  const records = new Map<string, CacheStoredRecord>(Object.entries(opts.initial ?? {}));
  let remainingWriteFailures = opts.failWriteCount ?? 0;
  let sawClearLikeEvict = false;

  const makeStore = (
    mode: IDBTransactionMode,
    beginOp: () => void,
    endOp: () => void,
    onFail: (err: Error) => void,
  ) => {
    const store = {
      get(key: string) {
        beginOp();
        const rq: Record<string, unknown> = { result: undefined, onsuccess: null, onerror: null };
        queueMicrotask(() => {
          rq.result = records.get(key);
          if (typeof rq.onsuccess === 'function') (rq.onsuccess as () => void)();
          endOp();
        });
        return rq;
      },
      put(rec: CacheStoredRecord) {
        beginOp();
        if (mode === 'readwrite' && remainingWriteFailures > 0) {
          remainingWriteFailures--;
          queueMicrotask(() => onFail(new Error('QuotaExceededError')));
          return {};
        }
        records.set(rec.topic, rec);
        queueMicrotask(() => endOp());
        return {};
      },
      delete(key: string) {
        records.delete(key);
        return {};
      },
      count() {
        beginOp();
        const rq: Record<string, unknown> = { result: records.size, onsuccess: null };
        queueMicrotask(() => {
          rq.result = records.size;
          if (typeof rq.onsuccess === 'function') (rq.onsuccess as () => void)();
          endOp();
        });
        return rq;
      },
      index(_name: string) {
        return {
          openKeyCursor() {
            beginOp();
            const entries = [...records.values()].sort((a, b) => a.at - b.at);
            const rq: Record<string, unknown> = { result: null, onsuccess: null };
            let idx = 0;
            const step = () => {
              if (idx >= entries.length) {
                rq.result = null;
                if (typeof rq.onsuccess === 'function') (rq.onsuccess as () => void)();
                endOp();
                return;
              }
              const current = entries[idx++]!;
              rq.result = {
                primaryKey: current.topic,
                continue() {
                  sawClearLikeEvict = true;
                  queueMicrotask(step);
                },
              };
              if (typeof rq.onsuccess === 'function') (rq.onsuccess as () => void)();
            };
            queueMicrotask(step);
            return rq;
          },
        };
      },
    };
    return store as unknown as IDBObjectStore;
  };

  const db = {
    objectStoreNames: { contains: () => true },
    transaction(_storeName: string, mode: IDBTransactionMode) {
      if (opts.throwOnTx) throw opts.throwOnTx;
      const tx: Record<string, unknown> = {
        error: null,
        oncomplete: null,
        onabort: null,
        onerror: null,
      };
      let settled = false;
      let pending = 0;
      const finish = () => {
        if (settled) return;
        settled = true;
        queueMicrotask(() => {
          if (typeof tx.oncomplete === 'function') (tx.oncomplete as () => void)();
        });
      };
      const beginOp = () => {
        pending++;
      };
      const endOp = () => {
        pending--;
        if (pending === 0) finish();
      };
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        tx.error = err;
        queueMicrotask(() => {
          if (typeof tx.onabort === 'function') (tx.onabort as () => void)();
        });
      };
      const store = makeStore(mode, beginOp, endOp, fail);
      tx.objectStore = () => store;
      // If a readwrite callback only calls synchronous delete without async get/cursor, finish on next tick.
      queueMicrotask(() => {
        if (pending === 0) finish();
      });
      return tx as unknown as IDBTransaction;
    },
  } as unknown as IDBDatabase;

  const factory = {
    open(_name: string, _ver?: number) {
      const rq: Record<string, unknown> = {
        result: db,
        error: opts.failOpen ?? null,
        onupgradeneeded: null,
        onsuccess: null,
        onerror: null,
        onblocked: null,
      };
      queueMicrotask(() => {
        if (opts.failOpen) {
          if (typeof rq.onerror === 'function') (rq.onerror as () => void)();
        } else {
          if (typeof rq.onsuccess === 'function') (rq.onsuccess as () => void)();
        }
      });
      return rq as unknown as IDBOpenDBRequest;
    },
  } as unknown as IDBFactory;

  return { factory, records, evictedAll: () => sawClearLikeEvict };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('services/cache', () => {
  const core = loadRealCacheCore();

  it('collectCacheableMessages reads DOM order and skips local or unknown rows', () => {
    const mkNode = (key: string | null) => ({
      getAttribute: (name: string) => (name === 'data-k' ? key : null),
      nextSibling: null as unknown,
    });
    const n1 = mkNode('1:w1');
    const n2 = mkNode('local:1');
    const n3 = mkNode(null);
    const n4 = mkNode('1:w2');
    n1.nextSibling = n2;
    n2.nextSibling = n3;
    n3.nextSibling = n4;
    const fakeLog = { firstChild: n1 } as unknown as ParentNode;
    const data: Record<string, CacheMessage> = {
      '1:w1': { id: 'w1', _g: 1 },
      'local:1': { id: 'local:1', _local: true },
      '1:w2': { id: 'w2', _g: 1 },
    };

    expect(collectCacheableMessages(fakeLog, data)).toEqual([
      { id: 'w1', _g: 1 },
      { id: 'w2', _g: 1 },
    ]);
    expect(collectCacheableMessages(null, data)).toEqual([]);
  });

  it('falls back to memory cache when IndexedDB is unavailable and trims by topic/message budget', async () => {
    const cache = createCacheService({
      core,
      getIndexedDB: () => null,
      getTopic: () => 't1',
      getEpoch: () => 10,
      isSynced: () => true,
      isStale: () => false,
      getLastEventId: () => 't1.a.1',
      collectScreenMessages: () => [],
      copyTopics: 2,
      copyMsgs: 3,
    });

    expect(cache.isDbAvailable()).toBe(false);
    const saved1 = await cache.put('t1', [{ id: '1' }, { id: '2' }], { epoch: 10, last: 't1.a.1' });
    expect(saved1).toBe(false);
    expect((await cache.get('t1'))?.msgs).toHaveLength(2);

    // Second topic fits within copyTopics=2 and copyMsgs=3 (2 + 1 <= 3).
    await cache.put('t2', [{ id: '3' }], { epoch: 10, last: 't2.a.1' });
    expect(cache.memCopy('t1')).not.toBeNull();
    expect(cache.memCopy('t2')).not.toBeNull();

    // Third topic pushes oldest ('t1') out of memory AND drops its version since db is off.
    await cache.put('t3', [{ id: '4' }], { epoch: 10, last: 't3.a.1' });
    expect(cache.memCopy('t1')).toBeNull();
    expect(cache.getVersion('t1')).toBeUndefined();
    expect(await cache.get('t1')).toBeNull();
    expect(cache.memCopy('t2')).not.toBeNull();
    expect(cache.memCopy('t3')).not.toBeNull();
  });

  it('writes and reads through IndexedDB while enforcing newer-copy monotonicity', async () => {
    const idb = createFakeIdb();
    const cache = createCacheService({
      core,
      getIndexedDB: () => idb.factory,
      getTopic: () => 't1',
      getEpoch: () => 10,
      isSynced: () => true,
      isStale: () => false,
      getLastEventId: () => 't1.a.5',
      collectScreenMessages: () => [{ id: 'm5', _g: 10 }],
    });

    const ok = await cache.put('t1', [{ id: 'm5', _g: 10 }], { epoch: 10, last: 't1.a.5' });
    expect(ok).toBe(true);
    expect(idb.records.has('t1')).toBe(true);

    // Older copy must not overwrite newer memory or DB copy.
    await cache.put('t1', [{ id: 'm2', _g: 10 }], { epoch: 10, last: 't1.a.2' });
    expect((await cache.get('t1'))?.last).toBe('t1.a.5');
    expect(cache.getVersion('t1')).toEqual({ last: 't1.a.5', epoch: 10 });

    // Simulate service worker writing a newer record directly to DB and notifying page via noteVersion.
    idb.records.set('t1', {
      topic: 't1',
      at: Date.now() + 100,
      epoch: 10,
      last: 't1.a.9',
      json: JSON.stringify([{ id: 'm9', _g: 10 }]),
    });
    cache.noteVersion('t1', 't1.a.9', 10);
    // Memory copy is now behind vers, so memCopy returns null and get() reads from DB.
    expect(cache.memCopy('t1')).toBeNull();
    const fresh = await cache.get('t1');
    expect(fresh?.last).toBe('t1.a.9');
    expect(fresh?.msgs).toEqual([{ id: 'm9', _g: 10 }]);
  });

  it('peeks version metadata without JSON parsing and handles corrupt DB records safely', async () => {
    const idb = createFakeIdb({
      initial: {
        t1: { topic: 't1', at: 1, epoch: 10, last: 't1.a.7', json: '[{"id":"1"}]' },
        corrupt: { topic: 'corrupt', at: 2, epoch: 10, last: 'corrupt.a.1', json: '{bad json' },
      },
    });
    const cache = createCacheService({
      core,
      getIndexedDB: () => idb.factory,
      getTopic: () => '',
      getEpoch: () => 10,
      isSynced: () => false,
      isStale: () => false,
      getLastEventId: () => '',
      collectScreenMessages: () => [],
    });

    await cache.peek('t1');
    expect(cache.getVersion('t1')).toEqual({ last: 't1.a.7', epoch: 10 });

    await cache.peek('missing');
    expect(cache.getVersion('missing')).toEqual({ last: '', epoch: 0 });

    const bad = await cache.get('corrupt');
    expect(bad).toBeNull();
    expect(cache.getVersion('corrupt')).toEqual({ last: '', epoch: 0 });
  });

  it('retries write once after evicting other topics on quota error, then disables on second failure', async () => {
    const warnings: unknown[] = [];
    const idbRecover = createFakeIdb({
      failWriteCount: 1,
      initial: {
        old: { topic: 'old', at: 1, epoch: 10, last: 'old.a.1', json: '[]' },
      },
    });
    const recoverable = createCacheService({
      core,
      getIndexedDB: () => idbRecover.factory,
      getTopic: () => 't1',
      getEpoch: () => 10,
      isSynced: () => true,
      isStale: () => false,
      getLastEventId: () => '',
      collectScreenMessages: () => [],
      warn: (_m, d) => warnings.push(d),
    });

    const ok = await recoverable.put('t1', [{ id: '1' }], { epoch: 10, last: 't1.a.1' });
    expect(ok).toBe(true);
    expect(recoverable.isDbAvailable()).toBe(true);
    expect(idbRecover.evictedAll()).toBe(true);
    expect(warnings).toHaveLength(0);

    const idbFail = createFakeIdb({ failWriteCount: 5 });
    const failing = createCacheService({
      core,
      getIndexedDB: () => idbFail.factory,
      getTopic: () => 't1',
      getEpoch: () => 10,
      isSynced: () => true,
      isStale: () => false,
      getLastEventId: () => '',
      collectScreenMessages: () => [],
      warn: (_m, d) => warnings.push(d),
    });

    const failed = await failing.put('t1', [{ id: '1' }], { epoch: 10, last: 't1.a.1' });
    expect(failed).toBe(false);
    expect(failing.isDbAvailable()).toBe(false);
    expect(warnings).toHaveLength(1);
  });

  it('disables DB once on open failure or synchronous transaction throw', async () => {
    const warnings: unknown[] = [];
    const badOpen = createFakeIdb({ failOpen: new Error('blocked') });
    const c1 = createCacheService({
      core,
      getIndexedDB: () => badOpen.factory,
      getTopic: () => '',
      getEpoch: () => 1,
      isSynced: () => false,
      isStale: () => false,
      getLastEventId: () => '',
      collectScreenMessages: () => [],
      warn: (_m, d) => warnings.push(d),
    });
    expect(await c1.put('a', [], { epoch: 1 })).toBe(false);
    expect(c1.isDbAvailable()).toBe(false);
    expect(warnings).toEqual(['blocked']);

    const badTx = createFakeIdb({ throwOnTx: new Error('tx-boom') });
    const c2 = createCacheService({
      core,
      getIndexedDB: () => badTx.factory,
      getTopic: () => '',
      getEpoch: () => 1,
      isSynced: () => false,
      isStale: () => false,
      getLastEventId: () => '',
      collectScreenMessages: () => [],
      warn: (_m, d) => warnings.push(d),
    });
    expect(await c2.put('a', [], { epoch: 1 })).toBe(false);
    expect(c2.isDbAvailable()).toBe(false);
    expect(warnings).toEqual(['blocked', 'tx-boom']);
  });

  it('supports drop, keepOnly, forget, prune, and debounced scheduleSave / immediate leave', async () => {
    vi.useFakeTimers();
    const idb = createFakeIdb();
    let topic = 't1';
    let epoch = 10;
    let synced = true;
    let lastEv = 't1.a.3';
    const msgs: CacheMessage[] = [{ id: 'm3', _g: 10 }];

    const cache = createCacheService({
      core,
      getIndexedDB: () => idb.factory,
      getTopic: () => topic,
      getEpoch: () => epoch,
      isSynced: () => synced,
      isStale: () => false,
      getLastEventId: () => lastEv,
      collectScreenMessages: () => msgs,
      saveMs: 400,
    });

    expect(cache.liveMeta()).toEqual({ epoch: 10, stale: false, last: 't1.a.3' });
    cache.scheduleSave();
    cache.scheduleSave();
    expect(cache.memCopy('t1')).toBeNull();
    vi.advanceTimersByTime(400);
    expect(cache.memCopy('t1')?.last).toBe('t1.a.3');

    // leave() cancels pending timer and flushes immediately.
    lastEv = 't1.a.4';
    cache.scheduleSave();
    cache.leave();
    expect(cache.memCopy('t1')?.last).toBe('t1.a.4');

    // keepOnly / forget / prune clean up memory and version maps.
    cache.setVersion('t2', { last: 't2.a.1', epoch: 10 });
    cache.setVersion('t3', { last: '', epoch: 0 });
    cache.forget('t3');
    expect(cache.getVersion('t3')).toBeUndefined();
    cache.prune({ t1: 1 });
    expect(cache.getVersion('t2')).toBeUndefined();
    expect(cache.getVersion('t1')).toBeDefined();

    cache.keepOnly({});
    expect(cache.memCopy('t1')).toBeNull();
    expect(cache.getVersion('t1')).toBeUndefined();

    // When not synced and lastEv belongs to another topic, liveMeta returns null.
    topic = 't9';
    epoch = 10;
    synced = false;
    lastEv = 't1.a.4';
    expect(cache.liveMeta()).toBeNull();

    cache.dispose();
  });

  it('schedules and flushes cache writes independently per open topic', () => {
    vi.useFakeTimers();
    const idb = createFakeIdb();
    const states: Record<string, { synced: boolean; stale: boolean; lastEventId: string; msgs: CacheMessage[] }> = {
      t1: { synced: true, stale: false, lastEventId: 't1.a.2', msgs: [{ id: 'm1', _g: 10 }] },
      t2: { synced: true, stale: false, lastEventId: 't2.a.5', msgs: [{ id: 'm2', _g: 10 }] },
    };
    const cache = createCacheService({
      core,
      getIndexedDB: () => idb.factory,
      getTopic: () => 't1',
      getEpoch: () => 10,
      isSynced: () => true,
      isStale: () => false,
      getLastEventId: () => 't1.a.2',
      collectScreenMessages: () => states.t1!.msgs,
      getTopicState: (id) => {
        const s = states[id];
        return s ? { synced: s.synced, stale: s.stale, lastEventId: s.lastEventId, collectMessages: () => s.msgs } : null;
      },
      getOpenTopics: () => ['t1', 't2'],
      saveMs: 400,
    });

    cache.scheduleSave('t1');
    cache.scheduleSave('t2');
    vi.advanceTimersByTime(400);
    expect(cache.memCopy('t1')?.last).toBe('t1.a.2');
    expect(cache.memCopy('t2')?.last).toBe('t2.a.5');

    states.t1!.lastEventId = 't1.a.3';
    states.t2!.lastEventId = 't2.a.6';
    cache.leave();
    expect(cache.memCopy('t1')?.last).toBe('t1.a.3');
    expect(cache.memCopy('t2')?.last).toBe('t2.a.6');
    cache.dispose();
  });
});
