import { describe, expect, it, vi } from 'vitest';
import { Emitter } from '../../base/event.js';
import { toDisposable } from '../../base/lifecycle.js';
import { CommandRegistry } from '../../services/commands.js';
import { KeybindingService } from '../../services/keybindings.js';
import { type StorageLike, StorageService } from '../../services/storage.js';
import type {
  AddPanelOptions,
  DockEngine,
  GridNodeState,
  LayoutState,
  PanelComponent,
  PanelPosition,
  PanelRef,
  PartId,
} from '../contracts.js';
import {
  buildMoveViewMenuItems,
  collectGridLeaves,
  findAdjacentGroup,
  LAYOUT_COMMAND_IDS,
  LAYOUT_STORAGE_KEY,
  registerLayoutCommands,
} from './layout-commands.js';

interface MockPanelRecord {
  readonly id: string;
  group: string | PartId;
  params: unknown;
  focusCount: number;
  readonly ref: PanelRef;
}

class MemoryStorage implements StorageLike {
  private readonly _map = new Map<string, string>();
  get length(): number {
    return this._map.size;
  }
  key(index: number): string | null {
    return [...this._map.keys()][index] ?? null;
  }
  getItem(key: string): string | null {
    return this._map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this._map.set(key, value);
  }
  removeItem(key: string): void {
    this._map.delete(key);
  }
}

class MockDockEngine implements DockEngine {
  readonly onDidLayoutChangeEmitter = new Emitter<void>();
  readonly onDidActivePanelChangeEmitter = new Emitter<PanelRef | undefined>();
  readonly onDidLayoutChange = this.onDidLayoutChangeEmitter.event;
  readonly onDidActivePanelChange = this.onDidActivePanelChangeEmitter.event;

  readonly panels = new Map<string, MockPanelRecord>();
  readonly moveCalls: Array<{ id: string; to: PanelPosition }> = [];
  readonly removedIds: string[] = [];
  readonly partVisibleCalls: Array<{ part: PartId; visible: boolean }> = [];
  readonly fromJsonCalls: LayoutState[] = [];

  parts: LayoutState['parts'] = {
    sidebar: { visible: true, size: 264, panels: [] },
    secondary: { visible: false, size: 420, panels: [] },
    panel: { visible: false, size: 220, panels: [] },
  };
  grid: GridNodeState = { type: 'leaf', group: 'g1', panels: [] };
  activeGroup: string | undefined = 'g1';
  maximizedGroup: string | undefined;

  seedPanel(id: string, group: string | PartId, params?: unknown): PanelRef {
    const vis = new Emitter<boolean>();
    const dim = new Emitter<{ readonly width: number; readonly height: number }>();
    const record: MockPanelRecord = {
      id,
      group,
      params,
      focusCount: 0,
      ref: undefined as unknown as PanelRef,
    };
    const ref: PanelRef = {
      get id() {
        return record.id;
      },
      get group() {
        return record.group;
      },
      get params() {
        return record.params;
      },
      onDidVisibilityChange: vis.event,
      onDidDimensionsChange: dim.event,
      setTitle: () => undefined,
      setBadge: () => undefined,
      focus: () => {
        record.focusCount += 1;
        this.onDidActivePanelChangeEmitter.fire(ref);
      },
      close: () => {
        this.removePanel(record.id);
      },
    };
    (record as { ref: PanelRef }).ref = ref;
    this.panels.set(id, record);
    return ref;
  }

  registerComponent(_name: string, _factory: () => PanelComponent) {
    return toDisposable(() => undefined);
  }

  addPanel(o: AddPanelOptions): PanelRef {
    const group = o.position && 'part' in o.position ? o.position.part : 'g1';
    return this.seedPanel(o.id, group, o.params);
  }

  getPanel(id: string): PanelRef | undefined {
    return this.panels.get(id)?.ref;
  }

  removePanel(id: string): void {
    this.removedIds.push(id);
    this.panels.delete(id);
    this.onDidLayoutChangeEmitter.fire();
  }

  movePanel(id: string, to: PanelPosition): void {
    this.moveCalls.push({ id, to });
    const record = this.panels.get(id);
    if (!record) return;
    if ('part' in to) {
      record.group = to.part;
    } else if ('group' in to) {
      record.group = to.direction && to.direction !== 'within' ? `${to.group}:${to.direction}` : to.group;
    }
    this.onDidLayoutChangeEmitter.fire();
  }

