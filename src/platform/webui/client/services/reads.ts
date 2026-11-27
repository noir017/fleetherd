import { addDisposableListener } from '../base/dom.js';
import { type Disposable, DisposableStore } from '../base/lifecycle.js';
import { t as tr } from '../i18n/index.js';
import { post } from './api.js';
import { StorageService } from './storage.js';

export interface ReadTopicLike {
  readonly id: string;
  readonly msgCount?: number;
  readonly stage?: string;
  readonly parent?: string | null;
}

export interface ReadsServiceDeps {
  readonly storage?: StorageService;
  readonly storageKey?: string;
  readonly getActiveTopic: () => string;
  readonly getVisibleTopics?: () => readonly string[];
  readonly getTopics: () => readonly ReadTopicLike[];
  readonly isOverlayBlocking?: () => boolean;
  readonly postSeen?: (topicId: string) => Promise<{ readonly ok: boolean }>;
  readonly onChanged?: () => void;
  readonly formatMarkFailed?: (failed: number, noun: string) => string;
  readonly seenThrottleMs?: number;
  readonly now?: () => number;
}

export interface ReadsService extends Disposable {
  getCount(topicId: string): number | undefined;
  getAll(): Readonly<Record<string, number>>;
  setCount(topicId: string, count: number): void;
  increment(topicId: string, delta?: number): number;
  remove(topicId: string): void;
  keepOnly(keep: Readonly<Record<string, unknown>>): void;
  merge(incoming: Readonly<Record<string, number>>): boolean;
  syncTopics(topics: readonly ReadTopicLike[], activeTopicId: string): void;
  markTopicFromList(topicId: string, topics: readonly ReadTopicLike[]): void;
  unreadOf(topic: ReadTopicLike): number;
  unseenReply(topic: ReadTopicLike): boolean;
  needsRead(topic: ReadTopicLike): boolean;
  markAllRead(
    list: readonly ReadTopicLike[],
    noun: string,
    say: (msg: string) => void,
  ): Promise<number>;
  reportSeen(): void;
  attachWindowEvents(doc?: Document, win?: Window): Disposable;
}

const DEFAULT_STORAGE_KEY = 'aa_reads';
const DEFAULT_SEEN_THROTTLE_MS = 2000;

function parseReadMap(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, number> = {};
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof val === 'number' && Number.isFinite(val) && val >= 0) {
      out[key] = val;
    }
  }
  return out;
}

function defaultFormatMarkFailed(failed: number, noun: string): string {
  return tr(failed === 1 ? 'topic.markReadFailedOne' : 'topic.markReadFailedMany', {
    count: failed,
    noun,
  });
}

function defaultPostSeen(topicId: string): Promise<{ readonly ok: boolean }> {
  return post('api/seen', { topic: topicId }, 0);
}

class ReadsServiceImpl implements ReadsService {
  private readonly _deps: ReadsServiceDeps;
  private readonly _storage: StorageService;
  private readonly _storageKey: string;
  private readonly _postSeen: (topicId: string) => Promise<{ readonly ok: boolean }>;
  private readonly _formatMarkFailed: (failed: number, noun: string) => string;
  private readonly _seenThrottleMs: number;
  private readonly _now: () => number;
  private readonly _disposables = new DisposableStore();

  private _counts: Record<string, number>;
  private readonly _seenPosted: Record<string, number> = {};
  private _docRef: Document | undefined = typeof document !== 'undefined' ? document : undefined;

  constructor(deps: ReadsServiceDeps) {
    this._deps = deps;
    this._storage = deps.storage ?? new StorageService();
    this._storageKey = deps.storageKey ?? DEFAULT_STORAGE_KEY;
    this._postSeen = deps.postSeen ?? defaultPostSeen;
    this._formatMarkFailed = deps.formatMarkFailed ?? defaultFormatMarkFailed;
    this._seenThrottleMs = deps.seenThrottleMs ?? DEFAULT_SEEN_THROTTLE_MS;
    this._now = deps.now ?? (() => Date.now());
    this._counts = parseReadMap(this._storage.getJson<unknown>(this._storageKey));
  }

  private _save(): void {
    this._storage.setJson(this._storageKey, this._counts);
  }

  private _visibleTopicIds(): string[] {
    if (this._deps.getVisibleTopics) {
      const list = [...new Set(this._deps.getVisibleTopics().filter(Boolean))];
      if (list.length > 0) return list;
    }
    const active = this._deps.getActiveTopic();
    return active ? [active] : [];
  }

  private _isVisible(topicId: string): boolean {
    return this._visibleTopicIds().includes(topicId);
  }

  getCount(topicId: string): number | undefined {
    return this._counts[topicId];
  }

  getAll(): Readonly<Record<string, number>> {
    return { ...this._counts };
  }

  setCount(topicId: string, count: number): void {
    this._counts[topicId] = count;
    this._save();
  }

  increment(topicId: string, delta = 1): number {
    const next = (this._counts[topicId] || 0) + delta;
    this._counts[topicId] = next;
    this._save();
    return next;
  }

  remove(topicId: string): void {
    delete this._counts[topicId];
    this._save();
  }

  keepOnly(keep: Readonly<Record<string, unknown>>): void {
    for (const id of Object.keys(this._counts)) {
      if (!keep[id]) delete this._counts[id];
    }
    this._save();
  }

