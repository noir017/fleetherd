import type { Disposable } from '../../base/lifecycle.js';
import type { CacheCopy, CacheMessage, CacheMeta, CacheVersion } from '../../services/cache.js';
import { NEEDS_ORDER } from './tree.js';
import type { Topic, TopicSnapshotPayload } from './types.js';

export const PRE_TOPICS = 20;
/**
 * Beyond the topics that need a person, this many of the most recently active ones (within
 * `PRE_RECENT_MS`) are kept current too, so tapping one that just finished paints its last turn at
 * once. Each costs one `?since=` fetch per turn it finishes while the page is open.
 */
export const PRE_RECENT = 6;
export const PRE_RECENT_MS = 2 * 60 * 60 * 1000;
export const PRE_PARALLEL = 3;
export const PRE_DEBOUNCE_MS = 400;
/**
 * A row whose `last` moved is fetched once it has stood still this long: a turn ends in a burst
 * (the reply's last edit, typing off, the ✅ reaction), and one fetch should cover all of it.
 */
export const PRE_SETTLE_MS = 2000;
export const PRE_RETRY_MS = 60000;
export const PRE_TIMEOUT_MS = 60000;

export function isRowCurrent(
  row: Pick<Topic, 'last'> | null | undefined,
  last: string | undefined,
  isNewer: (a: string | undefined, b: string | undefined) => boolean,
): boolean {
  return Boolean(row && row.last && last) && !isNewer(row?.last, last);
}

function isNeeds(t: Topic): boolean {
  return Boolean(t.stage && NEEDS_ORDER[t.stage] !== undefined);
}

/**
 * A cached copy with a `?since=` answer applied: changed messages replaced in place or appended,
 * removed ones dropped. Keyed by run and id the way the transcript keys them (`_g`), so a message
 * kept from an earlier run is never taken for a new one with the same id. A changed message older
 * than the copy reaches (`oldestSeq`) is left out: paging reads it as it is now.
 */
export function mergeTopicDelta(
  msgs: readonly CacheMessage[],
  d: TopicSnapshotPayload,
  oldestSeq?: number,
): CacheMessage[] {
  const epoch = d.epoch || 0;
  const out: Array<CacheMessage | null> = msgs.slice();
  const at = new Map<string, number>();
  out.forEach((m, i) => {
    if (m && m.id) at.set(`${m._g || epoch}:${m.id}`, i);
  });
  for (const id of d.gone || []) {
    const i = at.get(`${epoch}:${id}`);
    if (i !== undefined) out[i] = null;
  }
  const list = d.messages || [];
  list.forEach((raw, j) => {
    const m = raw as CacheMessage | null;
    if (!m || !m.id) return;
    const g = typeof m.g === 'number' && m.g ? m.g : epoch;
    const key = `${g}:${m.id}`;
    const i = at.get(key);
    // A message that became a settings page is not a transcript row (`snapshotMsgs`).
    if (m.settings || m.wasSettings) {
      if (i !== undefined) out[i] = null;
      return;
    }
    const next: CacheMessage = { ...m, _g: g };
    if (i !== undefined) {
      out[i] = next;
      return;
    }
    const seq = d.seqs ? d.seqs[j] : undefined;
    if (oldestSeq && seq !== undefined && seq < oldestSeq) return;
    at.set(key, out.length);
    out.push(next);
  });
  return out.filter((m): m is CacheMessage => m !== null);
}

