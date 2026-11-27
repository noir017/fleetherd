import type { Disposable } from '../base/lifecycle.js';

export interface CacheMessage {
  readonly id?: string;
  readonly _g?: number;
  readonly _local?: boolean;
  readonly [key: string]: unknown;
}

export interface CacheMeta {
  readonly epoch: number;
  readonly last?: string;
  readonly stale?: boolean;
}

export interface CacheCopy {
  readonly topic?: string;
  readonly msgs: readonly CacheMessage[];
  readonly epoch: number;
  readonly last: string;
  readonly stale: boolean;
  readonly at?: number;
}

export interface CacheVersion {
  readonly last: string;
  readonly epoch: number;
}

export interface CacheStoredRecord {
  readonly topic: string;
  readonly at: number;
  readonly json: string;
  readonly epoch?: number;
  readonly last?: string;
  readonly stale?: boolean;
}

export interface CacheOpenResult {
  readonly db?: IDBDatabase;
  readonly error?: unknown;
}

export interface CachePutResult {
  stood: CacheStoredRecord | null;
}

/**
 * Shared contract injected from `src/platform/webui/cache-script.ts` (`CACHE_CORE`) at build time
 * so the page and `sw.ts` use the exact same IndexedDB schema, rotation, and freshness rules.
 */
export interface CacheCore {
  readonly STORE: string;
  readonly cacheOpen: (factory: IDBFactory) => Promise<CacheOpenResult>;
  readonly newer: (
    a: string | undefined,
    b: string | undefined,
    aEpoch?: number,
    bEpoch?: number,
  ) => boolean;
  readonly cacheRecord: (
    tId: string,
    msgs: readonly CacheMessage[],
    meta: CacheMeta,
  ) => CacheStoredRecord;
  readonly cachePut: (store: IDBObjectStore, rec: CacheStoredRecord) => CachePutResult;
  readonly cacheEvict: (store: IDBObjectStore, keep: string, all: boolean) => void;
}

export interface CacheTopicState {
  readonly synced: boolean;
  readonly stale: boolean;
  readonly lastEventId: string;
  readonly collectMessages: () => CacheMessage[];
}

export interface CacheServiceDeps {
  readonly core: CacheCore;
  readonly getIndexedDB?: () => IDBFactory | undefined | null;
  readonly getTopic: () => string;
  readonly getEpoch: () => number;
  readonly isSynced: () => boolean;
  readonly isStale: () => boolean;
  readonly getLastEventId: () => string;
  readonly collectScreenMessages: () => CacheMessage[];
  readonly getTopicState?: (topicId: string) => CacheTopicState | null;
  readonly getOpenTopics?: () => readonly string[];
  readonly saveMs?: number;
  readonly copyTopics?: number;
  readonly copyMsgs?: number;
  readonly warn?: (msg: string, detail: unknown) => void;
}

export interface CacheService extends Disposable {
  isDbAvailable(): boolean;
  getVersion(id: string): CacheVersion | undefined;
  setVersion(id: string, version: CacheVersion): void;
  noteVersion(id: string, last: string | undefined, epoch: number | undefined): void;
  isNewer(
    a: string | undefined,
    b: string | undefined,
    aEpoch?: number,
    bEpoch?: number,
  ): boolean;
  memCopy(id: string): CacheCopy | null;
  put(id: string, msgs: readonly CacheMessage[], meta: CacheMeta): Promise<boolean>;
  get(id: string): Promise<CacheCopy | null>;
  peek(id: string): Promise<void>;
  drop(id: string): void;
  keepOnly(keep: Readonly<Record<string, unknown>>): void;
  forget(id: string): void;
  prune(known: Readonly<Record<string, unknown>>): void;
  liveMeta(topicId?: string): CacheMeta | null;
  keepScreen(topicId?: string): void;
  scheduleSave(topicId?: string): void;
  leave(topicId?: string): void;
}

interface StoredCopy extends CacheCopy {
  readonly topic: string;
  readonly at: number;
}

interface TxResult<T> {
  readonly ok: boolean;
  readonly value?: T;
  readonly error?: unknown;
}

