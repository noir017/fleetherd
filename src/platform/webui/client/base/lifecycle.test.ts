import { describe, expect, it, vi } from 'vitest';

import {
  DisposableStore,
  MutableDisposable,
  NOOP_DISPOSABLE,
  combineDisposables,
  toDisposable,
} from './lifecycle.js';

describe('base/lifecycle', () => {
  it('toDisposable runs callback once even if disposed repeatedly', () => {
    const fn = vi.fn();
    const d = toDisposable(fn);
    d.dispose();
    d.dispose();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('DisposableStore disposes in LIFO order and is idempotent', () => {
    const order: string[] = [];
    const store = new DisposableStore();
    store.add(toDisposable(() => order.push('first')));
    store.add(toDisposable(() => order.push('second')));
    store.add(toDisposable(() => order.push('third')));
    expect(store.size).toBe(3);

    store.dispose();
    store.dispose();
    expect(order).toEqual(['third', 'second', 'first']);
    expect(store.isDisposed).toBe(true);
    expect(store.size).toBe(0);
  });

  it('DisposableStore immediately disposes items added after dispose', () => {
    const store = new DisposableStore();
    store.dispose();
    const fn = vi.fn();
    store.add(toDisposable(fn));
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('DisposableStore prevents adding itself and supports clear/delete', () => {
    const store = new DisposableStore();
    expect(() => store.add(store)).toThrow(/itself/);

    const a = vi.fn();
    const b = vi.fn();
    const da = store.add(toDisposable(a));
    store.add(toDisposable(b));
    expect(store.delete(da)).toBe(true);
    expect(store.delete(da)).toBe(false);

    store.clear();
    expect(b).toHaveBeenCalledTimes(1);
    expect(a).not.toHaveBeenCalled();
    expect(store.isDisposed).toBe(false);

    const c = vi.fn();
    store.add(toDisposable(c));
    store.dispose();
    expect(c).toHaveBeenCalledTimes(1);
  });

  it('DisposableStore disposes remaining items even when one throws', () => {
    const order: string[] = [];
    const store = new DisposableStore();
    store.add(toDisposable(() => order.push('first')));
    store.add(
      toDisposable(() => {
        order.push('boom');
        throw new Error('fail');
      }),
    );
    store.add(toDisposable(() => order.push('third')));

    expect(() => store.dispose()).toThrow('fail');
    expect(order).toEqual(['third', 'boom', 'first']);
  });

  it('MutableDisposable replaces previous value and disposes on clear/dispose', () => {
    const first = vi.fn();
    const second = vi.fn();
    const mut = new MutableDisposable();

    const d1 = toDisposable(first);
    mut.value = d1;
    expect(mut.value).toBe(d1);
    mut.value = d1;
    expect(first).not.toHaveBeenCalled();

    const d2 = toDisposable(second);
    mut.value = d2;
    expect(first).toHaveBeenCalledTimes(1);
    expect(mut.value).toBe(d2);

    mut.dispose();
    mut.dispose();
    expect(second).toHaveBeenCalledTimes(1);
    expect(mut.value).toBeUndefined();

    const late = vi.fn();
    mut.value = toDisposable(late);
    expect(late).toHaveBeenCalledTimes(1);
  });

  it('combineDisposables disposes all in LIFO order once', () => {
    const order: number[] = [];
    const combined = combineDisposables(
      toDisposable(() => order.push(1)),
      toDisposable(() => order.push(2)),
      NOOP_DISPOSABLE,
    );
    combined.dispose();
    combined.dispose();
    expect(order).toEqual([2, 1]);
  });
});
