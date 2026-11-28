// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { createScrollManager } from './scroll.js';

function makeRect(top: number, height: number): DOMRect {
  return {
    top,
    bottom: top + height,
    left: 0,
    right: 400,
    width: 400,
    height,
    x: 0,
    y: top,
    toJSON: () => ({}),
  };
}

function setupLog(scrollHeight: number, clientHeight: number, scrollTop: number): HTMLElement {
  const log = document.createElement('div');
  Object.defineProperty(log, 'scrollHeight', { value: scrollHeight, configurable: true });
  Object.defineProperty(log, 'clientHeight', { value: clientHeight, configurable: true });
  log.scrollTop = scrollTop;
  log.getBoundingClientRect = () => makeRect(100, clientHeight);
  return log;
}

describe('createScrollManager', () => {
  it('checks atBottom with 80px threshold and scrolls toBottom', () => {
    const log = setupLog(1000, 400, 521);
    const scroll = createScrollManager(log);
    expect(scroll.atBottom()).toBe(true);

    log.scrollTop = 520;
    expect(scroll.atBottom()).toBe(false);

    scroll.toBottom();
    expect(log.scrollTop).toBe(1000);
  });

  it('finds firstVisible message via binary search and skips non-message nodes', () => {
    const log = setupLog(1000, 400, 200);
    const m1 = document.createElement('div');
    m1.setAttribute('data-k', '1:m1');
    m1.getBoundingClientRect = () => makeRect(20, 60); // bottom 80 <= 100 (above viewport)

    const divider = document.createElement('div');
    divider.className = 'divider';
    divider.getBoundingClientRect = () => makeRect(90, 20); // bottom 110 > 100, no data-k

    const m2 = document.createElement('div');
    m2.setAttribute('data-k', '1:m2');
    m2.getBoundingClientRect = () => makeRect(115, 50);

    log.append(m1, divider, m2);
    const scroll = createScrollManager(log);
    expect(scroll.firstVisible()).toBe(m2);
  });

  it('saves and restores reading position across topic switches', () => {
    const log = setupLog(1200, 400, 200);
    const m2 = document.createElement('div');
    m2.setAttribute('data-k', '1:m2');
    m2.getBoundingClientRect = () => makeRect(130, 50); // off = 130 - 100 = 30
    log.append(m2);

    const scroll = createScrollManager(log);
    scroll.saveView('t1', false);
    expect(scroll.getSavedView('t1')).toEqual({ key: '1:m2', off: 30 });

    // Re-enter t1 where m2 shifted down by 120px because older history loaded above it.
    scroll.prepareEnter('t1');
    expect(scroll.isArriving(true)).toBe(true);
    m2.getBoundingClientRect = () => makeRect(250, 50);
    log.scrollTop = 200;
    scroll.land({ '1:m2': m2 });
    // delta = 250 - 100 - 30 = 120 -> scrollTop = 320
    expect(log.scrollTop).toBe(320);
    expect(scroll.isArriving(true)).toBe(true);

    // User scrolls manually -> no longer arriving.
    log.scrollTop = 350;
    expect(scroll.isArriving(true)).toBe(false);

    // Leaving while at bottom clears the saved view.
    log.scrollTop = 800;
    scroll.saveView('t1', false);
    expect(scroll.getSavedView('t1')).toBeUndefined();
  });

  it('forgets and prunes saved views', () => {
    const log = setupLog(1000, 400, 100);
    const m = document.createElement('div');
    m.setAttribute('data-k', '1:m1');
    m.getBoundingClientRect = () => makeRect(110, 40);
    log.append(m);

    const scroll = createScrollManager(log);
    scroll.saveView('t1', false);
    scroll.saveView('t2', false);
    scroll.saveView('t3', false);

    scroll.forgetView('t1');
    expect(scroll.getSavedView('t1')).toBeUndefined();
    scroll.pruneViews({ t2: 1 });
    expect(scroll.getSavedView('t2')).toBeDefined();
    expect(scroll.getSavedView('t3')).toBeUndefined();
  });

  it('defers land() when hidden (clientHeight=0) and scrolls to bottom once visible via ResizeObserver or ensureLanded', () => {
    type RoCb = (entries: readonly { target: Element; contentRect: { width: number; height: number } }[]) => void;
    const holder: { cb: RoCb | null } = { cb: null };
    const origRO = globalThis.ResizeObserver;
    class FakeResizeObserver {
      constructor(cb: RoCb) {
        holder.cb = cb;
      }
      observe() {}
      unobserve() {}
      disconnect() {
        holder.cb = null;
      }
    }
    globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
    try {
      const log = setupLog(0, 0, 0);
      document.body.appendChild(log);
      const scroll = createScrollManager(log);
      scroll.prepareEnter('t1');
      // Land while hidden (clientHeight=0, scrollHeight=0), followed by clearView() as handleSyncEvent does.
      scroll.land({});
      scroll.clearView();
      expect(log.scrollTop).toBe(0);

      // Container becomes visible with tall content.
      Object.defineProperty(log, 'clientHeight', { value: 600, configurable: true });
      Object.defineProperty(log, 'scrollHeight', { value: 3000, configurable: true });
      holder.cb?.([{ target: log, contentRect: { width: 390, height: 600 } }]);
      expect(log.scrollTop).toBe(3000);

      // User scrolls up to read older messages -> hiding and re-showing must NOT yank to bottom.
      log.scrollTop = 200;
      log.dispatchEvent(new Event('scroll'));
      expect(scroll.atBottom()).toBe(false);
      Object.defineProperty(log, 'clientHeight', { value: 0, configurable: true });
      holder.cb?.([{ target: log, contentRect: { width: 0, height: 0 } }]);
      Object.defineProperty(log, 'clientHeight', { value: 600, configurable: true });
      holder.cb?.([{ target: log, contentRect: { width: 390, height: 600 } }]);
      expect(log.scrollTop).toBe(200);

      // User returns to bottom -> reparent/hide+show resets scrollTop to 0, ensureLanded restores bottom.
      scroll.toBottom();
      expect(log.scrollTop).toBe(3000);
      log.scrollTop = 0;
      scroll.ensureLanded();
      expect(log.scrollTop).toBe(3000);

      scroll.dispose();
      log.remove();
    } finally {
      globalThis.ResizeObserver = origRO;
    }
  });

  it('keeps a log that was at its newest line there when the bar below it grows, and leaves one scrolled up alone', () => {
    type RoCb = (entries: readonly { target: Element; contentRect: { width: number; height: number } }[]) => void;
    const holder: { cb: RoCb | null } = { cb: null };
    const origRO = globalThis.ResizeObserver;
    class FakeResizeObserver {
      constructor(cb: RoCb) {
        holder.cb = cb;
      }
      observe() {}
      unobserve() {}
      disconnect() {
        holder.cb = null;
      }
    }
    globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
    try {
      const log = setupLog(3000, 600, 2400);
      document.body.appendChild(log);
      const scroll = createScrollManager(log);
      log.dispatchEvent(new Event('scroll'));
      // The subagent bar opens: the log loses 200px and the browser keeps scrollTop where it was.
      Object.defineProperty(log, 'clientHeight', { value: 400, configurable: true });
      holder.cb?.([{ target: log, contentRect: { width: 390, height: 400 } }]);
      expect(log.scrollTop).toBe(3000);

      log.scrollTop = 1000;
      log.dispatchEvent(new Event('scroll'));
      Object.defineProperty(log, 'clientHeight', { value: 250, configurable: true });
      holder.cb?.([{ target: log, contentRect: { width: 390, height: 250 } }]);
      expect(log.scrollTop).toBe(1000);
      scroll.dispose();
      log.remove();
    } finally {
      globalThis.ResizeObserver = origRO;
    }
  });

  it('calls onViewportShown when log transitions from hidden (0px) to visible', () => {
    type RoCb = (entries: readonly { target: Element; contentRect: { width: number; height: number } }[]) => void;
    const holder: { cb: RoCb | null } = { cb: null };
    const origRO = globalThis.ResizeObserver;
    class FakeResizeObserver {
      constructor(cb: RoCb) {
        holder.cb = cb;
      }
      observe() {}
      unobserve() {}
      disconnect() {
        holder.cb = null;
      }
    }
    globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
    try {
      const log = setupLog(200, 0, 0);
      document.body.appendChild(log);
      let shownCalls = 0;
      const scroll = createScrollManager(log, undefined, () => {
        shownCalls += 1;
      });
      Object.defineProperty(log, 'clientHeight', { value: 700, configurable: true });
      holder.cb?.([{ target: log, contentRect: { width: 390, height: 700 } }]);
      expect(shownCalls).toBe(1);
      // Subsequent resize while already visible does not re-fire onViewportShown.
      Object.defineProperty(log, 'clientHeight', { value: 650, configurable: true });
      holder.cb?.([{ target: log, contentRect: { width: 390, height: 650 } }]);
      expect(shownCalls).toBe(1);
      scroll.dispose();
      log.remove();
    } finally {
      globalThis.ResizeObserver = origRO;
    }
  });
});
