import { addDisposableListener } from '../base/dom.js';
import { Emitter, type Event } from '../base/event.js';
import { type Disposable, DisposableStore } from '../base/lifecycle.js';

export interface TopicRowLike {
  readonly id: string;
  readonly lastAt?: number;
}

export interface TopicRowsDelta<T extends TopicRowLike = TopicRowLike> {
  readonly rows?: readonly T[];
  readonly gone?: readonly string[];
  readonly order?: readonly string[];
}

export function applyTopicRows<T extends TopicRowLike>(
  topics: readonly T[],
  ev: TopicRowsDelta<T>,
): T[] {
  const gone = new Set<string>(ev.gone ?? []);
  const at = new Map<string, number>();
  let next: T[] = [];

  for (let i = 0; i < topics.length; i++) {
    const row = topics[i];
    if (!row || gone.has(row.id)) continue;
    at.set(row.id, next.length);
    next.push(row);
  }
  const rows = ev.rows ?? [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;
    const existing = at.get(row.id);
    if (existing !== undefined) {
      next[existing] = row;
    } else {
      at.set(row.id, next.length);
      next.push(row);
    }
  }
  if (ev.order) {
    const byId = new Map<string, T>();
    for (const row of next) byId.set(row.id, row);
    const ordered: T[] = [];
    for (const id of ev.order) {
      const found = byId.get(id);
      if (found) ordered.push(found);
    }
    return ordered;
  }
  next = next
    .map((t, n) => ({ t, n }))
    .sort((a, b) => (b.t.lastAt || 0) - (a.t.lastAt || 0) || a.n - b.n)
    .map((x) => x.t);
  return next;
}

export function buildEventsUrl(params: {
  readonly topic?: string;
  readonly last?: string;
  readonly tv?: number;
}): string {
  const qs: string[] = [];
  if (params.topic) qs.push(`t=${encodeURIComponent(params.topic)}`);
  if (params.last) qs.push(`last=${encodeURIComponent(params.last)}`);
  if (params.last && params.tv) qs.push(`tv=${params.tv}`);
  return `api/events${qs.length ? `?${qs.join('&')}` : ''}`;
}

export interface EventSourceLike {
  readonly readyState: number;
  onmessage: ((ev: MessageEvent) => void) | null;
  onopen: ((ev: globalThis.Event) => void) | null;
  onerror: ((ev: globalThis.Event) => void) | null;
  addEventListener?(type: string, listener: EventListener): void;
  close(): void;
}

export interface StreamEventPayload {
  readonly t: string;
  readonly [key: string]: unknown;
}

export interface StreamClientDeps {
  readonly getTopic: () => string;
  readonly isLoggedOut: () => boolean;
  readonly getBuild: () => string;
  readonly onBeforeConnect?: () => void;
  readonly onOpen?: (info: { readonly quiet: boolean }) => void;
  readonly onReconnecting?: () => void;
  readonly onRestarting?: () => void;
  readonly onAuthExpired?: () => void;
  readonly onBuildOutdated?: () => void;
  readonly onVisibilityResume?: () => void;
  readonly createEventSource?: (url: string) => EventSourceLike;
  readonly fetchFn?: typeof fetch;
  readonly now?: () => number;
  readonly parkMs?: number;
  readonly watchdogCheckMs?: number;
  readonly staleMs?: number;
}

export interface StreamClient extends Disposable {
  readonly onEvent: Event<StreamEventPayload>;
  connect(resume?: boolean, quiet?: boolean): void;
  close(): void;
  reconnectLater(): void;
  resumeStream(force?: boolean): void;
  checkBuild(): void;
  signedIn(): Promise<boolean>;
  getLastEventId(): string;
  setLastEventId(id: string): void;
  getTopicsVersion(): number;
  setTopicsVersion(tv: number): void;
  isParked(): boolean;
  isOpen(): boolean;
  attachWindowEvents(doc?: Document, win?: Window): Disposable;
}

const DEFAULT_PARK_MS = 15000;
const DEFAULT_WATCHDOG_CHECK_MS = 15000;
const DEFAULT_STALE_MS = 65000;

class StreamClientImpl implements StreamClient {
  private readonly _deps: StreamClientDeps;
  private readonly _parkMs: number;
  private readonly _watchdogCheckMs: number;
  private readonly _staleMs: number;
  private readonly _now: () => number;
  private readonly _fetchFn: typeof fetch;
  private readonly _createES: (url: string) => EventSourceLike;
  private readonly _onEvent = new Emitter<StreamEventPayload>();
  private readonly _disposables = new DisposableStore();

