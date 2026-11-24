import { describe, expect, it, vi } from 'vitest';

import { Emitter, mapEvent, once } from './event.js';

describe('base/event', () => {
  it('fires events to subscribers and stops after unsubscribe', () => {
    const emitter = new Emitter<number>();
    const seen: number[] = [];
    const sub = emitter.event((v) => seen.push(v));

    emitter.fire(1);
    emitter.fire(2);
    sub.dispose();
    emitter.fire(3);

    expect(seen).toEqual([1, 2]);
    expect(emitter.hasListeners()).toBe(false);
  });

  it('snapshots listeners so unsubscribing mid-fire does not skip others', () => {
    const emitter = new Emitter<string>();
    const calls: string[] = [];
    const sub1 = emitter.event((v) => {
      calls.push(`a:${v}`);
      sub1.dispose();
    });
    emitter.event((v) => calls.push(`b:${v}`));

    emitter.fire('x');
    emitter.fire('y');
    expect(calls).toEqual(['a:x', 'b:x', 'b:y']);
  });

  it('clears listeners on dispose and ignores future subscriptions/fires', () => {
    const emitter = new Emitter<string>();
    const fn = vi.fn();
    emitter.event(fn);
    emitter.dispose();
    emitter.dispose();
    expect(emitter.isDisposed).toBe(true);

    const late = vi.fn();
    emitter.event(late).dispose();
    emitter.fire('hello');
    expect(fn).not.toHaveBeenCalled();
    expect(late).not.toHaveBeenCalled();
  });

  it('once fires at most once and can be cancelled beforehand', () => {
    const emitter = new Emitter<number>();
    const seen: number[] = [];
    once(emitter.event, (v) => seen.push(v));

    const cancelled = vi.fn();
    const sub = once(emitter.event, cancelled);
    sub.dispose();

    emitter.fire(10);
    emitter.fire(20);
    expect(seen).toEqual([10]);
    expect(cancelled).not.toHaveBeenCalled();
  });

  it('mapEvent transforms payloads', () => {
    const emitter = new Emitter<number>();
    const mapped = mapEvent(emitter.event, (n) => n * 2);
    const seen: number[] = [];
    const sub = mapped((n) => seen.push(n));

    emitter.fire(3);
    emitter.fire(7);
    sub.dispose();
    emitter.fire(9);
    expect(seen).toEqual([6, 14]);
  });
});
