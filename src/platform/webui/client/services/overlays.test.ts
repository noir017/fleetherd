import { describe, expect, it, vi } from 'vitest';

import { OverlayManager } from './overlays.js';

describe('services/overlays', () => {
  it('closes stacked overlays in LIFO order and restores focus', () => {
    const mgr = new OverlayManager();
    const closed: string[] = [];
    const focus1 = vi.fn();
    const focus2 = vi.fn();

    mgr.push({
      id: 'first',
      close: () => {
        closed.push('first');
      },
      restoreFocus: { focus: focus1 } as unknown as HTMLElement,
    });
    mgr.push({
      id: 'second',
      close: () => {
        closed.push('second');
      },
      restoreFocus: () => ({ focus: focus2 }) as unknown as HTMLElement,
    });

    expect(mgr.size).toBe(2);
    expect(mgr.handleEscape()).toBe(true);
    expect(closed).toEqual(['second']);
    expect(focus2).toHaveBeenCalledTimes(1);
    expect(mgr.size).toBe(1);

    expect(mgr.handleEscape()).toBe(true);
    expect(closed).toEqual(['second', 'first']);
    expect(focus1).toHaveBeenCalledTimes(1);
    expect(mgr.size).toBe(0);

    expect(mgr.handleEscape()).toBe(false);
  });

  it('keeps overlay on stack when close returns false (e.g. cancelled confirm)', () => {
    const mgr = new OverlayManager();
    const focus = vi.fn();
    let allow = false;
    mgr.push({
      close: () => allow,
      restoreFocus: { focus } as unknown as HTMLElement,
    });

    expect(mgr.handleEscape()).toBe(true);
    expect(mgr.size).toBe(1);
    expect(focus).not.toHaveBeenCalled();

    allow = true;
    expect(mgr.handleEscape()).toBe(true);
    expect(mgr.size).toBe(0);
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it('honours guards, IME composition, and fallback order', () => {
    const mgr = new OverlayManager();
    let recording = true;
    mgr.addGuard(() => recording);

    const calls: string[] = [];
    mgr.registerFallback(() => {
      calls.push('layer1');
      return false;
    });
    mgr.registerFallback(() => {
      calls.push('layer2');
      return true;
    });
    mgr.registerFallback(() => {
      calls.push('layer3');
      return true;
    });

    const target = new EventTarget();
    const sub = mgr.attach(target);

    target.dispatchEvent(Object.assign(new Event('keydown'), { key: 'Escape', isComposing: false }));
    expect(calls).toEqual([]);

    recording = false;
    target.dispatchEvent(Object.assign(new Event('keydown'), { key: 'Escape', isComposing: true }));
    expect(calls).toEqual([]);

    target.dispatchEvent(Object.assign(new Event('keydown'), { key: 'Escape', isComposing: false }));
    expect(calls).toEqual(['layer1', 'layer2']);

    sub.dispose();
    mgr.dispose();
  });
});
