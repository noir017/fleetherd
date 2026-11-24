import { type Disposable, DisposableStore } from '../../base/lifecycle.js';
import type { MenuActionItem } from '../../components/menu/index.js';
import type { CommandMetadata, CommandRegistry } from '../../services/commands.js';
import type { KeybindingService } from '../../services/keybindings.js';
import type { StorageService } from '../../services/storage.js';
import type { DockEngine, GridNodeState, LayoutState, PanelRef, PartId } from '../contracts.js';

export const LAYOUT_STORAGE_KEY = 'aa_layout';

export const LAYOUT_COMMAND_IDS = {
  splitEditor: 'workbench.action.splitEditor',
  focusGroup1: 'workbench.action.focusGroup1',
  focusGroup2: 'workbench.action.focusGroup2',
  focusGroup3: 'workbench.action.focusGroup3',
  moveEditorRight: 'workbench.action.moveEditorRight',
  moveEditorLeft: 'workbench.action.moveEditorLeft',
  moveEditorDown: 'workbench.action.moveEditorDown',
  moveEditorUp: 'workbench.action.moveEditorUp',
  moveViewToSidebar: 'workbench.action.moveViewToSidebar',
  moveViewToSecondary: 'workbench.action.moveViewToSecondary',
  moveViewToPanel: 'workbench.action.moveViewToPanel',
  toggleMaximizeGroup: 'workbench.action.toggleMaximizeGroup',
  closeActiveEditor: 'workbench.action.closeActiveEditor',
  toggleSidebar: 'workbench.action.toggleSidebar',
  toggleSecondary: 'workbench.action.toggleSecondary',
  togglePanel: 'workbench.action.togglePanel',
  resetLayout: 'workbench.action.resetLayout',
} as const;

export type LayoutCommandId = (typeof LAYOUT_COMMAND_IDS)[keyof typeof LAYOUT_COMMAND_IDS];
export type MoveEditorDirection = 'left' | 'right' | 'above' | 'below';

type GridLeafNode = Extract<GridNodeState, { readonly type: 'leaf' }>;

interface NormalizedRect {
  readonly group: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface LayoutCommandsDeps {
  readonly engine: DockEngine;
  readonly commands: CommandRegistry;
  readonly keybindings?: KeybindingService;
  readonly storage?: StorageService;
  readonly storageKey?: string;
  readonly isSplitAllowed?: () => boolean;
  readonly notify?: (message: string) => void;
  readonly setPartVisible?: (part: PartId, visible: boolean) => void;
  readonly onResetLayout?: () => void;
  readonly getDefaultLayout?: () => LayoutState | undefined;
  readonly getActivePanel?: () => PanelRef | undefined;
  readonly getActiveViewId?: () => string | undefined;
  readonly translate?: (key: string, fallback: string) => string;
}

export interface MoveViewMenuItem extends MenuActionItem {
  readonly targetPart: PartId;
  readonly commandId: LayoutCommandId;
}

export interface MoveViewMenuOptions {
  readonly currentPartBehavior?: 'hide' | 'disable';
  readonly commands?: CommandRegistry;
  readonly setPartVisible?: (part: PartId, visible: boolean) => void;
  readonly translate?: (key: string, fallback: string) => string;
}

interface CommandSpec {
  readonly id: LayoutCommandId;
  readonly title: string;
  readonly keybinding?: string;
  readonly run: (...args: unknown[]) => unknown;
}

const PART_MOVE_SPECS: readonly {
  readonly part: PartId;
  readonly commandId: LayoutCommandId;
  readonly labelKey: string;
  readonly defaultLabel: string;
}[] = [
  {
    part: 'sidebar',
    commandId: LAYOUT_COMMAND_IDS.moveViewToSidebar,
    labelKey: 'wb.dock.moveToSidebar',
    defaultLabel: 'Move to Primary Side Bar',
  },
  {
    part: 'secondary',
    commandId: LAYOUT_COMMAND_IDS.moveViewToSecondary,
    labelKey: 'wb.dock.moveToSecondary',
    defaultLabel: 'Move to Secondary Side Bar',
  },
  {
    part: 'panel',
    commandId: LAYOUT_COMMAND_IDS.moveViewToPanel,
    labelKey: 'wb.dock.moveToPanel',
    defaultLabel: 'Move to Panel',
  },
];

const RECT_EPSILON = 1e-6;

function isPartId(value: string): value is PartId {
  return value === 'sidebar' || value === 'secondary' || value === 'panel';
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function tr(deps: { readonly translate?: (key: string, fallback: string) => string }, key: string, fallback: string): string {
  return deps.translate ? deps.translate(key, fallback) : fallback;
}

export function collectGridLeaves(node: GridNodeState): readonly GridLeafNode[] {
  const leaves: GridLeafNode[] = [];
  const walk = (current: GridNodeState): void => {
    if (current.type === 'leaf') {
      leaves.push(current);
      return;
    }
    for (const child of current.children) {
      walk(child);
    }
  };
  walk(node);
  return leaves;
}

function normalizeSizes(rawSizes: readonly number[], count: number): number[] {
  if (count <= 0) return [];
  let sum = 0;
  const cleaned = Array.from({ length: count }, (_, i) => {
    const v = rawSizes[i];
    const positive = v !== undefined && Number.isFinite(v) && v > 0 ? v : 0;
    sum += positive;
    return positive;
  });
  if (sum <= 0) {
    const equal = 1 / count;
    return Array.from({ length: count }, () => equal);
  }
  const fallback = sum / count;
  let total = 0;
  const filled = cleaned.map((v) => {
    const next = v > 0 ? v : fallback;
    total += next;
    return next;
  });
  return filled.map((v) => v / total);
}

function computeLeafRects(
  node: GridNodeState,
  x = 0,
  y = 0,
  width = 1,
  height = 1,
  out: NormalizedRect[] = [],
): NormalizedRect[] {
  if (node.type === 'leaf') {
    out.push({ group: node.group, x, y, width, height });
    return out;
  }
  const weights = normalizeSizes(node.sizes, node.children.length);
  let offset = 0;
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i]!;
    const ratio = weights[i]!;
    if (node.orientation === 'horizontal') {
      const childW = width * ratio;
      computeLeafRects(child, x + offset, y, childW, height, out);
      offset += childW;
    } else {
      const childH = height * ratio;
      computeLeafRects(child, x, y + offset, width, childH, out);
      offset += childH;
    }
  }
  return out;
}

