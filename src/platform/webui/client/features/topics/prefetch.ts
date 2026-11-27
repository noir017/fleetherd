import type { Disposable } from '../../base/lifecycle.js';
import type { CacheMessage, CacheMeta, CacheVersion } from '../../services/cache.js';
import { NEEDS_ORDER } from './tree.js';
import type { Topic, TopicSnapshotPayload } from './types.js';

export const PRE_TOPICS = 20;
export const PRE_PARALLEL = 3;
export const PRE_DEBOUNCE_MS = 400;
export const PRE_RETRY_MS = 60000;
export const PRE_TIMEOUT_MS = 60000;

export function isRowCurrent(
  row: Pick<Topic, 'last'> | null | undefined,
  last: string | undefined,
  isNewer: (a: string | undefined, b: string | undefined) => boolean,
): boolean {
  return Boolean(row && row.last && last) && !isNewer(row?.last, last);
}

export interface TopicPrefetchDeps {
  readonly doc?: Document;
  readonly isDbAvailable: () => boolean;
  readonly isStreamParked: () => boolean;
  readonly isStreamOpen: () => boolean;
  readonly getEpoch: () => number;
  readonly getActiveTopic: () => string;
  readonly getTopics: () => readonly Topic[];
  readonly topicById: (id: string) => Topic | null;
  readonly getVersion: (id: string) => CacheVersion | undefined;
  readonly isNewer: (a: string | undefined, b: string | undefined) => boolean;
  readonly peekCache: (id: string) => Promise<unknown>;
  readonly putCache: (id: string, msgs: readonly CacheMessage[], meta: CacheMeta) => Promise<boolean>;
  readonly snapshotMsgs: (d: TopicSnapshotPayload) => CacheMessage[];
  readonly fetchFn?: typeof fetch;
  readonly now?: () => number;
}

export interface TopicPrefetcher extends Disposable {
  schedule(): void;
  pump(): void;
  clearTried(): void;
  forget(id: string): void;
  prune(known: Readonly<Record<string, unknown>>): void;
  isRowCurrent(row: Pick<Topic, 'last'> | null | undefined, last: string | undefined): boolean;
}

interface TriedEntry {
  readonly last: string;
  readonly at: number;
  readonly ok: boolean;
}

export function createTopicPrefetcher(deps: TopicPrefetchDeps): TopicPrefetcher {
  const doc = deps.doc ?? document;
  const nowFn = deps.now ?? (() => Date.now());
  const fetchFn = deps.fetchFn ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));

  let preTimer: ReturnType<typeof setTimeout> | null = null;
  const preBusy: Record<string, boolean> = {};
  let preCount = 0;
  let preTried: Record<string, TriedEntry> = {};

  function currentCheck(row: Pick<Topic, 'last'> | null | undefined, last: string | undefined): boolean {
    return isRowCurrent(row, last, deps.isNewer);
  }

  function prefetchWanted(): Topic[] {
    if (
      !deps.isDbAvailable() ||
      doc.visibilityState === 'hidden' ||
      deps.isStreamParked() ||
      !deps.getEpoch() ||
      !deps.isStreamOpen()
    ) {
      return [];
    }
    const activeTopic = deps.getActiveTopic();
    const rows = deps
      .getTopics()
      .filter((t) => t.id !== activeTopic && Boolean(t.stage && NEEDS_ORDER[t.stage] !== undefined));
    rows.sort((a, b) => {
      const oa = a.stage ? (NEEDS_ORDER[a.stage] ?? 99) : 99;
      const ob = b.stage ? (NEEDS_ORDER[b.stage] ?? 99) : 99;
      return oa - ob || (b.lastAt || 0) - (a.lastAt || 0);
    });
    const now = nowFn();
    return rows.slice(0, PRE_TOPICS).filter((t) => {
      const v = deps.getVersion(t.id);
      const tried = preTried[t.id];
      if (!t.last || preBusy[t.id] || currentCheck(t, v?.last)) return false;
      return !(tried && tried.last === t.last && (tried.ok || now - tried.at < PRE_RETRY_MS));
    });
  }

  function takePrefetched(t: Topic, d: TopicSnapshotPayload | null): boolean | Promise<boolean> {
    if (!d || d.topic !== t.id) return false;
    if (t.id === deps.getActiveTopic() || !deps.topicById(t.id)) return true;
    const epoch = deps.getEpoch();
    if (!epoch || d.epoch !== epoch) return false;
    return deps.putCache(t.id, deps.snapshotMsgs(d), {
      epoch: d.epoch,
      last: d.last,
      stale: Boolean(d.stale),
      ...(d.hasMore ? { hasMore: true } : {}),
      ...(d.oldestSeq ? { oldestSeq: d.oldestSeq } : {}),
    });
  }

  function prefetchOne(t: Topic): void {
    let done = false;
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    preBusy[t.id] = true;
    preCount++;

    const finish = (ok: boolean): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      delete preBusy[t.id];
      preCount--;
      preTried[t.id] = { last: t.last ?? '', at: nowFn(), ok };
      pump();
    };

    const timer = setTimeout(() => {
      if (ctl) {
        try {
          ctl.abort();
        } catch {
          // Ignore abort errors.
        }
      }
      finish(false);
    }, PRE_TIMEOUT_MS);

    const ready = deps.getVersion(t.id) === undefined ? deps.peekCache(t.id) : Promise.resolve();
    void ready.then(() => {
      if (done) return;
      const v = deps.getVersion(t.id);
      if (t.id === deps.getActiveTopic() || currentCheck(t, v?.last)) {
        finish(true);
        return;
      }
      void fetchFn(`api/topic?t=${encodeURIComponent(t.id)}`, {
        credentials: 'same-origin',
        cache: 'no-store',
        signal: ctl ? ctl.signal : undefined,
      })
        .then((r) => (r.ok ? (r.json() as Promise<TopicSnapshotPayload>) : null))
        .then((d) => takePrefetched(t, d))
        .then(finish, () => finish(false));
    });
  }

  function pump(): void {
    preTimer = null;
    const want = prefetchWanted();
    for (let i = 0; i < want.length && preCount < PRE_PARALLEL; i++) {
      const target = want[i];
      if (target) prefetchOne(target);
    }
  }

  function schedule(): void {
    if (preTimer !== null) return;
    preTimer = setTimeout(pump, PRE_DEBOUNCE_MS);
  }

  function dispose(): void {
    if (preTimer !== null) {
      clearTimeout(preTimer);
      preTimer = null;
    }
  }

  return {
    schedule,
    pump,
    clearTried: () => {
      preTried = {};
    },
    forget: (id) => {
      delete preTried[id];
    },
    prune: (known) => {
      for (const id of Object.keys(preTried)) {
        if (!known[id]) delete preTried[id];
      }
    },
    isRowCurrent: currentCheck,
    dispose,
  };
}