const DEFAULT_SAVE_MS = 400;
const DEFAULT_COPY_TOPICS = 8;
const DEFAULT_COPY_MSGS = 4000;

function defaultIndexedDB(): IDBFactory | undefined {
  return typeof window !== 'undefined' ? window.indexedDB : undefined;
}

function defaultWarn(msg: string, detail: unknown): void {
  try {
    console.warn(msg, detail);
  } catch {
    // Ignore console failures in restricted environments.
  }
}

function errorDetail(why: unknown): unknown {
  if (why && typeof why === 'object' && 'message' in why) {
    const msg = (why as { readonly message?: unknown }).message;
    if (msg) return msg;
  }
  return why || 'unavailable';
}

export function collectCacheableMessages(
  logEl: ParentNode | null,
  dataByKey: Readonly<Record<string, CacheMessage | undefined>>,
): CacheMessage[] {
  if (!logEl) return [];
  const out: CacheMessage[] = [];
  for (let n: ChildNode | null = logEl.firstChild; n; n = n.nextSibling) {
    const el = n as Partial<Element>;
    const key = typeof el.getAttribute === 'function' ? el.getAttribute('data-k') : null;
    const msg = key ? dataByKey[key] : undefined;
    if (!msg || msg._local) continue;
    out.push(msg);
  }
  return out;
}

class CacheServiceImpl implements CacheService {
  private readonly _deps: CacheServiceDeps;
  private readonly _getIndexedDB: () => IDBFactory | undefined | null;
  private readonly _saveMs: number;
  private readonly _copyTopics: number;
  private readonly _copyMsgs: number;
  private readonly _warn: (msg: string, detail: unknown) => void;

  private _db: IDBDatabase | null = null;
  private _dbOff = false;
  private readonly _saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly _copies: Record<string, StoredCopy> = {};
  private readonly _vers: Record<string, CacheVersion> = {};
  private _copySeq = 0;

  constructor(deps: CacheServiceDeps) {
    this._deps = deps;
    this._getIndexedDB = deps.getIndexedDB ?? defaultIndexedDB;
    this._saveMs = deps.saveMs ?? DEFAULT_SAVE_MS;
    this._copyTopics = deps.copyTopics ?? DEFAULT_COPY_TOPICS;
    this._copyMsgs = deps.copyMsgs ?? DEFAULT_COPY_MSGS;
    this._warn = deps.warn ?? defaultWarn;
  }

  private _cacheOff(why: unknown): void {
    if (this._dbOff) return;
    this._dbOff = true;
    this._db = null;
    this._warn('[webui] local transcript cache disabled:', errorDetail(why));
  }

  isDbAvailable(): boolean {
    return !this._dbOff && Boolean(this._getIndexedDB());
  }

  private _idb(): Promise<IDBDatabase | null> {
    if (this._db) return Promise.resolve(this._db);
    if (!this.isDbAvailable()) return Promise.resolve(null);
    const factory = this._getIndexedDB();
    if (!factory) return Promise.resolve(null);
    return this._deps.core.cacheOpen(factory).then((r) => {
      if (r.db) {
        this._db = r.db;
        return this._db;
      }
      this._cacheOff(r.error);
      return null;
    });
  }

  private _tx<T>(
    mode: IDBTransactionMode,
    body: (store: IDBObjectStore) => IDBRequest<T> | null,
  ): Promise<TxResult<T | null>> {
    return this._idb().then((d) => {
      if (!d) return { ok: false };
      return new Promise<TxResult<T | null>>((resolve) => {
        let tx: IDBTransaction;
        let out: T | null = null;
        try {
          tx = d.transaction(this._deps.core.STORE, mode);
        } catch (err) {
          this._cacheOff(err);
          resolve({ ok: false });
          return;
        }
        const rq = body(tx.objectStore(this._deps.core.STORE));
        if (rq) {
          rq.onsuccess = () => {
            out = rq.result;
          };
        }
        tx.oncomplete = () => resolve({ ok: true, value: out });
        tx.onabort = () => resolve({ ok: false, error: tx.error });
        tx.onerror = () => resolve({ ok: false, error: tx.error });
      });
    });
  }