function overlapLength(aStart: number, aSize: number, bStart: number, bSize: number): number {
  const start = Math.max(aStart, bStart);
  const end = Math.min(aStart + aSize, bStart + bSize);
  return Math.max(0, end - start);
}

function matchesEdge(current: NormalizedRect, candidate: NormalizedRect, direction: MoveEditorDirection): number {
  if (direction === 'right') {
    if (Math.abs(candidate.x - (current.x + current.width)) > RECT_EPSILON) return 0;
    return overlapLength(current.y, current.height, candidate.y, candidate.height);
  }
  if (direction === 'left') {
    if (Math.abs(candidate.x + candidate.width - current.x) > RECT_EPSILON) return 0;
    return overlapLength(current.y, current.height, candidate.y, candidate.height);
  }
  if (direction === 'below') {
    if (Math.abs(candidate.y - (current.y + current.height)) > RECT_EPSILON) return 0;
    return overlapLength(current.x, current.width, candidate.x, candidate.width);
  }
  if (Math.abs(candidate.y + candidate.height - current.y) > RECT_EPSILON) return 0;
  return overlapLength(current.x, current.width, candidate.x, candidate.width);
}

export function findAdjacentGroup(
  grid: GridNodeState,
  groupId: string,
  direction: MoveEditorDirection,
): string | undefined {
  const rects = computeLeafRects(grid);
  const current = rects.find((r) => r.group === groupId);
  if (!current) return undefined;

  let bestGroup: string | undefined;
  let bestOverlap = RECT_EPSILON;
  for (const candidate of rects) {
    if (candidate.group === groupId) continue;
    const overlap = matchesEdge(current, candidate, direction);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      bestGroup = candidate.group;
    }
  }
  return bestGroup;
}

function resolveEditorPanel(
  engine: DockEngine,
  explicitId: string | undefined,
  getTrackedActive: () => PanelRef | undefined,
): PanelRef | undefined {
  if (explicitId) {
    const panel = engine.getPanel(explicitId);
    return panel && !isPartId(panel.group) ? panel : undefined;
  }

  const candidate = getTrackedActive();
  if (candidate) {
    const live = engine.getPanel(candidate.id);
    if (live && !isPartId(live.group)) return live;
  }

  const state = engine.toJSON();
  const leaves = collectGridLeaves(state.grid);
  const preferred = leaves.find((l) => l.group === state.activeGroup) ?? leaves[0];
  if (preferred) {
    const preferredId = preferred.activePanel ?? preferred.panels[0];
    if (preferredId) {
      const live = engine.getPanel(preferredId);
      if (live) return live;
    }
  }

  for (const leaf of leaves) {
    const fallbackId = leaf.activePanel ?? leaf.panels[0];
    if (!fallbackId) continue;
    const live = engine.getPanel(fallbackId);
    if (live) return live;
  }
  return undefined;
}

