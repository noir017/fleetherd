import { describe, expect, it, vi } from 'vitest';

import { Store } from './store.js';

describe('services/store', () => {
  it('notifies onChange only when state actually changes', () => {
    const store = new Store({ count: 0, label: 'init' });
    const changes: Array<{ prev: number; next: number }> = [];
    store.onChange(({ prev, next }) => changes.push({ prev: prev.count, next: next.count }));

    store.patch({ count: 0 });
    expect(changes).toEqual([]);

    store.patch({ count: 1 });
    store.set((prev) => ({ ...prev, count: prev.count + 1 }));
    store.set(store.get());

    expect(changes).toEqual([
      { prev: 0, next: 1 },
      { prev: 1, next: 2 },
    ]);
    expect(store.get()).toEqual({ count: 2, label: 'init' });
  });

  it('select only fires when the selected slice changes', () => {
    const store = new Store({ count: 0, label: 'a' });
    const labelChanges: Array<[string, string]> = [];
    const sub = store.select(
      (s) => s.label,
      (next, prev) => labelChanges.push([prev, next]),
    );

    store.patch({ count: 1 });
    store.patch({ label: 'b' });
    store.patch({ count: 2 });
    sub.dispose();
    store.patch({ label: 'c' });

    expect(labelChanges).toEqual([['a', 'b']]);
  });

  it('stops notifying after dispose', () => {
    const store = new Store({ a: 1 });
    const fn = vi.fn();
    store.onChange(fn);
    store.dispose();
    store.patch({ a: 2 });
    expect(fn).not.toHaveBeenCalled();
  });
});
