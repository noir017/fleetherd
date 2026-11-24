import type {
  CacheMessage,
  CacheMeta,
  CacheOpenResult,
  CachePutResult,
  CacheStoredRecord,
} from './services/cache.js';
import type { TopicSnapshotPayload } from './features/topics/types.js';

export interface ClientIconMap extends Record<string, string> {
  readonly more: string;
  readonly star: string;
  readonly chevronRight: string;
  readonly chevronDown: string;
  readonly fork: string;
  readonly offline: string;
  readonly search: string;
  readonly cross: string;
  readonly filter: string;
  readonly sort: string;
  readonly arrowUp: string;
  readonly arrowDown: string;
  readonly copy: string;
  readonly power: string;
  readonly trash: string;
  readonly pause: string;
  readonly play: string;
  readonly clock: string;
  readonly pencil: string;
  readonly bolt: string;
  readonly undo: string;
  readonly check: string;
  readonly mic: string;
  readonly stop: string;
}

export interface ClientIconsBundle {
  readonly icon: ClientIconMap;
  readonly mark: Record<string, string>;
  readonly reaction: Record<string, string>;
}

declare global {
  // Replaced at build time by scripts/webui-client.mjs with clientIcons() and CACHE_CORE.
  const __FH_ICONS__: ClientIconsBundle;
  const __FH_CACHE_CORE__: void;
  const STORE: string;
  function cacheOpen(factory: IDBFactory): Promise<CacheOpenResult>;
  function newer(
    a: string | undefined,
    b: string | undefined,
    aEpoch?: number,
    bEpoch?: number,
  ): boolean;
  function cacheRecord(
    tId: string,
    msgs: readonly CacheMessage[],
    meta: CacheMeta,
  ): CacheStoredRecord;
  function cachePut(store: IDBObjectStore, rec: CacheStoredRecord): CachePutResult;
  function cacheEvict(store: IDBObjectStore, keep: string, all: boolean): void;
  function snapshotMsgs(d: TopicSnapshotPayload): CacheMessage[];
}