function resolveActiveGroupId(
  engine: DockEngine,
  explicitGroupId: string | undefined,
  getTrackedActive: () => PanelRef | undefined,
): string | undefined {
  if (explicitGroupId) return explicitGroupId;
  const activeEditor = resolveEditorPanel(engine, undefined, getTrackedActive);
  if (activeEditor && !isPartId(activeEditor.group)) {
    return activeEditor.group;
  }
  const state = engine.toJSON();
  const leaves = collectGridLeaves(state.grid);
  if (state.activeGroup && leaves.some((l) => l.group === state.activeGroup)) {
    return state.activeGroup;
  }
  return leaves[0]?.group;
}

function resolveViewId(
  engine: DockEngine,
  explicitId: string | undefined,
  getActiveViewId: (() => string | undefined) | undefined,
  getTrackedActive: () => PanelRef | undefined,
): string | undefined {
  if (explicitId) return explicitId;
  const fromHook = getActiveViewId?.();
  if (fromHook) return fromHook;
  const candidate = getTrackedActive();
  if (candidate && isPartId(candidate.group)) {
    return engine.getPanel(candidate.id)?.id;
  }
  return undefined;
}

function applyPartVisible(deps: Pick<LayoutCommandsDeps, 'engine' | 'setPartVisible'>, part: PartId, visible: boolean): void {
  if (deps.setPartVisible) {
    deps.setPartVisible(part, visible);
  } else {
    deps.engine.setPartVisible(part, visible);
  }
}

function moveViewToPart(
  engine: DockEngine,
  viewId: string,
  targetPart: PartId,
  setPartVisible?: (part: PartId, visible: boolean) => void,
): boolean {
  const panel = engine.getPanel(viewId);
  if (!panel) return false;
  const showPart = (visible: boolean): void => {
    if (setPartVisible) setPartVisible(targetPart, visible);
    else engine.setPartVisible(targetPart, visible);
  };
  if (panel.group === targetPart) {
    showPart(true);
    return false;
  }
  engine.movePanel(viewId, { part: targetPart });
  showPart(true);
  engine.getPanel(viewId)?.focus();
  return true;
}

export function buildMoveViewMenuItems(
  viewId: string,
  currentPart: PartId | undefined,
  engine: DockEngine,
  options: MoveViewMenuOptions = {},
): readonly MoveViewMenuItem[] {
  const behavior = options.currentPartBehavior ?? 'hide';
  const liveGroup = engine.getPanel(viewId)?.group;
  const resolvedCurrent: PartId | undefined =
    currentPart ?? (liveGroup && isPartId(liveGroup) ? liveGroup : undefined);

  const items: MoveViewMenuItem[] = [];
  for (const spec of PART_MOVE_SPECS) {
    const isCurrent = resolvedCurrent === spec.part;
    if (isCurrent && behavior === 'hide') continue;
    const label = tr(options, spec.labelKey, spec.defaultLabel);
    items.push({
      kind: 'item',
      id: spec.commandId,
      commandId: spec.commandId,
      targetPart: spec.part,
      label,
      disabled: isCurrent,
      onSelect: () => {
        if (isCurrent) return;
        if (options.commands?.has(spec.commandId)) {
          void options.commands.execute(spec.commandId, viewId);
          return;
        }
        moveViewToPart(engine, viewId, spec.part, options.setPartVisible);
      },
    });
  }
  return items;
}

function clearLayoutStorage(storage: StorageService | undefined, key: string): void {
  if (storage) {
    storage.remove(key);
    return;
  }
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(key);
    }
  } catch {
    // Ignore storage access errors in restricted environments.
  }
}

