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
});
