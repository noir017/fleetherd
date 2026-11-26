import { addDisposableListener, observeResize } from '../../../base/dom.js';
import { DisposableStore } from '../../../base/lifecycle.js';
import type { ViewPosition } from './types.js';

export interface ScrollManager {
  atBottom(): boolean;
  toBottom(): void;
  firstVisible(): Element | null;
  saveView(id: string, entering: boolean): void;
  prepareEnter(id: string): void;
  isArriving(entering: boolean): boolean;
  land(els: Readonly<Record<string, HTMLElement | undefined>>): void;
  ensureLanded(els?: Readonly<Record<string, HTMLElement | undefined>>): void;
  clearView(): void;
  forgetView(id: string): void;
  pruneViews(keep: Readonly<Record<string, unknown>>): void;
  getSavedView(id: string): ViewPosition | undefined;
  dispose(): void;
}

const BOTTOM_THRESHOLD_PX = 80;

function findLogChildByKey(
  log: HTMLElement,
  key: string,
  els?: Readonly<Record<string, HTMLElement | undefined>>,
): HTMLElement | undefined {
  const direct = els?.[key];
  if (direct) return direct;
  const kids = log.children;
  for (let i = 0; i < kids.length; i++) {
    const child = kids[i];
    if (child instanceof HTMLElement && child.getAttribute('data-k') === key) return child;
  }
  return undefined;
}

function findFirstVisibleMessage(log: HTMLElement): Element | null {
  const kids = log.children;
  const top = log.getBoundingClientRect().top;
  let lo = 0;
  let hi = kids.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const child = kids[mid];
    if (child && child.getBoundingClientRect().bottom <= top) lo = mid + 1;
    else hi = mid;
  }
  for (let i = lo; i < kids.length; i++) {
    const child = kids[i];
    if (child && child.getAttribute('data-k')) return child;
  }
  return null;
}

class ScrollManagerImpl implements ScrollManager {
  private readonly _log: HTMLElement;
  private readonly _views: Record<string, ViewPosition> = {};
  private readonly _disposables = new DisposableStore();
  private _view: ViewPosition | null = null;
  private _landedAt = -1;
  private _pinned = true;
  private _pendingLand = false;
  private _pendingView: ViewPosition | null = null;
  private _lastClientHeight: number;
  private _suppressScroll = false;

  constructor(log: HTMLElement) {
    this._log = log;
    this._lastClientHeight = log.clientHeight;
    this._disposables.add(
      addDisposableListener(
        log,
        'scroll',
        () => {
          if (this._suppressScroll || log.clientHeight === 0 || this._pendingLand) return;
          this._pinned = this.atBottom();
        },
        { passive: true },
      ),
    );
    this._disposables.add(
      observeResize(log, ({ height }) => {
        const nextH = height > 0 ? height : log.clientHeight;
        if (nextH > 0) {
          if (this._pendingLand) {
            this._applyViewOrBottom(this._pendingView);
            this._pendingLand = false;
            this._pendingView = null;
          } else if (this._lastClientHeight === 0 && this._pinned && !this.atBottom()) {
            this.toBottom();
          }
        }
        this._lastClientHeight = nextH;
      }),
    );
  }

  private _setScrollTop(value: number): void {
    this._suppressScroll = true;
    try {
      this._log.scrollTop = value;
    } finally {
      this._suppressScroll = false;
    }
  }

  private _applyViewOrBottom(
    target: ViewPosition | null,
    els?: Readonly<Record<string, HTMLElement | undefined>>,
  ): void {
    const el = target ? findLogChildByKey(this._log, target.key, els) : undefined;
    if (el && target) {
      this._setScrollTop(
        this._log.scrollTop + el.getBoundingClientRect().top - this._log.getBoundingClientRect().top - target.off,
      );
      this._pinned = this._log.clientHeight === 0 ? false : this.atBottom();
    } else {
      this._setScrollTop(this._log.scrollHeight);
      this._pinned = true;
    }
    this._landedAt = this._log.scrollTop;
  }

  atBottom(): boolean {
    if (this._log.clientHeight === 0) return this._pinned;
    return this._log.scrollHeight - this._log.scrollTop - this._log.clientHeight < BOTTOM_THRESHOLD_PX;
  }

  toBottom(): void {
    this._setScrollTop(this._log.scrollHeight);
    this._pinned = true;
    this._pendingLand = this._log.clientHeight === 0 || !this._log.isConnected;
    this._pendingView = null;
  }

  firstVisible(): Element | null {
    return findFirstVisibleMessage(this._log);
  }

  saveView(id: string, entering: boolean): void {
    if (!id) return;
    if (entering && (this._landedAt < 0 || this._log.scrollTop === this._landedAt)) {
      if (this._view) this._views[id] = this._view;
      else delete this._views[id];
      return;
    }
    const el = this._log.clientHeight && !this.atBottom() ? this.firstVisible() : null;
    const key = el ? el.getAttribute('data-k') : null;
    if (!el || !key) {
      delete this._views[id];
      return;
    }
    this._views[id] = {
      key,
      off: el.getBoundingClientRect().top - this._log.getBoundingClientRect().top,
    };
  }

  prepareEnter(id: string): void {
    this._view = this._views[id] ?? null;
    this._landedAt = -1;
    this._pinned = this._view === null;
    this._pendingLand = false;
    this._pendingView = null;
  }

  isArriving(entering: boolean): boolean {
    return entering && (this._landedAt < 0 || this._log.scrollTop === this._landedAt);
  }

  land(els: Readonly<Record<string, HTMLElement | undefined>>): void {
    this._applyViewOrBottom(this._view, els);
    if (this._log.clientHeight === 0 || !this._log.isConnected) {
      this._pendingLand = true;
      this._pendingView = this._view;
    } else {
      this._pendingLand = false;
      this._pendingView = null;
    }
  }

  ensureLanded(els?: Readonly<Record<string, HTMLElement | undefined>>): void {
    if (this._log.clientHeight === 0 || !this._log.isConnected) return;
    if (this._pendingLand) {
      this._applyViewOrBottom(this._pendingView, els);
      this._pendingLand = false;
      this._pendingView = null;
      return;
    }
    if (this._pinned && !this.atBottom()) {
      this.toBottom();
    }
  }

  clearView(): void {
    this._view = null;
  }

  forgetView(id: string): void {
    delete this._views[id];
  }

  pruneViews(keep: Readonly<Record<string, unknown>>): void {
    for (const id of Object.keys(this._views)) {
      if (!keep[id]) delete this._views[id];
    }
  }

  getSavedView(id: string): ViewPosition | undefined {
    return this._views[id];
  }

  dispose(): void {
    this._disposables.dispose();
  }
}

export function createScrollManager(log: HTMLElement): ScrollManager {
  return new ScrollManagerImpl(log);
}