  private _stream: EventSourceLike | null = null;
  private _topicsV = 0;
  private _retryMs = 0;
  private _retryTimer: ReturnType<typeof setTimeout> | undefined;
  private _parkTimer: ReturnType<typeof setTimeout> | undefined;
  private _watchdogTimer: ReturnType<typeof setInterval> | undefined;
  private _parked = false;
  private _hiddenAt = 0;
  private _lastEv = '';
  private _lastActivityAt = 0;
  private _docRef: Document | undefined = typeof document !== 'undefined' ? document : undefined;

  readonly onEvent: Event<StreamEventPayload> = this._onEvent.event;

  constructor(deps: StreamClientDeps) {
    this._deps = deps;
    this._parkMs = deps.parkMs ?? DEFAULT_PARK_MS;
    this._watchdogCheckMs = deps.watchdogCheckMs ?? DEFAULT_WATCHDOG_CHECK_MS;
    this._staleMs = deps.staleMs ?? DEFAULT_STALE_MS;
    this._now = deps.now ?? (() => Date.now());
    this._fetchFn = deps.fetchFn ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
    this._createES =
      deps.createEventSource ?? ((url: string) => new EventSource(url) as unknown as EventSourceLike);
  }

  private _isHidden(): boolean {
    return this._docRef?.visibilityState === 'hidden';
  }

  private _clearRetryTimer(): void {
    if (this._retryTimer !== undefined) {
      clearTimeout(this._retryTimer);
      this._retryTimer = undefined;
    }
  }

  private _clearParkTimer(): void {
    if (this._parkTimer !== undefined) {
      clearTimeout(this._parkTimer);
      this._parkTimer = undefined;
    }
  }

  private _armWatchdog(): void {
    const want = !this._isHidden() && !this._parked && Boolean(this._stream) && this._stream?.readyState !== 2;
    if (want && this._watchdogTimer === undefined) {
      this._watchdogTimer = setInterval(() => {
        if (this._isHidden() || this._parked || !this._stream || this._stream.readyState === 2) return;
        if (this._lastActivityAt && this._now() - this._lastActivityAt > this._staleMs) {
          this.connect(true, true);
        }
      }, this._watchdogCheckMs);
    } else if (!want && this._watchdogTimer !== undefined) {
      clearInterval(this._watchdogTimer);
      this._watchdogTimer = undefined;
    }
  }

  private _park(): void {
    this._parkTimer = undefined;
    if (!this._isHidden() || !this._stream || this._stream.readyState === 2) return;
    this._parked = true;
    this._stream.close();
    this._armWatchdog();
  }

  reconnectLater(): void {
    if (this._retryTimer !== undefined) return;
    this._retryMs = this._retryMs ? Math.min(this._retryMs * 2, 30000) : 1000;
    this._retryTimer = setTimeout(() => {
      this._retryTimer = undefined;
      if (this._isHidden()) {
        this._parked = true;
        return;
      }
      this.connect(true, true);
    }, this._retryMs);
  }

  signedIn(): Promise<boolean> {
    return this._fetchFn('api/push', { credentials: 'same-origin', cache: 'no-store' }).then(
      (r) => r.status !== 401,
      () => true,
    );
  }

  checkBuild(): void {
    const build = this._deps.getBuild();
    const pathname = typeof location !== 'undefined' ? location.pathname : '/';
    this._fetchFn(pathname, { method: 'HEAD', cache: 'no-store', credentials: 'same-origin' }).then(
      (r) => {
        const tag = r && r.headers && typeof r.headers.get === 'function' ? r.headers.get('ETag') || '' : '';
        if (tag && build && !tag.includes(build)) this._deps.onBuildOutdated?.();
      },
      () => {},
    );
  }

  close(): void {
    if (this._stream) {
      this._stream.close();
      this._stream = null;
    }
    this._armWatchdog();
  }