  merge(incoming: Readonly<Record<string, number>>): boolean {
    let changed = false;
    for (const [id, val] of Object.entries(incoming)) {
      if (typeof val !== 'number' || !Number.isFinite(val) || val < 0) continue;
      const prev = this._counts[id];
      if (prev === undefined || val > prev) {
        this._counts[id] = val;
        changed = true;
      }
    }
    if (changed) this._save();
    return changed;
  }

  syncTopics(topics: readonly ReadTopicLike[], activeTopicId: string): void {
    let wrote = false;
    const visible = new Set(this._visibleTopicIds());
    if (activeTopicId) visible.add(activeTopicId);
    for (let i = 0; i < topics.length; i++) {
      const seed = topics[i];
      if (!seed) continue;
      const count = seed.msgCount || 0;
      if (this._counts[seed.id] === undefined) {
        this._counts[seed.id] = count;
        wrote = true;
      }
      if (visible.has(seed.id) && this._counts[seed.id] !== count) {
        this._counts[seed.id] = count;
        wrote = true;
      }
    }
    if (wrote) this._save();
  }

  markTopicFromList(topicId: string, topics: readonly ReadTopicLike[]): void {
    for (let i = 0; i < topics.length; i++) {
      const row = topics[i];
      if (row && row.id === topicId) {
        this.setCount(topicId, row.msgCount || 0);
        return;
      }
    }
  }

  unreadOf(topic: ReadTopicLike): number {
    const count = topic.msgCount || 0;
    return this._isVisible(topic.id)
      ? 0
      : Math.max(0, count - (this._counts[topic.id] || 0));
  }

  unseenReply(topic: ReadTopicLike): boolean {
    return (topic.stage === 'review' || topic.stage === 'failed') && !topic.parent;
  }

  needsRead(topic: ReadTopicLike): boolean {
    return (
      !this._isVisible(topic.id) &&
      (this.unreadOf(topic) > 0 || this.unseenReply(topic))
    );
  }

  markAllRead(
    list: readonly ReadTopicLike[],
    noun: string,
    say: (msg: string) => void,
  ): Promise<number> {
    let wrote = false;
    const queue: string[] = [];
    for (let i = 0; i < list.length; i++) {
      const item = list[i];
      if (!item) continue;
      const count = item.msgCount || 0;
      if ((this._counts[item.id] || 0) !== count) {
        this._counts[item.id] = count;
        wrote = true;
      }
      if (this.unseenReply(item)) queue.push(item.id);
    }
    if (wrote) this._save();
    this._deps.onChanged?.();

    let failed = 0;
    const markOneAt = (n: number): Promise<number> => {
      if (n >= queue.length) {
        if (failed) say(this._formatMarkFailed(failed, noun));
        return Promise.resolve(failed);
      }
      const id = queue[n];
      if (!id) return markOneAt(n + 1);
      return this._postSeen(id)
        .then(
          (r) => {
            if (!r.ok) failed++;
          },
          () => {
            failed++;
          },
        )
        .then(() => markOneAt(n + 1));
    };
    return markOneAt(0);
  }

  reportSeen(): void {
    const visibleIds = this._visibleTopicIds();
    if (visibleIds.length === 0) return;
    if (this._docRef && this._docRef.visibilityState === 'hidden') return;
    if (this._deps.isOverlayBlocking?.()) return;
    const topics = this._deps.getTopics();
    const now = this._now();
    for (const topicId of visibleIds) {
      let cur: ReadTopicLike | null = null;
      for (let i = 0; i < topics.length; i++) {
        const item = topics[i];
        if (item && item.id === topicId) {
          cur = item;
          break;
        }
      }
      if (!cur || (cur.stage !== 'review' && cur.stage !== 'failed')) continue;
      const last = this._seenPosted[topicId];
      if (last !== undefined && now - last < this._seenThrottleMs) continue;
      this._seenPosted[topicId] = now;
      this._postSeen(topicId).catch(() => {});
    }
  }

  attachWindowEvents(doc?: Document, win?: Window): Disposable {
    const targetDoc = doc ?? (typeof document !== 'undefined' ? document : undefined);
    const targetWin = win ?? (typeof window !== 'undefined' ? window : undefined);
    if (targetDoc) this._docRef = targetDoc;
    const store = new DisposableStore();
    if (targetDoc) {
      store.add(addDisposableListener(targetDoc, 'visibilitychange', () => this.reportSeen()));
    }
    if (targetWin) {
      store.add(
        addDisposableListener(targetWin, 'storage', (ev) => {
          const se = ev as StorageEvent;
          if (se.key !== this._storageKey) return;
          if (se.newValue === null) {
            this._counts = {};
            this._deps.onChanged?.();
            return;
          }
          try {
            const parsed = parseReadMap(JSON.parse(se.newValue));
            if (this.merge(parsed)) this._deps.onChanged?.();
          } catch {
            // Ignore malformed cross-tab payloads.
          }
        }),
      );
    }
    this._disposables.add(store);
    return store;
  }

  dispose(): void {
    this._disposables.dispose();
  }
}

export function createReadsService(deps: ReadsServiceDeps): ReadsService {
  return new ReadsServiceImpl(deps);
}