function createEditorCommandSpecs(
  deps: LayoutCommandsDeps,
  getTrackedActive: () => PanelRef | undefined,
): readonly CommandSpec[] {
  const { engine } = deps;
  const splitDisabledMessage = (): string =>
    tr(deps, 'wb.dock.splitDisabledTablet', 'Splitting editors is not available in tablet mode');

  const splitEditor = (rawPanelId?: unknown): boolean => {
    if (deps.isSplitAllowed && !deps.isSplitAllowed()) {
      deps.notify?.(splitDisabledMessage());
      return false;
    }
    const panel = resolveEditorPanel(engine, asNonEmptyString(rawPanelId), getTrackedActive);
    if (!panel) return false;
    engine.movePanel(panel.id, { group: panel.group, direction: 'right' });
    engine.getPanel(panel.id)?.focus();
    return true;
  };

  const focusGroup = (index: number): boolean => {
    const leaves = collectGridLeaves(engine.toJSON().grid);
    const target = leaves[index];
    if (!target) return false;
    const panelId = target.activePanel ?? target.panels[0];
    if (!panelId) return false;
    const panel = engine.getPanel(panelId);
    if (!panel) return false;
    panel.focus();
    return true;
  };

  const moveEditor = (direction: MoveEditorDirection, rawPanelId?: unknown): boolean => {
    const panel = resolveEditorPanel(engine, asNonEmptyString(rawPanelId), getTrackedActive);
    if (!panel) return false;
    const adjacentGroup = findAdjacentGroup(engine.toJSON().grid, panel.group, direction);
    if (adjacentGroup) {
      engine.movePanel(panel.id, { group: adjacentGroup, direction: 'within' });
      engine.getPanel(panel.id)?.focus();
      return true;
    }
    if (deps.isSplitAllowed && !deps.isSplitAllowed()) {
      deps.notify?.(splitDisabledMessage());
      return false;
    }
    engine.movePanel(panel.id, { group: panel.group, direction });
    engine.getPanel(panel.id)?.focus();
    return true;
  };

  return [
    {
      id: LAYOUT_COMMAND_IDS.splitEditor,
      title: tr(deps, 'wb.cmd.splitEditor', 'Split Editor Right'),
      keybinding: 'Mod+\\',
      run: (panelId?: unknown) => splitEditor(panelId),
    },
    {
      id: LAYOUT_COMMAND_IDS.focusGroup1,
      title: tr(deps, 'wb.cmd.focusGroup1', 'Focus First Editor Group'),
      keybinding: 'Mod+1',
      run: () => focusGroup(0),
    },
    {
      id: LAYOUT_COMMAND_IDS.focusGroup2,
      title: tr(deps, 'wb.cmd.focusGroup2', 'Focus Second Editor Group'),
      keybinding: 'Mod+2',
      run: () => focusGroup(1),
    },
    {
      id: LAYOUT_COMMAND_IDS.focusGroup3,
      title: tr(deps, 'wb.cmd.focusGroup3', 'Focus Third Editor Group'),
      keybinding: 'Mod+3',
      run: () => focusGroup(2),
    },
    {
      id: LAYOUT_COMMAND_IDS.moveEditorRight,
      title: tr(deps, 'wb.cmd.moveEditorRight', 'Move Editor into Right Group'),
      run: (panelId?: unknown) => moveEditor('right', panelId),
    },
    {
      id: LAYOUT_COMMAND_IDS.moveEditorLeft,
      title: tr(deps, 'wb.cmd.moveEditorLeft', 'Move Editor into Left Group'),
      run: (panelId?: unknown) => moveEditor('left', panelId),
    },
    {
      id: LAYOUT_COMMAND_IDS.moveEditorDown,
      title: tr(deps, 'wb.cmd.moveEditorDown', 'Move Editor into Group Below'),
      run: (panelId?: unknown) => moveEditor('below', panelId),
    },
    {
      id: LAYOUT_COMMAND_IDS.moveEditorUp,
      title: tr(deps, 'wb.cmd.moveEditorUp', 'Move Editor into Group Above'),
      run: (panelId?: unknown) => moveEditor('above', panelId),
    },
    {
      id: LAYOUT_COMMAND_IDS.toggleMaximizeGroup,
      title: tr(deps, 'wb.cmd.toggleMaximizeGroup', 'Toggle Maximize Editor Group'),
      run: (rawGroupId?: unknown): boolean => {
        const state = engine.toJSON();
        if (state.maximizedGroup) {
          engine.exitMaximized();
          return false;
        }
        const groupId = resolveActiveGroupId(engine, asNonEmptyString(rawGroupId), getTrackedActive);
        if (!groupId) return false;
        engine.maximizeGroup(groupId);
        return true;
      },
    },
    {
      id: LAYOUT_COMMAND_IDS.closeActiveEditor,
      title: tr(deps, 'wb.cmd.closeActiveEditor', 'Close Active Editor'),
      run: (rawPanelId?: unknown): boolean => {
        const panel = resolveEditorPanel(engine, asNonEmptyString(rawPanelId), getTrackedActive);
        if (!panel) return false;
        engine.removePanel(panel.id);
        return true;
      },
    },
  ];
}

