import { describe, expect, it, vi } from 'vitest';
import { ancestorDirs, canonicalFileKey, relativePath } from './helpers.js';
import { FileTabStore, type FileTabRecord } from './tab-store.js';

function makeTab(key: string, overrides: Partial<FileTabRecord> = {}): FileTabRecord {
  return {
    key,
    panelId: `panel:${key}`,
    input: { topicId: 't1', path: '/repo/src/a.ts', root: '/repo', rel: 'src/a.ts' },
    title: 'a.ts',
    dirty: false,
    panelApi: null,
    focus: vi.fn(),
    requestClose: vi.fn(async () => true),
    ...overrides,
  };
}

describe('features/files helpers & FileTabStore', () => {
  it('computes identical canonical keys for root+rel and absolute paths across slash styles', () => {
    const k1 = canonicalFileKey({ topicId: 't1', root: '/repo', rel: 'src/a.ts', path: '/repo/src/a.ts' });
    const k2 = canonicalFileKey({ topicId: 't1', path: '/repo/src/a.ts' });
    const k3 = canonicalFileKey({ topicId: 't1', root: '/repo/', rel: '/src/a.ts', path: '/repo/src/a.ts' });
    const k4 = canonicalFileKey({ topicId: 't1', root: 'C:\\repo\\', rel: 'src\\a.ts', path: 'C:\\repo\\src\\a.ts' });
    const k5 = canonicalFileKey({ topicId: 't1', path: 'C:/repo/src/a.ts' });
    const otherTopic = canonicalFileKey({ topicId: 't2', path: '/repo/src/a.ts' });

    expect(k1).toBe(k2);
    expect(k2).toBe(k3);
    expect(k4).toBe(k5);
    expect(k1).not.toBe(otherTopic);
  });

  it('computes relativePath and top-down ancestorDirs cleanly', () => {
    expect(relativePath('/repo', '/repo/src/nested/deep/app.ts')).toBe('src/nested/deep/app.ts');
    expect(relativePath('/repo/', '/repo/README.md')).toBe('README.md');
    expect(relativePath('/repo', '/other/file.ts')).toBe('');

    expect(ancestorDirs('/repo', '/repo/src/nested/deep/app.ts', '/')).toEqual([
      '/repo/src',
      '/repo/src/nested',
      '/repo/src/nested/deep',
    ]);
    expect(ancestorDirs('/repo', '/repo/README.md', '/')).toEqual([]);
    expect(ancestorDirs('C:\\repo', 'C:\\repo\\a\\b\\c.ts', '\\')).toEqual([
      'C:\\repo\\a',
      'C:\\repo\\a\\b',
    ]);
  });

  it('deduplicates open tabs by canonical key, tracks dirty flags, and queues pending reveal', () => {
    const store = new FileTabStore();
    const openNew = vi.fn();

    const inputA = { topicId: 't1', root: '/repo', rel: 'src/a.ts', path: '/repo/src/a.ts' };
    const keyA = canonicalFileKey(inputA);
    expect(store.openOrFocus(inputA, openNew).reused).toBe(false);
    expect(openNew).toHaveBeenCalledTimes(1);

    const focusA = vi.fn();
    const subA = store.register(makeTab(keyA, { input: inputA, focus: focusA }));
    expect(store.hasDirtyTabs()).toBe(false);

    // Re-opening same file with absolute path only reuses existing tab
    const reused = store.openOrFocus({ topicId: 't1', path: '/repo/src/a.ts' }, openNew);
    expect(reused.reused).toBe(true);
    expect(focusA).toHaveBeenCalledTimes(1);
    expect(openNew).toHaveBeenCalledTimes(1);

    store.setDirty(keyA, true);
    expect(store.hasDirtyTabs()).toBe(true);
    store.setDirty(keyA, false);
    expect(store.hasDirtyTabs()).toBe(false);

    store.requestReveal({ topicId: 't1', path: '/repo/src/a.ts' });
    expect(store.consumePendingReveal('t2')).toBeNull();
    expect(store.consumePendingReveal('t1')).toEqual({ topicId: 't1', path: '/repo/src/a.ts' });
    expect(store.consumePendingReveal('t1')).toBeNull();

    subA.dispose();
    expect(store.list()).toHaveLength(0);
    store.dispose();
  });
});