  getVersion(id: string): CacheVersion | undefined {
    return this._vers[id];
  }

  setVersion(id: string, version: CacheVersion): void {
    this._vers[id] = { last: version.last, epoch: version.epoch };
  }

  noteVersion(id: string, last: string | undefined, epoch: number | undefined): void {
    const v = this._vers[id];
    if (!v || this._deps.core.newer(last, v.last, epoch, v.epoch)) {
      this._vers[id] = { last: last || '', epoch: epoch || 0 };
    }
  }

  isNewer(
    a: string | undefined,
    b: string | undefined,
    aEpoch?: number,
    bEpoch?: number,
  ): boolean {
    return this._deps.core.newer(a, b, aEpoch, bEpoch);
  }

  private _trimCopies(): void {
    const ids = Object.keys(this._copies).sort((a, b) => {
      const ca = this._copies[a];
      const cb = this._copies[b];
      return (cb?.at ?? 0) - (ca?.at ?? 0);
    });
    let total = 0;
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      if (!id) continue;
      const entry = this._copies[id];
      if (!entry) continue;
      total += entry.msgs.length;
      if (i < this._copyTopics && (i === 0 || total <= this._copyMsgs)) continue;
      delete this._copies[id];
      if (!this.isDbAvailable()) delete this._vers[id];
    }
  }

  memCopy(id: string): CacheCopy | null {
    const m = this._copies[id];
    const v = this._vers[id];
    if (!m) return null;
    return !(v && this._deps.core.newer(v.last, m.last, v.epoch, m.epoch)) ? m : null;
  }

  put(id: string, msgs: readonly CacheMessage[], meta: CacheMeta): Promise<boolean> {
    const copy: StoredCopy = {
      topic: id,
      msgs,
      epoch: meta.epoch,
      last: meta.last || '',
      stale: Boolean(meta.stale),
      at: ++this._copySeq,
    };
    const existing = this._copies[id];
    if (!existing || !this._deps.core.newer(existing.last, copy.last, existing.epoch, copy.epoch)) {
      this._copies[id] = copy;
      this._trimCopies();
    }
    this.noteVersion(id, copy.last, copy.epoch);
    return this.isDbAvailable() ? this._write(id, msgs, meta, false) : Promise.resolve(false);
  }

  get(id: string): Promise<CacheCopy | null> {
    const m = this.memCopy(id);
    if (m || !this.isDbAvailable()) return Promise.resolve(m || this._copies[id] || null);
    return this._read(id).then((r) => {
      const o = this._copies[id];
      if (o && (!r || this._deps.core.newer(o.last, r.last, o.epoch, r.epoch))) return o;
      return r;
    });
  }

  private _write(
    tId: string,
    msgs: readonly CacheMessage[],
    meta: CacheMeta,
    retried: boolean,
  ): Promise<boolean> {
    const rec = this._deps.core.cacheRecord(tId, msgs, meta);
    let written: CachePutResult | null = null;
    return this._tx<unknown>('readwrite', (store) => {
      written = this._deps.core.cachePut(store, rec);
      return null;
    }).then((r) => {
      if (r.ok) {
        if (written?.stood) {
          this.noteVersion(tId, written.stood.last, written.stood.epoch);
        }
        return true;
      }
      if (this._dbOff) return false;
      if (retried) {
        this._cacheOff(r.error || 'the write was refused twice');
        return false;
      }
      return this._tx<unknown>('readwrite', (store) => {
        this._deps.core.cacheEvict(store, tId, true);
        return null;
      }).then(() => this._write(tId, msgs, meta, true));
    });
  }

  private _read(tId: string): Promise<CacheCopy | null> {
    return this._tx<CacheStoredRecord | undefined>('readonly', (store) => store.get(tId)).then(
      (r) => {
        const v = r.ok ? r.value : null;
        let list: unknown = null;
        if (v && v.json) {
          try {
            list = JSON.parse(v.json);
          } catch {
            list = null;
          }
        }
        if (!v || !Array.isArray(list)) {
          if (r.ok) this.noteVersion(tId, '', 0);
          return null;
        }
        this.noteVersion(tId, v.last, v.epoch);
        return {
          msgs: list as CacheMessage[],
          epoch: v.epoch || 0,
          last: v.last || '',
          stale: Boolean(v.stale),
        };
      },
    );
  }

  peek(tId: string): Promise<void> {
    return this._tx<CacheStoredRecord | undefined>('readonly', (store) => store.get(tId)).then(
      (r) => {
        const v = r.ok && r.value && r.value.json ? r.value : null;
        this.noteVersion(tId, v ? v.last : '', v ? v.epoch : 0);
      },
    );
  }

  drop(tId: string): void {
    void this._tx<unknown>('readwrite', (store) => {
      store.delete(tId);
      return null;
    });
  }

  keepOnly(keep: Readonly<Record<string, unknown>>): void {
    void this._tx<unknown>('readwrite', (store) => {
      const cur = store.index('at').openKeyCursor();
      cur.onsuccess = () => {
        const at = cur.result;
        if (!at) return;
        const key = String(at.primaryKey);
        if (!keep[key]) store.delete(at.primaryKey);
        at.continue();
      };
      return null;
    });
    for (const id of Object.keys(this._copies)) {
      if (!keep[id]) delete this._copies[id];
    }
    for (const id of Object.keys(this._vers)) {
      if (!keep[id]) delete this._vers[id];
    }
  }

  forget(id: string): void {
    delete this._copies[id];
    delete this._vers[id];
  }

  prune(known: Readonly<Record<string, unknown>>): void {
    for (const id of Object.keys(this._copies)) {
      if (!known[id]) delete this._copies[id];
    }
    for (const id of Object.keys(this._vers)) {
      if (!known[id]) delete this._vers[id];
    }
  }

  liveMeta(topicId?: string): CacheMeta | null {
    const topic = topicId ?? this._deps.getTopic();
    const epoch = this._deps.getEpoch();
    const state = topic && this._deps.getTopicState ? this._deps.getTopicState(topic) : null;
    const lastEv = state ? state.lastEventId : this._deps.getLastEventId();
    const synced = state ? state.synced : this._deps.isSynced();
    const stale = state ? state.stale : this._deps.isStale();
    const last = lastEv && topic && lastEv.startsWith(`${topic}.`) ? lastEv : '';
    return topic && epoch && (synced || last) ? { epoch, stale, last } : null;
  }

  keepScreen(topicId?: string): void {
    const topic = topicId ?? this._deps.getTopic();
    if (!topic) return;
    const meta = this.liveMeta(topic);
    if (meta) {
      const state = this._deps.getTopicState?.(topic);
      const msgs = state ? state.collectMessages() : this._deps.collectScreenMessages();
      void this.put(topic, msgs, meta);
    }
  }

  scheduleSave(topicId?: string): void {
    const topic = topicId ?? this._deps.getTopic();
    if (!topic || this._saveTimers.has(topic)) return;
    const timer = setTimeout(() => {
      this._saveTimers.delete(topic);
      this.keepScreen(topic);
    }, this._saveMs);
    this._saveTimers.set(topic, timer);
  }

  leave(topicId?: string): void {
    if (topicId) {
      const timer = this._saveTimers.get(topicId);
      if (timer !== undefined) {
        clearTimeout(timer);
        this._saveTimers.delete(topicId);
      }
      this.keepScreen(topicId);
      return;
    }
    for (const timer of this._saveTimers.values()) clearTimeout(timer);
    this._saveTimers.clear();
    const topics = this._deps.getOpenTopics
      ? [...new Set(this._deps.getOpenTopics().filter(Boolean))]
      : [this._deps.getTopic()].filter(Boolean);
    for (const id of topics) this.keepScreen(id);
  }

  dispose(): void {
    for (const timer of this._saveTimers.values()) clearTimeout(timer);
    this._saveTimers.clear();
  }
}

export function createCacheService(deps: CacheServiceDeps): CacheService {
  return new CacheServiceImpl(deps);
}