  private _handleMessage(es: EventSourceLike, e: MessageEvent): void {
    if (es === this._stream) {
      this._lastActivityAt = this._now();
      if (e.lastEventId) this._lastEv = e.lastEventId;
    }
    let parsed: StreamEventPayload | undefined;
    try {
      parsed = JSON.parse(String(e.data)) as StreamEventPayload;
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== 'object') return;
    if (parsed.t === 'bye') {
      if (this._stream) this._stream.close();
      this._deps.onRestarting?.();
      this.reconnectLater();
      this._onEvent.fire(parsed);
      return;
    }
    this._onEvent.fire(parsed);
  }

  connect(resume = false, quiet = false): void {
    if (this._stream) this._stream.close();
    this._clearRetryTimer();
    this._parked = false;
    this._lastActivityAt = this._now();
    this._deps.onBeforeConnect?.();
    const from = resume ? this._lastEv : '';
    this._lastEv = from;
    const url = buildEventsUrl({ topic: this._deps.getTopic(), last: from, tv: this._topicsV });
    const es = this._createES(url);
    this._stream = es;

    es.onmessage = (e: MessageEvent) => this._handleMessage(es, e);
    es.addEventListener?.('ping', () => {
      if (es === this._stream) this._lastActivityAt = this._now();
    });
    es.onopen = () => {
      if (es !== this._stream) return;
      this._lastActivityAt = this._now();
      this._retryMs = 0;
      this._deps.onOpen?.({ quiet });
      this._armWatchdog();
    };
    es.onerror = () => {
      if (es !== this._stream) return;
      if (es.readyState === 2) {
        this._armWatchdog();
        this.signedIn().then((ok) => {
          if (es !== this._stream) return;
          if (ok) {
            this._deps.onReconnecting?.();
            this.reconnectLater();
          } else {
            this._deps.onAuthExpired?.();
          }
        });
      } else {
        this._deps.onReconnecting?.();
      }
    };
    this._armWatchdog();
  }

  resumeStream(force = false): void {
    if (this._isHidden() || this._deps.isLoggedOut()) return;
    const awayMs = this._hiddenAt ? this._now() - this._hiddenAt : 0;
    this._hiddenAt = 0;
    this._clearParkTimer();
    const stale = Boolean(this._lastActivityAt && this._now() - this._lastActivityAt > this._staleMs);
    const broken = !this._stream || this._stream.readyState !== 1 || this._retryTimer !== undefined;
    if (force || this._parked || awayMs >= this._parkMs || stale || broken) {
      this._parked = false;
      this._retryMs = 0;
      this.connect(true, true);
    } else {
      this._armWatchdog();
    }
  }

  attachWindowEvents(doc: Document = document, win: Window = window): Disposable {
    this._docRef = doc;
    const sub = new DisposableStore();
    sub.add(
      addDisposableListener(doc, 'visibilitychange', () => {
        if (doc.visibilityState === 'hidden') {
          if (!this._hiddenAt) this._hiddenAt = this._now();
          if (this._parkTimer === undefined && !this._parked) {
            this._parkTimer = setTimeout(() => this._park(), this._parkMs);
          }
          this._armWatchdog();
          return;
        }
        this.resumeStream(false);
        this._deps.onVisibilityResume?.();
      }),
    );
    sub.add(
      addDisposableListener(win, 'pageshow', (e) => {
        if ((e as PageTransitionEvent).persisted) {
          this.resumeStream(true);
          this._deps.onVisibilityResume?.();
        }
      }),
    );
    sub.add(
      addDisposableListener(win, 'online', () => {
        this.resumeStream(true);
      }),
    );
    return this._disposables.add(sub);
  }

  getLastEventId(): string {
    return this._lastEv;
  }

  setLastEventId(id: string): void {
    this._lastEv = id;
  }

  getTopicsVersion(): number {
    return this._topicsV;
  }

  setTopicsVersion(tv: number): void {
    this._topicsV = tv;
  }

  isParked(): boolean {
    return this._parked;
  }

  isOpen(): boolean {
    return Boolean(this._stream) && this._stream?.readyState === 1;
  }

  dispose(): void {
    this._clearRetryTimer();
    this._clearParkTimer();
    if (this._watchdogTimer !== undefined) {
      clearInterval(this._watchdogTimer);
      this._watchdogTimer = undefined;
    }
    if (this._stream) {
      this._stream.close();
      this._stream = null;
    }
    this._disposables.dispose();
    this._onEvent.dispose();
  }
}

export function createStreamClient(deps: StreamClientDeps): StreamClient {
  return new StreamClientImpl(deps);
}
