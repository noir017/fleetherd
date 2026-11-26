import { describe, expect, it } from 'vitest';

import { type StorageLike, StorageService } from './storage.js';

function makeMemoryStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    key(index: number) {
      return [...map.keys()][index] ?? null;
    },
    getItem(k: string) {
      return map.has(k) ? map.get(k)! : null;
    },
    setItem(k: string, v: string) {
      map.set(k, v);
    },
    removeItem(k: string) {
      map.delete(k);
    },
  };
}

describe('services/storage', () => {
  it('stores raw and JSON values with prefix isolation', () => {
    const backend = makeMemoryStorage();
    const root = new StorageService('fh:', backend);
    const pluginA = root.scope('plugin-a');
    const pluginB = root.scope('plugin-b');

    expect(pluginA.setJson('prefs', { dark: true, count: 3 })).toBe(true);
    expect(pluginB.setJson('prefs', { dark: false })).toBe(true);

    expect(pluginA.getJson('prefs')).toEqual({ dark: true, count: 3 });
    expect(pluginB.getJson('prefs')).toEqual({ dark: false });
    expect(pluginA.keys()).toEqual(['prefs']);

    pluginA.clear();
    expect(pluginA.getJson('prefs')).toBeUndefined();
    expect(pluginB.getJson('prefs')).toEqual({ dark: false });
  });

  it('handles corrupt JSON and throwing storage safely', () => {
    const backend = makeMemoryStorage();
    backend.setItem('k:bad', '{not-json');
    const store = new StorageService('k:', backend);
    expect(store.getJson('bad')).toBeUndefined();

    const throwing: StorageLike = {
      getItem() {
        throw new Error('denied');
      },
      setItem() {
        throw new Error('quota');
      },
      removeItem() {
        throw new Error('denied');
      },
    };
    const broken = new StorageService('x:', throwing);
    expect(broken.getRaw('a')).toBeNull();
    expect(broken.setRaw('a', '1')).toBe(false);
    expect(broken.remove('a')).toBe(false);
    expect(broken.keys()).toEqual([]);

    const nullStore = new StorageService('x:', null);
    expect(nullStore.getRaw('a')).toBeNull();
    expect(nullStore.setJson('a', 1)).toBe(false);
  });
});
