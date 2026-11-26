import type { StorageLike, StorageService } from '../../services/storage.js';
import type {
  GridNodeState,
  LayoutState,
  PanelLayoutState,
  PartId,
  PartLayoutState,
} from '../contracts.js';
import { createLeafNode, listGroups, normalizeGrid, removeGroup } from './gridview.js';

export const LAYOUT_STORAGE_KEY = 'aa_layout';
export const LAYOUT_SCHEMA_VERSION = 1 as const;
export const DEFAULT_GROUP_ID = 'main';

const PART_IDS: readonly PartId[] = ['sidebar', 'secondary', 'panel'];
const MAX_TREE_DEPTH = 64;

export const DEFAULT_PART_LAYOUT: Record<PartId, { readonly visible: boolean; readonly size: number }> = {
  sidebar: { visible: true, size: 264 },
  secondary: { visible: false, size: 420 },
  panel: { visible: false, size: 220 },
};

export type LayoutStorage = StorageService | StorageLike;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasCycle(value: unknown, seen: Set<object>, depth: number): boolean {
  if (depth > MAX_TREE_DEPTH) return true;
  if (typeof value !== 'object' || value === null) return false;
  if (seen.has(value)) return true;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      if (hasCycle(item, seen, depth + 1)) return true;
    }
  } else {
    for (const item of Object.values(value)) {
      if (hasCycle(item, seen, depth + 1)) return true;
    }
  }
  seen.delete(value);
  return false;
}

function validatePanels(raw: unknown): Record<string, PanelLayoutState> | null {
  if (!isPlainObject(raw)) return null;
  const out: Record<string, PanelLayoutState> = {};

  for (const [key, entry] of Object.entries(raw)) {
    if (!isNonEmptyString(key) || !isPlainObject(entry)) return null;
    if (!isNonEmptyString(entry.id) || entry.id !== key) return null;
    if (!isNonEmptyString(entry.component)) return null;
    if (typeof entry.title !== 'string') return null;
    if (entry.params !== undefined && hasCycle(entry.params, new Set(), 0)) return null;

    out[key] = {
      id: entry.id,
      component: entry.component,
      title: entry.title,
      ...(entry.params !== undefined ? { params: entry.params } : {}),
    };
  }
  return out;
}

function validatePanelIdList(
  raw: unknown,
  panels: Record<string, PanelLayoutState>,
  usedPanelIds: Set<string>,
): string[] | null {
  if (!Array.isArray(raw)) return null;
  const ids: string[] = [];
  for (const item of raw) {
    if (!isNonEmptyString(item)) return null;
    if (!Object.hasOwn(panels, item) || usedPanelIds.has(item)) return null;
    usedPanelIds.add(item);
    ids.push(item);
  }
  return ids;
}

function validateParts(
  raw: unknown,
  panels: Record<string, PanelLayoutState>,
  usedPanelIds: Set<string>,
): Record<PartId, PartLayoutState> | null {
  if (!isPlainObject(raw)) return null;
  const out = {} as Record<PartId, PartLayoutState>;

  for (const partId of PART_IDS) {
    const entry = raw[partId];
    if (!isPlainObject(entry)) return null;
    if (typeof entry.visible !== 'boolean') return null;
    if (typeof entry.size !== 'number' || !Number.isFinite(entry.size) || entry.size < 0) return null;

    const panelIds = validatePanelIdList(entry.panels, panels, usedPanelIds);
    if (!panelIds) return null;

    let activePanel: string | undefined;
    if (entry.activePanel !== undefined) {
      if (!isNonEmptyString(entry.activePanel) || !panelIds.includes(entry.activePanel)) {
        return null;
      }
      activePanel = entry.activePanel;
    }

    out[partId] = {
      visible: entry.visible,
      size: Math.round(entry.size),
      panels: panelIds,
      ...(activePanel !== undefined ? { activePanel } : {}),
    };
  }
  return out;
}

function validateLeafNode(
  raw: Record<string, unknown>,
  panels: Record<string, PanelLayoutState>,
  usedPanelIds: Set<string>,
  groupIds: Set<string>,
): GridNodeState | null {
  if (!isNonEmptyString(raw.group) || groupIds.has(raw.group)) return null;
  groupIds.add(raw.group);

  const panelIds = validatePanelIdList(raw.panels, panels, usedPanelIds);
  if (!panelIds) return null;

  let activePanel: string | undefined;
  if (raw.activePanel !== undefined) {
    if (!isNonEmptyString(raw.activePanel) || !panelIds.includes(raw.activePanel)) {
      return null;
    }
    activePanel = raw.activePanel;
  }

  return createLeafNode(raw.group, panelIds, activePanel);
}

