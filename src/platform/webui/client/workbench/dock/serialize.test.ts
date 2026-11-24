import { describe, expect, it } from 'vitest';

import { type StorageLike, StorageService } from '../../services/storage.js';
import type { LayoutState } from '../contracts.js';
import { listGroups } from './gridview.js';
import {
  createDefaultLayoutState,
  LAYOUT_STORAGE_KEY,
  loadSavedLayout,
  migrateLayoutState,
  pruneMissingComponents,
  resetSavedLayout,
  saveLayout,
  validateLayoutState,
} from './serialize.js';

function createMemoryStorage(): StorageLike & { readonly store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    },
    removeItem: (key) => {
      store.delete(key);
    },
  };
}

function makeSampleLayout(): LayoutState {
  return {
    v: 1,
    parts: {
      sidebar: { visible: true, size: 264, panels: ['view:topics'], activePanel: 'view:topics' },
      secondary: {
        visible: true,
        size: 400,
        panels: ['tool:changes', 'tool:files'],
        activePanel: 'tool:changes',
      },
      panel: { visible: false, size: 220, panels: ['tool:terminal'], activePanel: 'tool:terminal' },
    },
    grid: {
      type: 'branch',
      orientation: 'horizontal',
      sizes: [0.5, 0.5],
      children: [
        { type: 'leaf', group: 'main', panels: ['t1', 'd1'], activePanel: 't1' },
        { type: 'leaf', group: 'g1', panels: ['t2'], activePanel: 't2' },
      ],
    },
    panels: {
      'view:topics': { id: 'view:topics', component: 'view:topics', title: 'Topics' },
      'tool:changes': { id: 'tool:changes', component: 'tool:changes', title: 'Changes' },
      'tool:files': { id: 'tool:files', component: 'tool:files', title: 'Files' },
      'tool:terminal': { id: 'tool:terminal', component: 'tool:terminal', title: 'Terminal' },
      t1: { id: 't1', component: 'editor:topic', title: 'Topic 1', params: { topicId: 't1' } },
      d1: { id: 'd1', component: 'editor:diff', title: 'Diff', params: { topicId: 't1', path: 'a.ts' } },
      t2: { id: 't2', component: 'editor:topic', title: 'Topic 2', params: { topicId: 't2' } },
    },
    activeGroup: 'g1',
  };
}