function createPartAndViewCommandSpecs(
  deps: LayoutCommandsDeps,
  getTrackedActive: () => PanelRef | undefined,
): readonly CommandSpec[] {
  const { engine } = deps;

  const moveView = (targetPart: PartId, rawViewId?: unknown): boolean => {
    const viewId = resolveViewId(engine, asNonEmptyString(rawViewId), deps.getActiveViewId, getTrackedActive);
    if (!viewId) return false;
    return moveViewToPart(engine, viewId, targetPart, deps.setPartVisible);
  };

  const togglePart = (part: PartId): boolean => {
    const state = engine.toJSON();
    const currentlyVisible = !state.maximizedGroup && Boolean(state.parts[part]?.visible);
    const nextVisible = !currentlyVisible;
    applyPartVisible(deps, part, nextVisible);
    return nextVisible;
  };

  const resetLayout = (): boolean => {
    clearLayoutStorage(deps.storage, deps.storageKey ?? LAYOUT_STORAGE_KEY);
    if (deps.onResetLayout) {
      deps.onResetLayout();
      return true;
    }
    const defaultLayout = deps.getDefaultLayout?.();
    if (defaultLayout) {
      engine.fromJSON(defaultLayout);
      return true;
    }
    engine.exitMaximized();
    applyPartVisible(deps, 'sidebar', true);
    applyPartVisible(deps, 'secondary', false);
    applyPartVisible(deps, 'panel', false);
    return true;
  };

  return [
    {
      id: LAYOUT_COMMAND_IDS.moveViewToSidebar,
      title: tr(deps, 'wb.dock.moveToSidebar', 'Move View to Primary Side Bar'),
      run: (viewId?: unknown) => moveView('sidebar', viewId),
    },
    {
      id: LAYOUT_COMMAND_IDS.moveViewToSecondary,
      title: tr(deps, 'wb.dock.moveToSecondary', 'Move View to Secondary Side Bar'),
      run: (viewId?: unknown) => moveView('secondary', viewId),
    },
    {
      id: LAYOUT_COMMAND_IDS.moveViewToPanel,
      title: tr(deps, 'wb.dock.moveToPanel', 'Move View to Panel'),
      run: (viewId?: unknown) => moveView('panel', viewId),
    },
    {
      id: LAYOUT_COMMAND_IDS.toggleSidebar,
      title: tr(deps, 'wb.cmd.toggleSidebar', 'Toggle Primary Side Bar'),
      keybinding: 'Mod+B',
      run: () => togglePart('sidebar'),
    },
    {
      id: LAYOUT_COMMAND_IDS.toggleSecondary,
      title: tr(deps, 'wb.cmd.toggleSecondary', 'Toggle Secondary Side Bar'),
      keybinding: 'Mod+Alt+B',
      run: () => togglePart('secondary'),
    },
    {
      id: LAYOUT_COMMAND_IDS.togglePanel,
      title: tr(deps, 'wb.cmd.togglePanel', 'Toggle Bottom Panel'),
      keybinding: 'Mod+J',
      run: () => togglePart('panel'),
    },
    {
      id: LAYOUT_COMMAND_IDS.resetLayout,
      title: tr(deps, 'wb.cmd.resetLayout', 'Reset Layout'),
      run: () => resetLayout(),
    },
  ];
}

export function registerLayoutCommands(deps: LayoutCommandsDeps): Disposable {
  const disposables = new DisposableStore();
  let trackedActive: PanelRef | undefined;

  disposables.add(
    deps.engine.onDidActivePanelChange((panel) => {
      trackedActive = panel;
    }),
  );

  const getTrackedActive = (): PanelRef | undefined => deps.getActivePanel?.() ?? trackedActive;
  const specs: readonly CommandSpec[] = [
    ...createEditorCommandSpecs(deps, getTrackedActive),
    ...createPartAndViewCommandSpecs(deps, getTrackedActive),
  ];

  for (const spec of specs) {
    const meta: CommandMetadata = {
      title: spec.title,
      category: 'View',
      ...(spec.keybinding ? { keybinding: spec.keybinding } : {}),
    };
    disposables.add(deps.commands.register(spec.id, spec.run, meta));
    if (spec.keybinding && deps.keybindings) {
      disposables.add(
        deps.keybindings.register({
          keybinding: spec.keybinding,
          command: spec.id,
        }),
      );
    }
  }

  return disposables;
}