function validateGridNode(
  raw: unknown,
  panels: Record<string, PanelLayoutState>,
  usedPanelIds: Set<string>,
  groupIds: Set<string>,
  ancestors: Set<object>,
  depth: number,
): GridNodeState | null {
  if (depth > MAX_TREE_DEPTH || !isPlainObject(raw) || ancestors.has(raw)) return null;
  ancestors.add(raw);

  try {
    if (raw.type === 'leaf') {
      return validateLeafNode(raw, panels, usedPanelIds, groupIds);
    }
    if (raw.type !== 'branch') return null;
    if (raw.orientation !== 'horizontal' && raw.orientation !== 'vertical') return null;
    if (!Array.isArray(raw.children) || raw.children.length === 0) return null;
    if (!Array.isArray(raw.sizes) || raw.sizes.length !== raw.children.length) return null;

    const sizes: number[] = [];
    for (const sz of raw.sizes) {
      if (typeof sz !== 'number' || !Number.isFinite(sz) || sz <= 0) return null;
      sizes.push(sz);
    }

    const children: GridNodeState[] = [];
    for (const child of raw.children) {
      const validChild = validateGridNode(child, panels, usedPanelIds, groupIds, ancestors, depth + 1);
      if (!validChild) return null;
      children.push(validChild);
    }

    return {
      type: 'branch',
      orientation: raw.orientation,
      sizes,
      children,
    };
  } finally {
    ancestors.delete(raw);
  }
}

export function validateLayoutState(raw: unknown): LayoutState | null {
  if (!isPlainObject(raw) || raw.v !== LAYOUT_SCHEMA_VERSION) return null;

  const panels = validatePanels(raw.panels);
  if (!panels) return null;

  const usedPanelIds = new Set<string>();
  const parts = validateParts(raw.parts, panels, usedPanelIds);
  if (!parts) return null;

  const groupIds = new Set<string>();
  const grid = validateGridNode(raw.grid, panels, usedPanelIds, groupIds, new Set(), 0);
  if (!grid || groupIds.size === 0) return null;

  let activeGroup: string | undefined;
  if (raw.activeGroup !== undefined) {
    if (!isNonEmptyString(raw.activeGroup) || !groupIds.has(raw.activeGroup)) return null;
    activeGroup = raw.activeGroup;
  }

  let maximizedGroup: string | undefined;
  if (raw.maximizedGroup !== undefined) {
    if (!isNonEmptyString(raw.maximizedGroup) || !groupIds.has(raw.maximizedGroup)) return null;
    maximizedGroup = raw.maximizedGroup;
  }

  return {
    v: LAYOUT_SCHEMA_VERSION,
    parts,
    grid,
    panels,
    ...(activeGroup !== undefined ? { activeGroup } : {}),
    ...(maximizedGroup !== undefined ? { maximizedGroup } : {}),
  };
}

export function migrateLayoutState(raw: unknown): LayoutState | null {
  if (!isPlainObject(raw)) return null;
  if (raw.v === LAYOUT_SCHEMA_VERSION) {
    return validateLayoutState(raw);
  }
  return null;
}

function pruneGridLeaves(node: GridNodeState, validPanelIds: ReadonlySet<string>): GridNodeState {
  if (node.type === 'leaf') {
    const panels = node.panels.filter((id) => validPanelIds.has(id));
    const activePanel =
      node.activePanel && panels.includes(node.activePanel) ? node.activePanel : panels[0];
    return createLeafNode(node.group, panels, activePanel);
  }
  return {
    ...node,
    children: node.children.map((child) => pruneGridLeaves(child, validPanelIds)),
  };
}

function cleanupEmptyGroups(grid: GridNodeState, preferredGroupId?: string): GridNodeState {
  let next = normalizeGrid(grid);
  const leaves = listGroups(next);
  if (leaves.length <= 1) return next;

  const emptyIds = leaves
    .filter((leaf) => leaf.panels.length === 0)
    .map((leaf) => leaf.group)
    .sort((a, b) => {
      if (a === preferredGroupId) return 1;
      if (b === preferredGroupId) return -1;
      return 0;
    });

  for (const id of emptyIds) {
    if (listGroups(next).length <= 1) break;
    const removed = removeGroup(next, id);
    if (removed) next = removed;
  }
  return normalizeGrid(next);
}