describe('workbench/dock/serialize (pure node)', () => {
  it('validates a well-formed v1 LayoutState and preserves structure', () => {
    const sample = makeSampleLayout();
    const validated = validateLayoutState(sample);
    expect(validated).toEqual(sample);
    expect(migrateLayoutState(sample)).toEqual(sample);
  });

  it('rejects malformed, unknown-version, cyclic, or structurally inconsistent states', () => {
    expect(validateLayoutState(null)).toBeNull();
    expect(validateLayoutState(undefined)).toBeNull();
    expect(validateLayoutState('not-an-object')).toBeNull();
    expect(validateLayoutState([])).toBeNull();

    const wrongVersion = { ...makeSampleLayout(), v: 2 };
    expect(validateLayoutState(wrongVersion)).toBeNull();
    expect(migrateLayoutState(wrongVersion)).toBeNull();
    expect(migrateLayoutState({ ...makeSampleLayout(), v: 0 })).toBeNull();

    const missingPart = makeSampleLayout();
    const badParts = {
      ...missingPart,
      parts: { sidebar: missingPart.parts.sidebar, secondary: missingPart.parts.secondary },
    };
    expect(validateLayoutState(badParts)).toBeNull();

    const badSize = makeSampleLayout();
    expect(
      validateLayoutState({
        ...badSize,
        parts: { ...badSize.parts, sidebar: { ...badSize.parts.sidebar, size: -10 } },
      }),
    ).toBeNull();

    const emptyComponent = makeSampleLayout();
    expect(
      validateLayoutState({
        ...emptyComponent,
        panels: {
          ...emptyComponent.panels,
          t1: { id: 't1', component: '   ', title: 'Topic 1' },
        },
      }),
    ).toBeNull();

    const mismatchedId = makeSampleLayout();
    expect(
      validateLayoutState({
        ...mismatchedId,
        panels: {
          ...mismatchedId.panels,
          t1: { id: 'other', component: 'editor:topic', title: 'Topic 1' },
        },
      }),
    ).toBeNull();

    const danglingPanelRef = makeSampleLayout();
    expect(
      validateLayoutState({
        ...danglingPanelRef,
        grid: { type: 'leaf', group: 'main', panels: ['missing-panel'] },
        activeGroup: 'main',
      }),
    ).toBeNull();

    const duplicatePanelRef = makeSampleLayout();
    expect(
      validateLayoutState({
        ...duplicatePanelRef,
        grid: {
          type: 'branch',
          orientation: 'horizontal',
          sizes: [0.5, 0.5],
          children: [
            { type: 'leaf', group: 'main', panels: ['t1'] },
            { type: 'leaf', group: 'g1', panels: ['t1'] },
          ],
        },
      }),
    ).toBeNull();

    const duplicateGroupId = makeSampleLayout();
    expect(
      validateLayoutState({
        ...duplicateGroupId,
        grid: {
          type: 'branch',
          orientation: 'horizontal',
          sizes: [0.5, 0.5],
          children: [
            { type: 'leaf', group: 'main', panels: ['t1'] },
            { type: 'leaf', group: 'main', panels: ['t2'] },
          ],
        },
        activeGroup: 'main',
      }),
    ).toBeNull();

    const badActiveGroup = { ...makeSampleLayout(), activeGroup: 'nonexistent' };
    expect(validateLayoutState(badActiveGroup)).toBeNull();

    const badActivePanel = makeSampleLayout();
    expect(
      validateLayoutState({
        ...badActivePanel,
        parts: {
          ...badActivePanel.parts,
          sidebar: { ...badActivePanel.parts.sidebar, activePanel: 't1' },
        },
      }),
    ).toBeNull();

    const cyclicGrid: Record<string, unknown> = {
      type: 'branch',
      orientation: 'horizontal',
      sizes: [1],
      children: [],
    };
    (cyclicGrid.children as unknown[]).push(cyclicGrid);
    expect(validateLayoutState({ ...makeSampleLayout(), grid: cyclicGrid })).toBeNull();

    const cyclicParams: Record<string, unknown> = {};
    cyclicParams.self = cyclicParams;
    const withCyclicParams = makeSampleLayout();
    expect(
      validateLayoutState({
        ...withCyclicParams,
        panels: {
          ...withCyclicParams.panels,
          t1: { id: 't1', component: 'editor:topic', title: 'T1', params: cyclicParams },
        },
      }),
    ).toBeNull();
  });

  it('prunes missing components, updates active panels, and removes emptied split groups', () => {
    const sample = makeSampleLayout();
    const pruned = pruneMissingComponents(sample, [
      'view:topics',
      'tool:files',
      'editor:diff',
    ]);

    expect(Object.keys(pruned.panels).sort()).toEqual(['d1', 'tool:files', 'view:topics']);
    expect(pruned.parts.secondary.panels).toEqual(['tool:files']);
    expect(pruned.parts.secondary.activePanel).toBe('tool:files');
    expect(pruned.parts.panel.panels).toEqual([]);
    expect(pruned.parts.panel.activePanel).toBeUndefined();

    // g1 had only t2 (editor:topic), which was pruned, so g1 is removed and main collapses to root leaf.
    expect(pruned.grid.type).toBe('leaf');
    if (pruned.grid.type === 'leaf') {
      expect(pruned.grid.group).toBe('main');
      expect(pruned.grid.panels).toEqual(['d1']);
      expect(pruned.grid.activePanel).toBe('d1');
    }
    expect(pruned.activeGroup).toBe('main');
  });

  it('keeps a single empty leaf group when all editor components are pruned', () => {
    const sample: LayoutState = { ...makeSampleLayout(), maximizedGroup: 'g1' };
    const pruned = pruneMissingComponents(sample, ['view:topics']);

    const groups = listGroups(pruned.grid);
    expect(groups.length).toBe(1);
    expect(groups[0]!.group).toBe('g1');
    expect(groups[0]!.panels).toEqual([]);
    expect(pruned.activeGroup).toBe('g1');
    expect(pruned.maximizedGroup).toBe('g1');
  });

  it('saves, loads, prunes, and resets layout under aa_layout for both StorageLike and StorageService', () => {
    const mem = createMemoryStorage();
    const sample = makeSampleLayout();

    expect(saveLayout(mem, sample)).toBe(true);
    expect(mem.store.has(LAYOUT_STORAGE_KEY)).toBe(true);

    const loaded = loadSavedLayout(mem);
    expect(loaded).toEqual(sample);

    const loadedPruned = loadSavedLayout(mem, new Set(['view:topics', 'editor:topic']));
    expect(loadedPruned?.parts.secondary.panels).toEqual([]);
    expect(Object.keys(loadedPruned?.panels ?? {}).sort()).toEqual(['t1', 't2', 'view:topics']);

    expect(resetSavedLayout(mem)).toBe(true);
    expect(mem.store.has(LAYOUT_STORAGE_KEY)).toBe(false);
    expect(loadSavedLayout(mem)).toBeNull();

    // Corrupted JSON in storage returns null
    mem.setItem(LAYOUT_STORAGE_KEY, '{bad json');
    expect(loadSavedLayout(mem)).toBeNull();

    // Invalid state refused by saveLayout
    expect(saveLayout(mem, { v: 2 } as unknown as LayoutState)).toBe(false);

    // StorageService adapter
    const service = new StorageService('', mem);
    const def = createDefaultLayoutState({ partSizes: { sidebar: 300 } });
    expect(saveLayout(service, def)).toBe(true);
    expect(loadSavedLayout(service)?.parts.sidebar.size).toBe(300);
    expect(resetSavedLayout(service)).toBe(true);
    expect(loadSavedLayout(service)).toBeNull();
  });
});