export interface TopicPrefetchDeps {
  readonly doc?: Document;
  readonly isDbAvailable: () => boolean;
  readonly isStreamParked: () => boolean;
  readonly isStreamOpen: () => boolean;
  readonly getEpoch: () => number;
  readonly getActiveTopic: () => string;
  /** Topics the stream is attached to already (other panels): it keeps those current itself. */
  readonly isOpen?: (id: string) => boolean;
  readonly getTopics: () => readonly Topic[];
  readonly topicById: (id: string) => Topic | null;
  readonly getVersion: (id: string) => CacheVersion | undefined;
  readonly isNewer: (a: string | undefined, b: string | undefined) => boolean;
  readonly peekCache: (id: string) => Promise<unknown>;
  /** The cached copy a `?since=` answer is merged into. Without it every fetch is a whole snapshot. */
  readonly getCache?: (id: string) => Promise<CacheCopy | null>;
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

interface MovedEntry {
  readonly last: string;
  readonly at: number;
}

/** How long until a row's `last` has stood still for `PRE_SETTLE_MS`, recording it when it moved. */
function settleLeft(moved: Record<string, MovedEntry>, t: Topic, now: number): number {
  const last = t.last ?? '';
  const m = moved[t.id];
  if (!m) {
    moved[t.id] = { last, at: 0 };
    return 0;
  }
  if (m.last !== last) {
    moved[t.id] = { last, at: now };
    return PRE_SETTLE_MS;
  }
  return Math.max(0, m.at + PRE_SETTLE_MS - now);
}

/** Needs-you first, as before; then the most recent topics. Never one the stream already carries. */
function candidates(deps: TopicPrefetchDeps, now: number): Topic[] {
  const activeTopic = deps.getActiveTopic();
  const shown = (t: Topic): boolean => t.id === activeTopic || Boolean(deps.isOpen?.(t.id));
  const all = deps.getTopics();
  const needs = all.filter((t) => !shown(t) && isNeeds(t));
  needs.sort((a, b) => {
    const oa = a.stage ? (NEEDS_ORDER[a.stage] ?? 99) : 99;
    const ob = b.stage ? (NEEDS_ORDER[b.stage] ?? 99) : 99;
    return oa - ob || (b.lastAt || 0) - (a.lastAt || 0);
  });
  const recent = all.filter(
    (t) => !shown(t) && !isNeeds(t) && !t.scheduled && (t.lastAt || 0) >= now - PRE_RECENT_MS,
  );
  recent.sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
  return [...needs.slice(0, PRE_TOPICS), ...recent.slice(0, PRE_RECENT)];
}

type LoadFn = (t: Topic, since: string, signal: AbortSignal | undefined) => Promise<boolean>;

/** One topic into the cache: a delta merged into the copy when `since` is given, else the snapshot. */
function createSnapshotLoader(deps: TopicPrefetchDeps, fetchFn: typeof fetch): LoadFn {
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

  /** Merge a `?since=` answer into the cached copy; null when that copy cannot take it. */
  function takeDelta(t: Topic, d: TopicSnapshotPayload, since: string): Promise<boolean | null> {
    if (d.topic !== t.id) return Promise.resolve(false);
    if (t.id === deps.getActiveTopic() || !deps.topicById(t.id)) return Promise.resolve(true);
    const epoch = deps.getEpoch();
    if (!epoch || d.epoch !== epoch || !deps.getCache) return Promise.resolve(false);
    return deps.getCache(t.id).then((c) => {
      // The answer starts at `since`: a copy from before it would keep a hole.
      if (!c || c.epoch !== epoch || !c.last || deps.isNewer(since, c.last)) return null;
      if (!deps.isNewer(d.last, c.last)) return true;
      const oldestSeq = c.hasMore ? c.oldestSeq : undefined;
      return deps.putCache(t.id, mergeTopicDelta(c.msgs, d, oldestSeq), {
        epoch,
        last: d.last,
        stale: Boolean(d.stale),
        ...(c.hasMore ? { hasMore: true } : {}),
        ...(c.oldestSeq ? { oldestSeq: c.oldestSeq } : {}),
      });
    });
  }

  function load(t: Topic, since: string, signal: AbortSignal | undefined): Promise<boolean> {
    const q = since ? `&since=${encodeURIComponent(since)}` : '';
    return fetchFn(`api/topic?t=${encodeURIComponent(t.id)}${q}`, {
      credentials: 'same-origin',
      cache: 'no-store',
      signal,
    })
      .then((r) => (r.ok ? (r.json() as Promise<TopicSnapshotPayload>) : null))
      .then((d) => {
        if (!d || !d.delta || !since) return takePrefetched(t, d);
        return takeDelta(t, d, since).then((ok) => (ok === null ? load(t, '', signal) : ok));
      });
  }

  return load;
}

export function createTopicPrefetcher(deps: TopicPrefetchDeps): TopicPrefetcher {
  const doc = deps.doc ?? document;
  const nowFn = deps.now ?? (() => Date.now());
  const load = createSnapshotLoader(
    deps,
    deps.fetchFn ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init)),
  );

  let preTimer: ReturnType<typeof setTimeout> | null = null;
  let settleTimer: ReturnType<typeof setTimeout> | null = null;
  const preBusy: Record<string, boolean> = {};
  let preCount = 0;
  let preTried: Record<string, TriedEntry> = {};
  // When each row's `last` was last seen to move. A row first seen here has stood still as far as
  // this page knows (at 0), so a page that opens onto finished topics fetches them at once.
  let moved: Record<string, MovedEntry> = {};

  function currentCheck(row: Pick<Topic, 'last'> | null | undefined, last: string | undefined): boolean {
    return isRowCurrent(row, last, deps.isNewer);
  }

  function armSettle(ms: number): void {
    if (settleTimer !== null) return;
    settleTimer = setTimeout(() => {
      settleTimer = null;
      pump();
    }, ms);
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
    const now = nowFn();
    let wait = Infinity;
    const out = candidates(deps, now).filter((t) => {
      const left = settleLeft(moved, t, now);
      // A recent topic mid-turn is fetched when the turn is over; one waiting on a person is not.
      if (t.running && !isNeeds(t)) return false;
      const v = deps.getVersion(t.id);
      const tried = preTried[t.id];
      if (!t.last || preBusy[t.id] || currentCheck(t, v?.last)) return false;
      if (tried && tried.last === t.last && (tried.ok || now - tried.at < PRE_RETRY_MS)) return false;
      if (left > 0) {
        wait = Math.min(wait, left);
        return false;
      }
      return true;
    });
    if (wait !== Infinity) armSettle(wait);
    return out;
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
      // Same run and a resumable copy: ask only for what changed after it.
      const since = deps.getCache && v && v.last && v.epoch === deps.getEpoch() ? v.last : '';
      void load(t, since, ctl ? ctl.signal : undefined).then(finish, () => finish(false));
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
    if (settleTimer !== null) {
      clearTimeout(settleTimer);
      settleTimer = null;
    }
  }

  return {
    schedule,
    pump,
    clearTried: () => {
      preTried = {};
      moved = {};
    },
    forget: (id) => {
      delete preTried[id];
      delete moved[id];
    },
    prune: (known) => {
      for (const id of Object.keys(preTried)) {
        if (!known[id]) delete preTried[id];
      }
      for (const id of Object.keys(moved)) {
        if (!known[id]) delete moved[id];
      }
    },
    isRowCurrent: currentCheck,
    dispose,
  };
}