export function pruneMissingComponents(
  state: LayoutState,
  registeredComponents: ReadonlySet<string> | readonly string[],
): LayoutState {
  const registered =
    registeredComponents instanceof Set
      ? registeredComponents
      : new Set(registeredComponents);

  const panels: Record<string, PanelLayoutState> = {};
  const validPanelIds = new Set<string>();
  for (const [id, meta] of Object.entries(state.panels)) {
    if (!registered.has(meta.component)) continue;
    panels[id] = meta;
    validPanelIds.add(id);
  }

  const parts = {} as Record<PartId, PartLayoutState>;
  for (const partId of PART_IDS) {
    const part = state.parts[partId];
    const kept = part.panels.filter((id) => validPanelIds.has(id));
    const activePanel =
      part.activePanel && kept.includes(part.activePanel) ? part.activePanel : kept[0];
    parts[partId] = {
      visible: part.visible,
      size: part.size,
      panels: kept,
      ...(activePanel !== undefined ? { activePanel } : {}),
    };
  }

  const prunedGrid = pruneGridLeaves(state.grid, validPanelIds);
  const grid = cleanupEmptyGroups(prunedGrid, state.activeGroup);
  const survivingGroups = new Set(listGroups(grid).map((leaf) => leaf.group));

  const activeGroup =
    state.activeGroup && survivingGroups.has(state.activeGroup)
      ? state.activeGroup
      : listGroups(grid)[0]?.group;
  const maximizedGroup =
    state.maximizedGroup && survivingGroups.has(state.maximizedGroup)
      ? state.maximizedGroup
      : undefined;

  return {
    v: LAYOUT_SCHEMA_VERSION,
    parts,
    grid,
    panels,
    ...(activeGroup !== undefined ? { activeGroup } : {}),
    ...(maximizedGroup !== undefined ? { maximizedGroup } : {}),
  };
}

export function createDefaultLayoutState(overrides?: {
  readonly partSizes?: Partial<Record<PartId, number>>;
  readonly initialVisible?: Partial<Record<PartId, boolean>>;
}): LayoutState {
  const parts = {} as Record<PartId, PartLayoutState>;
  for (const partId of PART_IDS) {
    const def = DEFAULT_PART_LAYOUT[partId];
    const size = overrides?.partSizes?.[partId];
    parts[partId] = {
      visible: overrides?.initialVisible?.[partId] ?? def.visible,
      size: size !== undefined && Number.isFinite(size) && size >= 0 ? Math.round(size) : def.size,
      panels: [],
    };
  }
  return {
    v: LAYOUT_SCHEMA_VERSION,
    parts,
    grid: createLeafNode(DEFAULT_GROUP_ID),
    panels: {},
    activeGroup: DEFAULT_GROUP_ID,
  };
}

function isStorageService(storage: LayoutStorage): storage is StorageService {
  return 'getRaw' in storage && typeof storage.getRaw === 'function';
}

function readRaw(storage: LayoutStorage, key: string): string | null {
  try {
    return isStorageService(storage) ? storage.getRaw(key) : storage.getItem(key);
  } catch {
    return null;
  }
}

function writeRaw(storage: LayoutStorage, key: string, value: string): boolean {
  try {
    if (isStorageService(storage)) return storage.setRaw(key, value);
    storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function removeKey(storage: LayoutStorage, key: string): boolean {
  try {
    if (isStorageService(storage)) return storage.remove(key);
    storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

export function loadSavedLayout(
  storage: LayoutStorage,
  registeredComponents?: ReadonlySet<string> | readonly string[],
  key: string = LAYOUT_STORAGE_KEY,
): LayoutState | null {
  const raw = readRaw(storage, key);
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const migrated = migrateLayoutState(parsed);
  if (!migrated) return null;
  return registeredComponents !== undefined
    ? pruneMissingComponents(migrated, registeredComponents)
    : migrated;
}

export function saveLayout(
  storage: LayoutStorage,
  state: LayoutState,
  key: string = LAYOUT_STORAGE_KEY,
): boolean {
  const valid = validateLayoutState(state);
  if (!valid) return false;
  try {
    return writeRaw(storage, key, JSON.stringify(valid));
  } catch {
    return false;
  }
}

export function resetSavedLayout(
  storage: LayoutStorage,
  key: string = LAYOUT_STORAGE_KEY,
): boolean {
  return removeKey(storage, key);
}