  setPartVisible(part: PartId, visible: boolean): void {
    this.partVisibleCalls.push({ part, visible });
    this.parts = {
      ...this.parts,
      [part]: { ...this.parts[part], visible },
    };
    if (visible && this.maximizedGroup) {
      this.maximizedGroup = undefined;
    }
    this.onDidLayoutChangeEmitter.fire();
  }

  maximizeGroup(group: string): void {
    this.maximizedGroup = group;
    this.onDidLayoutChangeEmitter.fire();
  }

  exitMaximized(): void {
    this.maximizedGroup = undefined;
    this.onDidLayoutChangeEmitter.fire();
  }

  toJSON(): LayoutState {
    const panels: LayoutState['panels'] = {};
    for (const [id, rec] of this.panels) {
      panels[id] = { id, component: 'mock', title: id, params: rec.params };
    }
    return {
      v: 1,
      parts: this.parts,
      grid: this.grid,
      panels,
      ...(this.activeGroup ? { activeGroup: this.activeGroup } : {}),
      ...(this.maximizedGroup ? { maximizedGroup: this.maximizedGroup } : {}),
    };
  }

  fromJSON(state: LayoutState): void {
    this.fromJsonCalls.push(state);
    this.parts = state.parts;
    this.grid = state.grid;
    this.activeGroup = state.activeGroup;
    this.maximizedGroup = state.maximizedGroup;
    this.onDidLayoutChangeEmitter.fire();
  }

  layout(_width: number, _height: number): void {
    // no-op
  }

  dispose(): void {
    this.onDidLayoutChangeEmitter.dispose();
    this.onDidActivePanelChangeEmitter.dispose();
  }
}

function createHarness(opts: {
  isMac?: boolean;
  isSplitAllowed?: () => boolean;
  notify?: (msg: string) => void;
  setPartVisible?: (part: PartId, visible: boolean) => void;
  onResetLayout?: () => void;
  getDefaultLayout?: () => LayoutState | undefined;
  getActiveViewId?: () => string | undefined;
} = {}) {
  const engine = new MockDockEngine();
  const commands = new CommandRegistry();
  const keybindings = new KeybindingService({
    executeCommand: (id, ...args) => commands.execute(id, ...args),
    isMac: opts.isMac ?? false,
  });
  const storage = new StorageService('', new MemoryStorage());
  const reg = registerLayoutCommands({
    engine,
    commands,
    keybindings,
    storage,
    isSplitAllowed: opts.isSplitAllowed,
    notify: opts.notify,
    setPartVisible: opts.setPartVisible,
    onResetLayout: opts.onResetLayout,
    getDefaultLayout: opts.getDefaultLayout,
    getActiveViewId: opts.getActiveViewId,
  });
  return { engine, commands, keybindings, storage, reg };
}

