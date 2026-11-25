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

export function createScrollManager(log: HTMLElement): ScrollManager {
  const views: Record<string, ViewPosition> = {};
  const disposables = new DisposableStore();
  let view: ViewPosition | null = null;
  let landedAt = -1;
  let pinned = true;
  let pendingLand = false;
  let pendingView: ViewPosition | null = null;
  let lastClientHeight = log.clientHeight;
  let suppressScroll = false;

  function atBottom(): boolean {
    if (log.clientHeight === 0) return pinned;
    return log.scrollHeight - log.scrollTop - log.clientHeight < BOTTOM_THRESHOLD_PX;
  }

  function setScrollTop(value: number): void {
    suppressScroll = true;
    try {
      log.scrollTop = value;
    } finally {
      suppressScroll = false;
    }
  }

  function toBottom(): void {
    setScrollTop(log.scrollHeight);
    pinned = true;
    if (log.clientHeight === 0 || !log.isConnected) {
      pendingLand = true;
      pendingView = null;
    } else {
      pendingLand = false;
      pendingView = null;
    }
  }

  function applyViewOrBottom(
    target: ViewPosition | null,
    els?: Readonly<Record<string, HTMLElement | undefined>>,
  ): void {
    const el = target ? findLogChildByKey(log, target.key, els) : undefined;
    if (el && target) {
      setScrollTop(log.scrollTop + el.getBoundingClientRect().top - log.getBoundingClientRect().top - target.off);
      pinned = log.clientHeight === 0 ? false : atBottom();
    } else {
      setScrollTop(log.scrollHeight);
      pinned = true;
    }
    landedAt = log.scrollTop;
  }

  function firstVisible(): Element | null {
    return findFirstVisibleMessage(log);
  }

  function saveView(id: string, entering: boolean): void {
    if (!id) return;
    if (entering && (landedAt < 0 || log.scrollTop === landedAt)) {
      if (view) views[id] = view;
      else delete views[id];
      return;
    }
    const el = log.clientHeight && !atBottom() ? firstVisible() : null;
    const key = el ? el.getAttribute('data-k') : null;
    if (!el || !key) {
      delete views[id];
      return;
    }
    views[id] = {
      key,
      off: el.getBoundingClientRect().top - log.getBoundingClientRect().top,
    };
  }

  function prepareEnter(id: string): void {
    view = views[id] ?? null;
    landedAt = -1;
    pinned = view === null;
    pendingLand = false;
    pendingView = null;
  }

  function isArriving(entering: boolean): boolean {
    return entering && (landedAt < 0 || log.scrollTop === landedAt);
  }

  function land(els: Readonly<Record<string, HTMLElement | undefined>>): void {
    applyViewOrBottom(view, els);
    if (log.clientHeight === 0 || !log.isConnected) {
      pendingLand = true;
      pendingView = view;
    } else {
      pendingLand = false;
      pendingView = null;
    }
  }

  function ensureLanded(els?: Readonly<Record<string, HTMLElement | undefined>>): void {
    if (log.clientHeight === 0 || !log.isConnected) return;
    if (pendingLand) {
      applyViewOrBottom(pendingView, els);
      pendingLand = false;
      pendingView = null;
      return;
    }
    if (pinned && !atBottom()) {
      toBottom();
    }
  }

  function clearView(): void {
    view = null;
  }

  function forgetView(id: string): void {
    delete views[id];
  }

  function pruneViews(keep: Readonly<Record<string, unknown>>): void {
    for (const id of Object.keys(views)) {
      if (!keep[id]) delete views[id];
    }
  }

  function getSavedView(id: string): ViewPosition | undefined {
    return views[id];
  }

  disposables.add(
    addDisposableListener(
      log,
      'scroll',
      () => {
        if (suppressScroll || log.clientHeight === 0 || pendingLand) return;
        pinned = atBottom();
      },
      { passive: true },
    ),
  );

  disposables.add(
    observeResize(log, ({ height }) => {
      const nextH = height > 0 ? height : log.clientHeight;
      if (nextH > 0) {
        if (pendingLand) {
          applyViewOrBottom(pendingView);
          pendingLand = false;
          pendingView = null;
        } else if (lastClientHeight === 0 && pinned && !atBottom()) {
          toBottom();
        }
      }
      lastClientHeight = nextH;
    }),
  );

  function dispose(): void {
    disposables.dispose();
  }

  return {
    atBottom,
    toBottom,
    firstVisible,
    saveView,
    prepareEnter,
    isArriving,
    land,
    ensureLanded,
    clearView,
    forgetView,
    pruneViews,
    getSavedView,
    dispose,
  };
}
