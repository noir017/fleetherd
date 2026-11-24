import type { ViewPosition } from './types.js';

export interface ScrollManager {
  atBottom(): boolean;
  toBottom(): void;
  firstVisible(): Element | null;
  saveView(id: string, entering: boolean): void;
  prepareEnter(id: string): void;
  isArriving(entering: boolean): boolean;
  land(els: Readonly<Record<string, HTMLElement | undefined>>): void;
  clearView(): void;
  forgetView(id: string): void;
  pruneViews(keep: Readonly<Record<string, unknown>>): void;
  getSavedView(id: string): ViewPosition | undefined;
}

const BOTTOM_THRESHOLD_PX = 80;

export function createScrollManager(log: HTMLElement): ScrollManager {
  const views: Record<string, ViewPosition> = {};
  let view: ViewPosition | null = null;
  let landedAt = -1;

  function atBottom(): boolean {
    return log.scrollHeight - log.scrollTop - log.clientHeight < BOTTOM_THRESHOLD_PX;
  }

  function toBottom(): void {
    log.scrollTop = log.scrollHeight;
  }

  function firstVisible(): Element | null {
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
  }

  function isArriving(entering: boolean): boolean {
    return entering && (landedAt < 0 || log.scrollTop === landedAt);
  }

  function land(els: Readonly<Record<string, HTMLElement | undefined>>): void {
    const el = view ? els[view.key] : undefined;
    if (el && view) {
      log.scrollTop += el.getBoundingClientRect().top - log.getBoundingClientRect().top - view.off;
    } else {
      toBottom();
    }
    landedAt = log.scrollTop;
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

  return {
    atBottom,
    toBottom,
    firstVisible,
    saveView,
    prepareEnter,
    isArriving,
    land,
    clearView,
    forgetView,
    pruneViews,
    getSavedView,
  };
}