describe('layout-commands', () => {
  describe('grid topology helpers', () => {
    it('collects grid leaves in visual pre-order and finds adjacent groups', () => {
      const grid: GridNodeState = {
        type: 'branch',
        orientation: 'horizontal',
        sizes: [0.5, 0.5],
        children: [
          { type: 'leaf', group: 'g1', panels: ['e1'], activePanel: 'e1' },
          {
            type: 'branch',
            orientation: 'vertical',
            sizes: [0.5, 0.5],
            children: [
              { type: 'leaf', group: 'g2', panels: ['e2'], activePanel: 'e2' },
              { type: 'leaf', group: 'g3', panels: ['e3'], activePanel: 'e3' },
            ],
          },
        ],
      };

      expect(collectGridLeaves(grid).map((l) => l.group)).toEqual(['g1', 'g2', 'g3']);
      expect(findAdjacentGroup(grid, 'g1', 'right')).toBe('g2');
      expect(findAdjacentGroup(grid, 'g2', 'left')).toBe('g1');
      expect(findAdjacentGroup(grid, 'g3', 'left')).toBe('g1');
      expect(findAdjacentGroup(grid, 'g2', 'below')).toBe('g3');
      expect(findAdjacentGroup(grid, 'g3', 'above')).toBe('g2');
      expect(findAdjacentGroup(grid, 'g1', 'left')).toBeUndefined();
      expect(findAdjacentGroup(grid, 'g2', 'right')).toBeUndefined();
    });
  });

  describe('splitEditor & tablet mode guard', () => {
    it('splits active editor right via command and Mod+\\ shortcut', async () => {
      const { engine, keybindings } = createHarness();
      const e1 = engine.seedPanel('ed-1', 'g1');
      engine.grid = { type: 'leaf', group: 'g1', panels: ['ed-1'], activePanel: 'ed-1' };
      e1.focus();

      const handled = keybindings.handleKeydown({ key: '\\', ctrlKey: true });
      expect(handled).toBe(true);
      await Promise.resolve();

      expect(engine.moveCalls).toEqual([{ id: 'ed-1', to: { group: 'g1', direction: 'right' } }]);
    });

    it('degrades to no-op with notice when split is disallowed (tablet mode)', async () => {
      const notify = vi.fn();
      const { engine, commands } = createHarness({
        isSplitAllowed: () => false,
        notify,
      });
      const e1 = engine.seedPanel('ed-1', 'g1');
      engine.grid = { type: 'leaf', group: 'g1', panels: ['ed-1'], activePanel: 'ed-1' };
      e1.focus();

      const result = await commands.execute(LAYOUT_COMMAND_IDS.splitEditor);
      expect(result).toBe(false);
      expect(engine.moveCalls).toEqual([]);
      expect(notify).toHaveBeenCalledTimes(1);
    });
  });

  describe('focusGroup1 / focusGroup2 / focusGroup3', () => {
    it('focuses group 1/2/3 via Mod+1/2/3 shortcuts and ignores missing groups', async () => {
      const { engine, commands, keybindings } = createHarness();
      engine.seedPanel('ed-1', 'g1');
      engine.seedPanel('ed-2', 'g2');
      engine.seedPanel('ed-3', 'g3');
      engine.grid = {
        type: 'branch',
        orientation: 'horizontal',
        sizes: [1, 1, 1],
        children: [
          { type: 'leaf', group: 'g1', panels: ['ed-1'], activePanel: 'ed-1' },
          { type: 'leaf', group: 'g2', panels: ['ed-2'], activePanel: 'ed-2' },
          { type: 'leaf', group: 'g3', panels: ['ed-3'], activePanel: 'ed-3' },
        ],
      };

      expect(keybindings.handleKeydown({ key: '2', ctrlKey: true })).toBe(true);
      expect(keybindings.handleKeydown({ key: '3', ctrlKey: true })).toBe(true);
      expect(keybindings.handleKeydown({ key: '1', ctrlKey: true })).toBe(true);
      await Promise.resolve();

      expect(engine.panels.get('ed-1')?.focusCount).toBe(1);
      expect(engine.panels.get('ed-2')?.focusCount).toBe(1);
      expect(engine.panels.get('ed-3')?.focusCount).toBe(1);

      engine.grid = { type: 'leaf', group: 'g1', panels: ['ed-1'], activePanel: 'ed-1' };
      expect(await commands.execute(LAYOUT_COMMAND_IDS.focusGroup2)).toBe(false);
    });
  });

  describe('moveEditorRight / Left / Down / Up', () => {
    it('moves editor into adjacent group when present, otherwise creates a split', async () => {
      const { engine, commands } = createHarness();
      const e1 = engine.seedPanel('ed-1', 'g1');
      engine.seedPanel('ed-2', 'g2');
      engine.grid = {
        type: 'branch',
        orientation: 'horizontal',
        sizes: [0.5, 0.5],
        children: [
          { type: 'leaf', group: 'g1', panels: ['ed-1'], activePanel: 'ed-1' },
          { type: 'leaf', group: 'g2', panels: ['ed-2'], activePanel: 'ed-2' },
        ],
      };
      e1.focus();

      expect(await commands.execute(LAYOUT_COMMAND_IDS.moveEditorRight)).toBe(true);
      expect(engine.moveCalls[0]).toEqual({ id: 'ed-1', to: { group: 'g2', direction: 'within' } });

      // Moving left from g2 goes back into adjacent g1
      expect(await commands.execute(LAYOUT_COMMAND_IDS.moveEditorLeft)).toBe(true);
      expect(engine.moveCalls[1]).toEqual({ id: 'ed-1', to: { group: 'g1', direction: 'within' } });

      // No group below g1 -> splits below
      expect(await commands.execute(LAYOUT_COMMAND_IDS.moveEditorDown)).toBe(true);
      expect(engine.moveCalls[2]).toEqual({ id: 'ed-1', to: { group: 'g1', direction: 'below' } });

      // Reset to g1 and move up -> splits above
      engine.panels.get('ed-1')!.group = 'g1';
      expect(await commands.execute(LAYOUT_COMMAND_IDS.moveEditorUp)).toBe(true);
      expect(engine.moveCalls[3]).toEqual({ id: 'ed-1', to: { group: 'g1', direction: 'above' } });
    });

    it('blocks splitting move in tablet mode while allowing moves to existing adjacent groups', async () => {
      const notify = vi.fn();
      const { engine, commands } = createHarness({
        isSplitAllowed: () => false,
        notify,
      });
      const e1 = engine.seedPanel('ed-1', 'g1');
      engine.grid = { type: 'leaf', group: 'g1', panels: ['ed-1'], activePanel: 'ed-1' };
      e1.focus();

      expect(await commands.execute(LAYOUT_COMMAND_IDS.moveEditorRight)).toBe(false);
      expect(engine.moveCalls).toEqual([]);
      expect(notify).toHaveBeenCalledTimes(1);
    });
  });

  describe('moveViewTo* commands and buildMoveViewMenuItems', () => {
    it('moves view between sidebar, secondary, and panel and reveals target part', async () => {
      const { engine, commands } = createHarness({
        getActiveViewId: () => 'view-changes',
      });
      engine.seedPanel('view-changes', 'secondary');

      expect(await commands.execute(LAYOUT_COMMAND_IDS.moveViewToPanel)).toBe(true);
      expect(engine.moveCalls.at(-1)).toEqual({ id: 'view-changes', to: { part: 'panel' } });
      expect(engine.parts.panel.visible).toBe(true);

      expect(await commands.execute(LAYOUT_COMMAND_IDS.moveViewToSidebar, 'view-changes')).toBe(true);
      expect(engine.moveCalls.at(-1)).toEqual({ id: 'view-changes', to: { part: 'sidebar' } });
      expect(engine.parts.sidebar.visible).toBe(true);

      // Moving to the same part is a no-op returning false
      expect(await commands.execute(LAYOUT_COMMAND_IDS.moveViewToSidebar, 'view-changes')).toBe(false);
    });

    it('hides current part by default in buildMoveViewMenuItems and executes move on select', () => {
      const engine = new MockDockEngine();
      engine.seedPanel('view-files', 'secondary');

      const items = buildMoveViewMenuItems('view-files', 'secondary', engine);
      expect(items.map((i) => i.targetPart)).toEqual(['sidebar', 'panel']);
      expect(items.every((i) => !i.disabled)).toBe(true);

      items[1]!.onSelect?.();
      expect(engine.moveCalls).toEqual([{ id: 'view-files', to: { part: 'panel' } }]);
      expect(engine.parts.panel.visible).toBe(true);
    });

    it('supports disabling current part instead of hiding it', () => {
      const engine = new MockDockEngine();
      engine.seedPanel('view-terminal', 'panel');

      const items = buildMoveViewMenuItems('view-terminal', 'panel', engine, {
        currentPartBehavior: 'disable',
      });
      expect(items.map((i) => ({ part: i.targetPart, disabled: i.disabled }))).toEqual([
        { part: 'sidebar', disabled: false },
        { part: 'secondary', disabled: false },
        { part: 'panel', disabled: true },
      ]);

      items[2]!.onSelect?.();
      expect(engine.moveCalls).toEqual([]);
    });
  });

  describe('toggleMaximizeGroup & closeActiveEditor', () => {
    it('maximizes active group and restores on second toggle', async () => {
      const { engine, commands } = createHarness();
      const e1 = engine.seedPanel('ed-1', 'g2');
      engine.grid = { type: 'leaf', group: 'g2', panels: ['ed-1'], activePanel: 'ed-1' };
      e1.focus();

      expect(await commands.execute(LAYOUT_COMMAND_IDS.toggleMaximizeGroup)).toBe(true);
      expect(engine.maximizedGroup).toBe('g2');

      expect(await commands.execute(LAYOUT_COMMAND_IDS.toggleMaximizeGroup)).toBe(false);
      expect(engine.maximizedGroup).toBeUndefined();
    });

    it('closes active editor panel', async () => {
      const { engine, commands } = createHarness();
      const e1 = engine.seedPanel('ed-1', 'g1');
      engine.grid = { type: 'leaf', group: 'g1', panels: ['ed-1'], activePanel: 'ed-1' };
      e1.focus();

      expect(await commands.execute(LAYOUT_COMMAND_IDS.closeActiveEditor)).toBe(true);
      expect(engine.removedIds).toEqual(['ed-1']);

      // No remaining editor panel
      expect(await commands.execute(LAYOUT_COMMAND_IDS.closeActiveEditor)).toBe(false);
    });
  });

  describe('toggleSidebar / toggleSecondary / togglePanel', () => {
    it('toggles all three parts via commands and Mod+B / Mod+Alt+B / Mod+J shortcuts', async () => {
      const { engine, keybindings } = createHarness();
      expect(engine.parts.sidebar.visible).toBe(true);
      expect(engine.parts.secondary.visible).toBe(false);
      expect(engine.parts.panel.visible).toBe(false);

      expect(keybindings.handleKeydown({ key: 'b', ctrlKey: true })).toBe(true);
      expect(keybindings.handleKeydown({ key: 'b', ctrlKey: true, altKey: true })).toBe(true);
      expect(keybindings.handleKeydown({ key: 'j', ctrlKey: true })).toBe(true);
      await Promise.resolve();

      expect(engine.parts.sidebar.visible).toBe(false);
      expect(engine.parts.secondary.visible).toBe(true);
      expect(engine.parts.panel.visible).toBe(true);
    });
  });

  describe('resetLayout', () => {
    it('clears aa_layout storage and restores default visibility when no custom hook is given', async () => {
      const { engine, commands, storage } = createHarness();
      storage.setRaw(LAYOUT_STORAGE_KEY, '{"v":1}');
      engine.setPartVisible('sidebar', false);
      engine.setPartVisible('secondary', true);
      engine.setPartVisible('panel', true);
      engine.maximizeGroup('g1');

      expect(await commands.execute(LAYOUT_COMMAND_IDS.resetLayout)).toBe(true);
      expect(storage.getRaw(LAYOUT_STORAGE_KEY)).toBeNull();
      expect(engine.maximizedGroup).toBeUndefined();
      expect(engine.parts.sidebar.visible).toBe(true);
      expect(engine.parts.secondary.visible).toBe(false);
      expect(engine.parts.panel.visible).toBe(false);
    });

    it('invokes getDefaultLayout and engine.fromJSON when provided', async () => {
      const defaultState: LayoutState = {
        v: 1,
        parts: {
          sidebar: { visible: true, size: 264, panels: ['topics'], activePanel: 'topics' },
          secondary: { visible: false, size: 420, panels: [] },
          panel: { visible: false, size: 220, panels: [] },
        },
        grid: { type: 'leaf', group: 'main', panels: [] },
        panels: {},
        activeGroup: 'main',
      };
      const { engine, commands, storage } = createHarness({
        getDefaultLayout: () => defaultState,
      });
      storage.setRaw(LAYOUT_STORAGE_KEY, '{"v":1}');

      expect(await commands.execute(LAYOUT_COMMAND_IDS.resetLayout)).toBe(true);
      expect(storage.getRaw(LAYOUT_STORAGE_KEY)).toBeNull();
      expect(engine.fromJsonCalls).toEqual([defaultState]);
    });

    it('invokes onResetLayout hook when provided', async () => {
      const onResetLayout = vi.fn();
      const { commands, storage } = createHarness({ onResetLayout });
      storage.setRaw(LAYOUT_STORAGE_KEY, '{"v":1}');

      expect(await commands.execute(LAYOUT_COMMAND_IDS.resetLayout)).toBe(true);
      expect(storage.getRaw(LAYOUT_STORAGE_KEY)).toBeNull();
      expect(onResetLayout).toHaveBeenCalledTimes(1);
    });
  });

  describe('dispose', () => {
    it('unregisters all commands and keybindings on dispose', () => {
      const { commands, keybindings, reg } = createHarness();
      const allIds = Object.values(LAYOUT_COMMAND_IDS);
      for (const id of allIds) {
        expect(commands.has(id)).toBe(true);
      }

      reg.dispose();

      for (const id of allIds) {
        expect(commands.has(id)).toBe(false);
      }
      expect(keybindings.handleKeydown({ key: '\\', ctrlKey: true })).toBe(false);
      expect(keybindings.handleKeydown({ key: '1', ctrlKey: true })).toBe(false);
      expect(keybindings.handleKeydown({ key: 'b', ctrlKey: true })).toBe(false);
      expect(keybindings.handleKeydown({ key: 'j', ctrlKey: true })).toBe(false);
    });
  });
});
