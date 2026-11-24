import { addDisposableListener } from '../../base/dom.js';
import { Emitter, type Event } from '../../base/event.js';
import { type Disposable, DisposableStore, toDisposable } from '../../base/lifecycle.js';
import type { OverlayManager } from '../../services/overlays.js';
import type {
  AddPanelOptions,
  Direction,
  DockEngine,
  LayoutState,
  PanelComponent,
  PanelLayoutState,
  PanelPosition,
  PanelRef,
  PartId,
  PartLayoutState,
} from '../contracts.js';
import {
  DockDndController,
  type DndRect,
  type DockDropZoneSnapshot,
  type DragPayload,
  type DropTarget,
  dropTargetToPanelPosition,
  type GroupDropArea,
  type PartDropArea,
} from './dnd.js';
import { createLeafNode, GridView, listGroups, type SplitDirection } from './gridview.js';
import type { EditorGroup, EditorGroupOptions, EditorGroupTabDragStartEvent } from './group.js';
import {
  createDefaultLayoutState,
  DEFAULT_GROUP_ID,
  DEFAULT_PART_LAYOUT,
  LAYOUT_STORAGE_KEY,
  type LayoutStorage,
  loadSavedLayout,
  migrateLayoutState,
  pruneMissingComponents,
  resetSavedLayout,
  saveLayout,
} from './serialize.js';
import type { SplitView } from './splitview.js';

export const MAIN_GROUP_ID = DEFAULT_GROUP_ID;

const PART_IDS: readonly PartId[] = ['sidebar', 'secondary', 'panel'];
const TOPIC_COMPONENT_NAMES = new Set(['topic', 'editor:topic', 'chat', 'editor:chat']);

export interface DockTabInfo {
  readonly id: string;
  readonly title: string;
  readonly badge: number | null;
}

export interface DockPartHost {
  readonly element?: HTMLElement;
  readonly header?: HTMLElement;
  readonly body: HTMLElement;
  setVisible?(visible: boolean): void;
  setTabs?(tabs: readonly DockTabInfo[], activeId: string | undefined): void;
}

export interface DynamicDockOptions {
  readonly doc?: Document;
  readonly editorContainer?: HTMLElement;
  readonly dndHost?: HTMLElement;
  readonly overlays?: OverlayManager;
  readonly parts?: Partial<Record<PartId, DockPartHost>>;
  readonly partSizes?: Partial<Record<PartId, number>>;
  readonly initialVisible?: Partial<Record<PartId, boolean>>;
  readonly splitView?: SplitView;
  readonly storage?: LayoutStorage;
  readonly storageKey?: string;
  readonly allowSplit?: boolean;
  readonly dndThresholdPx?: number;
  readonly minGroupSize?: number;
  readonly resolveIcon?: (name: string) => string;
  readonly renderSingleHeader?: EditorGroupOptions['renderSingleHeader'];
  readonly resolveTopicId?: (panel: PanelRef, componentName: string) => string | undefined;
  readonly defaultLayout?: () => LayoutState;
}

interface PartState {
  visible: boolean;
  size: number;
  panels: string[];
  activePanel: string | undefined;
}

interface PartManagedPanel {
  readonly id: string;
  readonly componentName: string;
  title: string;
  badge: number | null;
  params: unknown;
  group: PartId;
  readonly component: PanelComponent;
  readonly ref: PanelRef;
  readonly visibilityEmitter: Emitter<boolean>;
  readonly dimensionsEmitter: Emitter<{ readonly width: number; readonly height: number }>;
  visible: boolean;
  lastWidth: number;
  lastHeight: number;
}

function isPartId(value: string): value is PartId {
  return value === 'sidebar' || value === 'secondary' || value === 'panel';
}

function isSplitDirection(dir: Direction): dir is SplitDirection {
  return dir === 'left' || dir === 'right' || dir === 'above' || dir === 'below';
}

function toDndRect(rect: DOMRect): DndRect {
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}

function hasPositiveArea(rect: DndRect): boolean {
  return rect.width > 0 && rect.height > 0;
}

export function extractTopicId(componentName: string, params: unknown): string | undefined {
  if (typeof params === 'object' && params !== null && !Array.isArray(params)) {
    const record = params as Record<string, unknown>;
    if (typeof record.topicId === 'string' && record.topicId.trim().length > 0) {
      return record.topicId;
    }
    if (
      TOPIC_COMPONENT_NAMES.has(componentName) &&
      typeof record.id === 'string' &&
      record.id.trim().length > 0
    ) {
      return record.id;
    }
  }
  if (TOPIC_COMPONENT_NAMES.has(componentName) && typeof params === 'string' && params.trim().length > 0) {
    return params;
  }
  return undefined;
}

function createInitialParts(options: DynamicDockOptions): Record<PartId, PartState> {
  const parts = {} as Record<PartId, PartState>;
  for (const partId of PART_IDS) {
    const def = DEFAULT_PART_LAYOUT[partId];
    const size = options.partSizes?.[partId];
    parts[partId] = {
      visible: options.initialVisible?.[partId] ?? def.visible,
      size: size !== undefined && Number.isFinite(size) && size >= 0 ? Math.round(size) : def.size,
      panels: [],
      activePanel: undefined,
    };
  }
  return parts;
}

export class DynamicDockEngine implements DockEngine {
  private readonly _doc: Document;
  private readonly _editorContainer: HTMLElement;
  private readonly _partHosts: Partial<Record<PartId, DockPartHost>>;
  private readonly _splitView?: SplitView;
  private readonly _storage?: LayoutStorage;
  private readonly _storageKey: string;
  private readonly _resolveIcon?: (name: string) => string;
  private readonly _renderSingleHeader?: EditorGroupOptions['renderSingleHeader'];
  private readonly _resolveTopicId?: DynamicDockOptions['resolveTopicId'];
  private readonly _defaultLayoutFactory?: () => LayoutState;
  private readonly _initialOptions: DynamicDockOptions;

  private readonly _gridView: GridView;
  private readonly _dnd: DockDndController;
  private readonly _factories = new Map<string, () => PanelComponent>();
  private readonly _partPanels = new Map<string, PartManagedPanel>();
  private readonly _editorPanelGroup = new Map<string, string>();
  private readonly _groupSubs = new Map<string, DisposableStore>();
  private readonly _parts: Record<PartId, PartState>;

  private _activePanelId: string | undefined;
  private _activeTopicId: string | undefined;
  private _maximizedGroup: string | undefined;
  private _pendingGroupDrag: DragPayload | null = null;
  private _pendingPartDrag: DragPayload | null = null;
  private _width = 0;
  private _height = 0;
  private _suppressEvents = false;
  private _disposed = false;

  private readonly _disposables = new DisposableStore();
  private readonly _onDidLayoutChange = new Emitter<void>();
  private readonly _onDidActivePanelChange = new Emitter<PanelRef | undefined>();
  private readonly _onDidActiveTopicChange = new Emitter<string | undefined>();

  readonly onDidLayoutChange: Event<void> = this._onDidLayoutChange.event;
  readonly onDidActivePanelChange: Event<PanelRef | undefined> = this._onDidActivePanelChange.event;
  readonly onDidActiveTopicChange: Event<string | undefined> = this._onDidActiveTopicChange.event;

  constructor(options: DynamicDockOptions = {}) {
    this._initialOptions = options;
    this._doc = options.doc ?? options.editorContainer?.ownerDocument ?? document;
    this._editorContainer = options.editorContainer ?? this._doc.createElement('div');
    this._partHosts = options.parts ?? {};
    this._splitView = options.splitView;
    this._storage = options.storage;
    this._storageKey = options.storageKey ?? LAYOUT_STORAGE_KEY;
    this._resolveIcon = options.resolveIcon;
    this._renderSingleHeader = options.renderSingleHeader;
    this._resolveTopicId = options.resolveTopicId;
    this._defaultLayoutFactory = options.defaultLayout;
    this._parts = createInitialParts(options);

    this._dnd = new DockDndController({
      doc: this._doc,
      host: options.dndHost ?? this._doc.body,
      overlays: options.overlays,
      allowSplit: options.allowSplit ?? true,
      thresholdPx: options.dndThresholdPx,
      getDropZones: (payload) => this._collectDropZones(payload),
      onDrop: (payload, target) => this._handleDrop(payload, target),
    });

    this._gridView = new GridView({
      container: this._editorContainer,
      doc: this._doc,
      initialTree: createLeafNode(MAIN_GROUP_ID),
      minGroupSize: options.minGroupSize,
      createGroupOptions: () => ({
        resolveIcon: this._resolveIcon,
        renderSingleHeader: this._renderSingleHeader,
        onTabPointerDown: (info) => this._onGroupTabPointerDown(info),
      }),
    });

    this._disposables.add(this._onDidLayoutChange);
    this._disposables.add(this._onDidActivePanelChange);
    this._disposables.add(this._onDidActiveTopicChange);
    this._disposables.add(this._dnd);
    this._disposables.add(this._gridView);

    this._wireGridView();
    this._wirePartDnd();
    this._wireSplitView();
    this._syncGroupSubscriptions();
    this._syncPartHostVisibility();
  }

  getGridView(): GridView {
    return this._gridView;
  }

  getDndController(): DockDndController {
    return this._dnd;
  }

  getGroups(): readonly EditorGroup[] {
    return this._gridView.getGroups();
  }

  getGroup(groupId: string): EditorGroup | undefined {
    return this._gridView.getGroup(groupId);
  }

  getActiveGroupId(): string | undefined {
    return this._gridView.getActiveGroupId();
  }

  setActiveGroup(groupId: string): void {
    this._gridView.setActiveGroup(groupId);
  }

  getActiveTopicId(): string | undefined {
    return this._activeTopicId;
  }

  setAllowSplit(allow: boolean): void {
    this._dnd.setAllowSplit(allow);
  }

  getAllowSplit(): boolean {
    return this._dnd.allowSplit;
  }

  isPartVisible(part: PartId): boolean {
    if (this._maximizedGroup) return false;
    return this._parts[part].visible;
  }

  getPartSize(part: PartId): number {
    return this._parts[part].size;
  }

  setPartSize(part: PartId, size: number): void {
    if (!Number.isFinite(size) || size < 0) return;
    const rounded = Math.round(size);
    if (this._parts[part].size === rounded) return;
    this._parts[part].size = rounded;
    if (part === 'sidebar' || part === 'secondary') {
      this._splitView?.setPaneSize(part, rounded);
    }
    this._applyDimensions();
    this._emitLayoutChange();
  }

  getPartPanels(part: PartId): readonly string[] {
    return this._parts[part].panels;
  }

  getActivePartPanel(part: PartId): string | undefined {
    return this._parts[part].activePanel;
  }

  getGroupPanels(groupId?: string): readonly string[] {
    const group = groupId ? this._gridView.getGroup(groupId) : this._gridView.getActiveGroup();
    return group ? group.getPanelIds() : [];
  }

  getActiveGroupPanel(groupId?: string): string | undefined {
    const group = groupId ? this._gridView.getGroup(groupId) : this._gridView.getActiveGroup();
    return group?.activePanelId;
  }

  isMaximized(): boolean {
    return this._maximizedGroup !== undefined;
  }

  registerComponent(name: string, factory: () => PanelComponent): Disposable {
    if (this._factories.has(name)) {
      throw new Error(`Dock component already registered: ${name}`);
    }
    this._factories.set(name, factory);
    return toDisposable(() => {
      if (this._factories.get(name) === factory) {
        this._factories.delete(name);
      }
    });
  }

  addPanel(o: AddPanelOptions): PanelRef {
    if (this._disposed) throw new Error('DynamicDockEngine is disposed');

    const existing = this._updateExistingPanel(o);
    if (existing) return existing;

    const factory = this._factories.get(o.component);
    if (!factory) {
      throw new Error(`Unknown dock component: ${o.component}`);
    }

    const resolved = this._resolveAddPosition(o.position);
    if (resolved.kind === 'part') {
      return this._addPartPanel(o, factory, resolved.part, resolved.index);
    }
    return this._addEditorPanel(o, factory, resolved.groupId, resolved.direction, resolved.index);
  }

  getPanel(id: string): PanelRef | undefined {
    const partPanel = this._partPanels.get(id);
    if (partPanel) return partPanel.ref;
    const groupId = this._editorPanelGroup.get(id);
    if (!groupId) return undefined;
    return this._gridView.getGroup(groupId)?.getPanel(id);
  }

  removePanel(id: string): void {
    if (this._partPanels.has(id)) {
      this._removePartPanel(id);
      return;
    }
    const groupId = this._editorPanelGroup.get(id);
    if (!groupId) return;
    const group = this._gridView.getGroup(groupId);
    if (!group) {
      this._editorPanelGroup.delete(id);
      return;
    }
    this._editorPanelGroup.delete(id);
    group.removePanel(id);
    this._cleanupEmptyGroup(groupId);
    this._refreshActiveAfterRemoval(groupId);
    this._emitLayoutChange();
  }

  movePanel(id: string, to: PanelPosition): void {
    if (this._disposed) return;
    const partPanel = this._partPanels.get(id);
    if (partPanel) {
      this._movePartPanel(partPanel, to);
      return;
    }
    const sourceGroupId = this._editorPanelGroup.get(id);
    if (!sourceGroupId) return;
    this._moveEditorPanel(id, sourceGroupId, to);
  }

  setPartVisible(part: PartId, visible: boolean): void {
    const state = this._parts[part];
    if (state.visible === visible) return;

    if (!visible) {
      this._rememberPartSize(part);
    }
    state.visible = visible;
    if (visible && this._maximizedGroup) {
      this._maximizedGroup = undefined;
      this._gridView.exitMaximized();
    }
    if (part === 'sidebar' || part === 'secondary') {
      if (visible && state.size > 0) {
        this._splitView?.setPaneSize(part, state.size);
      }
      this._splitView?.setPaneVisible(part, visible);
    }

    this._syncAllParts();
    this._applyDimensions();
    this._emitLayoutChange();
  }

  maximizeGroup(group: string): void {
    const target = this._gridView.getGroup(group)?.id ?? this._gridView.getActiveGroupId() ?? MAIN_GROUP_ID;
    if (!this._gridView.getGroup(target) || this._maximizedGroup === target) return;

    for (const partId of PART_IDS) {
      if (this._parts[partId].visible) this._rememberPartSize(partId);
    }
    this._maximizedGroup = target;
    this._gridView.maximizeGroup(target);
    this._syncAllParts();
    this._applyDimensions();
    this._emitLayoutChange();
  }

  exitMaximized(): void {
    if (!this._maximizedGroup) return;
    this._maximizedGroup = undefined;
    this._gridView.exitMaximized();
    this._syncAllParts();
    this._applyDimensions();
    this._emitLayoutChange();
  }

  toJSON(): LayoutState {
    const parts = {} as Record<PartId, PartLayoutState>;
    for (const partId of PART_IDS) {
      const p = this._parts[partId];
      parts[partId] = {
        visible: p.visible,
        size: p.size,
        panels: [...p.panels],
        ...(p.activePanel !== undefined ? { activePanel: p.activePanel } : {}),
      };
    }

    const panels: Record<string, PanelLayoutState> = {};
    for (const [id, p] of this._partPanels) {
      panels[id] = {
        id: p.id,
        component: p.componentName,
        title: p.title,
        ...(p.params !== undefined ? { params: p.params } : {}),
      };
    }
    for (const group of this._gridView.getGroups()) {
      for (const tab of group.getPanels()) {
        panels[tab.id] = {
          id: tab.id,
          component: tab.componentName,
          title: tab.title,
          ...(tab.params !== undefined ? { params: tab.params } : {}),
        };
      }
    }

    const activeGroup = this._gridView.getActiveGroupId();
    const maximizedGroup = this._maximizedGroup;
    return {
      v: 1,
      parts,
      grid: this._gridView.getTree(),
      panels,
      ...(activeGroup !== undefined ? { activeGroup } : {}),
      ...(maximizedGroup !== undefined ? { maximizedGroup } : {}),
    };
  }

  fromJSON(state: LayoutState): void {
    if (this._disposed) return;
    const migrated = migrateLayoutState(state);
    if (!migrated) {
      this._applyDefaultLayout();
      return;
    }

    const pruned = pruneMissingComponents(migrated, new Set(this._factories.keys()));
    this._suppressEvents = true;
    try {
      this._restorePrunedLayout(pruned);
    } catch {
      this._applyDefaultLayoutInternal();
    } finally {
      this._suppressEvents = false;
    }

    this._syncAllParts();
    this._applyDimensions();
    this._syncActiveFromActiveGroup();
    this._emitLayoutChange();
  }

  saveToStorage(storage: LayoutStorage | undefined = this._storage): boolean {
    if (!storage) return false;
    return saveLayout(storage, this.toJSON(), this._storageKey);
  }

  restoreFromStorage(storage: LayoutStorage | undefined = this._storage): boolean {
    if (!storage) return false;
    const saved = loadSavedLayout(storage, new Set(this._factories.keys()), this._storageKey);
    if (!saved) return false;
    this.fromJSON(saved);
    return true;
  }

  resetSavedStorage(storage: LayoutStorage | undefined = this._storage): boolean {
    if (!storage) return false;
    return resetSavedLayout(storage, this._storageKey);
  }

  resetToDefaultLayout(): void {
    this._applyDefaultLayout();
  }

  layout(width: number, height: number): void {
    this._width = Math.max(0, Math.round(Number.isFinite(width) ? width : 0));
    this._height = Math.max(0, Math.round(Number.isFinite(height) ? height : 0));
    this._applyDimensions();
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this._clearPartPanels();
    for (const sub of this._groupSubs.values()) {
      sub.dispose();
    }
    this._groupSubs.clear();
    this._editorPanelGroup.clear();
    this._factories.clear();
    this._disposables.dispose();
  }

  private _wireGridView(): void {
    this._disposables.add(
      this._gridView.onDidActiveGroupChange((group) => {
        if (this._suppressEvents) return;
        this._setActivePanel(group?.activePanel);
        this._syncActiveTopicFromPanel(group?.activePanel, group);
      }),
    );
    this._disposables.add(
      this._gridView.onDidLayoutChange(() => {
        this._syncGroupSubscriptions();
        this._emitLayoutChange();
      }),
    );
  }

  private _wireSplitView(): void {
    if (!this._splitView) return;
    this._disposables.add(
      this._splitView.onDidChange(() => {
        for (const partId of ['sidebar', 'secondary'] as const) {
          if (!this.isPartVisible(partId)) continue;
          const sz = this._splitView?.getPreferredPaneSize(partId) ?? 0;
          if (sz > 0) this._parts[partId].size = Math.round(sz);
        }
        this._applyDimensions();
      }),
    );
  }

  private _wirePartDnd(): void {
    for (const partId of PART_IDS) {
      const host = this._partHosts[partId];
      const dragRoot = host?.element ?? host?.header;
      if (!dragRoot) continue;

      this._disposables.add(
        addDisposableListener(dragRoot, 'pointerdown', (ev) => {
          this._preparePartDrag(partId, ev);
        }),
      );
      this._disposables.add(
        this._dnd.attachSource(dragRoot, () => this._consumePartDragPayload(partId)),
      );
    }
  }

  private _preparePartDrag(partId: PartId, ev: PointerEvent): void {
    this._pendingPartDrag = null;
    if (ev.pointerType === 'mouse' && ev.button !== 0) return;
    const target = ev.target;
    if (!(target instanceof Element)) return;
    if (target.closest('.wb-part-close, [data-dnd-ignore]')) return;

    const tabEl = target.closest<HTMLElement>('.wb-part-tab[data-panel-id]');
    if (tabEl?.dataset.panelId) {
      const panel = this._partPanels.get(tabEl.dataset.panelId);
      if (panel && panel.group === partId) {
        this._pendingPartDrag = {
          kind: 'view',
          panelId: panel.id,
          title: panel.title,
          sourcePart: partId,
        };
      }
      return;
    }

    if (target.closest('.wb-part-head') && !target.closest('button')) {
      const activeId = this._parts[partId].activePanel;
      const panel = activeId ? this._partPanels.get(activeId) : undefined;
      if (panel) {
        this._pendingPartDrag = {
          kind: 'view',
          panelId: panel.id,
          title: panel.title,
          sourcePart: partId,
        };
      }
    }
  }

  private _consumePartDragPayload(partId: PartId): DragPayload | null {
    const payload = this._pendingPartDrag;
    this._pendingPartDrag = null;
    if (!payload || payload.sourcePart !== partId) return null;
    return payload;
  }

  private _onGroupTabPointerDown(info: EditorGroupTabDragStartEvent): void {
    const group = this._gridView.getGroup(info.groupId);
    const tab = group?.getPanels().find((p) => p.id === info.panelId);
    this._pendingGroupDrag = {
      kind: 'tab',
      panelId: info.panelId,
      title: tab?.title ?? info.panelId,
      sourceGroup: info.groupId,
    };
  }

  private _consumeGroupDragPayload(group: EditorGroup): DragPayload | null {
    const pending = this._pendingGroupDrag;
    this._pendingGroupDrag = null;
    if (pending && pending.sourceGroup === group.id) return pending;

    if (group.size === 1 && group.activePanelId) {
      const tab = group.getPanels()[0];
      if (tab) {
        return {
          kind: 'tab',
          panelId: tab.id,
          title: tab.title,
          sourceGroup: group.id,
        };
      }
    }
    return null;
  }

  private _syncGroupSubscriptions(): void {
    const activeIds = new Set(this._gridView.getGroups().map((g) => g.id));
    for (const [id, sub] of this._groupSubs) {
      if (!activeIds.has(id)) {
        sub.dispose();
        this._groupSubs.delete(id);
      }
    }
    for (const group of this._gridView.getGroups()) {
      if (this._groupSubs.has(group.id)) continue;
      this._subscribeGroup(group);
    }
  }

  private _subscribeGroup(group: EditorGroup): void {
    const sub = new DisposableStore();
    sub.add(
      group.onDidActivePanelChange((ref) => {
        if (this._suppressEvents) return;
        if (this._gridView.getActiveGroupId() === group.id) {
          this._setActivePanel(ref);
          this._syncActiveTopicFromPanel(ref, group);
        }
      }),
    );
    sub.add(
      group.onDidFocus(() => {
        if (this._suppressEvents) return;
        this._setActivePanel(group.activePanel);
        this._syncActiveTopicFromPanel(group.activePanel, group);
      }),
    );
    sub.add(
      group.onDidClosePanel((panelId) => {
        this._editorPanelGroup.delete(panelId);
        if (this._suppressEvents) return;
        this._cleanupEmptyGroup(group.id);
        this._refreshActiveAfterRemoval(group.id);
        this._emitLayoutChange();
      }),
    );
    sub.add(
      group.onDidChange(() => {
        this._emitLayoutChange();
      }),
    );
    sub.add(
      this._dnd.attachSource(group.headerElement, () => this._consumeGroupDragPayload(group)),
    );
    this._groupSubs.set(group.id, sub);
  }

  private _collectDropZones(payload: DragPayload): DockDropZoneSnapshot {
    if (payload.kind === 'view') {
      const parts: PartDropArea[] = [];
      for (const partId of PART_IDS) {
        const host = this._partHosts[partId];
        if (!host) continue;
        const tabRoot = host.element ?? host.header;
        const tabRects = tabRoot
          ? [...tabRoot.querySelectorAll<HTMLElement>('.wb-part-tab')]
              .map((el) => toDndRect(el.getBoundingClientRect()))
              .filter(hasPositiveArea)
          : [];
        if (host.header) {
          const headRect = toDndRect(host.header.getBoundingClientRect());
          if (hasPositiveArea(headRect)) {
            parts.push({ part: partId, region: 'header', rect: headRect, tabRects });
          }
        }
        const bodyEl = host.body ?? host.element;
        if (bodyEl) {
          const bodyRect = toDndRect(bodyEl.getBoundingClientRect());
          if (hasPositiveArea(bodyRect)) {
            parts.push({ part: partId, region: 'body', rect: bodyRect });
          }
        }
      }
      return { parts };
    }

    const groups: GroupDropArea[] = [];
    for (const group of this._gridView.getGroups()) {
      const rect = toDndRect(group.element.getBoundingClientRect());
      if (!hasPositiveArea(rect)) continue;
      const headRect = toDndRect(group.headerElement.getBoundingClientRect());
      const tabRects = [...group.headerElement.querySelectorAll<HTMLElement>('.wb-tab')]
        .map((el) => toDndRect(el.getBoundingClientRect()))
        .filter(hasPositiveArea);
      groups.push({
        group: group.id,
        rect,
        ...(hasPositiveArea(headRect) ? { tabBarRect: headRect } : {}),
        tabRects,
      });
    }
    return { groups };
  }

  private _handleDrop(payload: DragPayload, target: DropTarget): void {
    const pos = dropTargetToPanelPosition(target);
    this.movePanel(payload.panelId, pos);
  }

  private _updateExistingPanel(o: AddPanelOptions): PanelRef | undefined {
    const partPanel = this._partPanels.get(o.id);
    if (partPanel) {
      partPanel.title = o.title;
      partPanel.params = o.params;
      partPanel.component.update?.(o.params);
      this._focusPartPanel(partPanel.id);
      return partPanel.ref;
    }

    const groupId = this._editorPanelGroup.get(o.id);
    if (!groupId) return undefined;
    const group = this._gridView.getGroup(groupId);
    if (!group) return undefined;

    const ref = group.addPanel({
      id: o.id,
      componentName: o.component,
      component: undefined as unknown as PanelComponent,
      title: o.title,
      params: o.params,
      activate: true,
    });
    this._gridView.setActiveGroup(groupId);
    this._setActivePanel(ref);
    this._syncActiveTopicFromPanel(ref, group);
    this._emitLayoutChange();
    return ref;
  }

  private _resolveAddPosition(
    position?: PanelPosition,
  ):
    | { readonly kind: 'part'; readonly part: PartId; readonly index?: number }
    | {
        readonly kind: 'group';
        readonly groupId: string;
        readonly direction: Direction;
        readonly index?: number;
      } {
    const fallbackGroup = this._gridView.getActiveGroupId() ?? this._gridView.getGroups()[0]?.id ?? MAIN_GROUP_ID;
    if (!position) {
      return { kind: 'group', groupId: fallbackGroup, direction: 'within' };
    }
    if ('part' in position) {
      return { kind: 'part', part: position.part, index: position.index };
    }
    if ('group' in position) {
      const targetGroup = this._gridView.getGroup(position.group)?.id ?? fallbackGroup;
      return {
        kind: 'group',
        groupId: targetGroup,
        direction: position.direction ?? 'within',
        index: position.index,
      };
    }

    const refPart = this._partPanels.get(position.referencePanel);
    if (refPart) {
      return { kind: 'part', part: refPart.group };
    }
    const refGroup = this._editorPanelGroup.get(position.referencePanel);
    return {
      kind: 'group',
      groupId: refGroup ?? fallbackGroup,
      direction: position.direction,
    };
  }

  private _addPartPanel(
    o: AddPanelOptions,
    factory: () => PanelComponent,
    part: PartId,
    index?: number,
  ): PanelRef {
    const component = factory();
    const visibilityEmitter = new Emitter<boolean>();
    const dimensionsEmitter = new Emitter<{ readonly width: number; readonly height: number }>();

    const managed: PartManagedPanel = {
      id: o.id,
      componentName: o.component,
      title: o.title,
      badge: null,
      params: o.params,
      group: part,
      component,
      ref: undefined as unknown as PanelRef,
      visibilityEmitter,
      dimensionsEmitter,
      visible: false,
      lastWidth: -1,
      lastHeight: -1,
    };

    const ref: PanelRef = {
      get id() {
        return managed.id;
      },
      get group() {
        return managed.group;
      },
      get params() {
        return managed.params;
      },
      onDidVisibilityChange: visibilityEmitter.event,
      onDidDimensionsChange: dimensionsEmitter.event,
      setTitle: (title: string) => {
        if (managed.title === title) return;
        managed.title = title;
        this._renderPartHeaders();
        this._emitLayoutChange();
      },
      setBadge: (n: number | null) => {
        if (managed.badge === n) return;
        managed.badge = n;
        this._renderPartHeaders();
      },
      focus: () => {
        this._focusPartPanel(managed.id);
      },
      close: () => {
        this.removePanel(managed.id);
      },
    };
    (managed as { ref: PanelRef }).ref = ref;

    this._partPanels.set(o.id, managed);
    this._insertIntoPart(part, o.id, index);
    this._mountPartPanelElement(managed);
    component.init(o.params, { id: o.id, api: ref });
    this._parts[part].activePanel = o.id;
    this._setActivePanel(ref);
    this._syncAllParts();
    this._applyDimensions();
    this._emitLayoutChange();
    return ref;
  }

  private _addEditorPanel(
    o: AddPanelOptions,
    factory: () => PanelComponent,
    targetGroupId: string,
    direction: Direction,
    index?: number,
  ): PanelRef {
    let targetGroup = this._gridView.getGroup(targetGroupId) ?? this._gridView.getActiveGroup();
    if (!targetGroup) {
      this._gridView.setTree(createLeafNode(MAIN_GROUP_ID), MAIN_GROUP_ID);
      targetGroup = this._gridView.getGroups()[0]!;
    }

    if (isSplitDirection(direction)) {
      const created = this._gridView.splitGroup(targetGroup.id, direction);
      if (created) {
        targetGroup = created;
        this._syncGroupSubscriptions();
      }
    }

    const component = factory();
    const ref = targetGroup.addPanel({
      id: o.id,
      componentName: o.component,
      component,
      title: o.title,
      params: o.params,
      index,
      activate: true,
    });
    this._editorPanelGroup.set(o.id, targetGroup.id);
    this._gridView.setActiveGroup(targetGroup.id);
    this._setActivePanel(ref);
    this._syncActiveTopicFromPanel(ref, targetGroup);
    this._applyDimensions();
    this._emitLayoutChange();
    return ref;
  }

  private _removePartPanel(id: string): void {
    const panel = this._partPanels.get(id);
    if (!panel) return;
    const prevPart = panel.group;
    this._detachFromPart(prevPart, id);
    this._partPanels.delete(id);

    if (panel.visible) {
      panel.visible = false;
      panel.visibilityEmitter.fire(false);
    }
    panel.component.element.remove();
    panel.component.dispose();
    panel.visibilityEmitter.dispose();
    panel.dimensionsEmitter.dispose();

    if (this._activePanelId === id) {
      const nextPartPanel = this._parts[prevPart].activePanel;
      const fallback = nextPartPanel
        ? this._partPanels.get(nextPartPanel)?.ref
        : this._gridView.getActiveGroup()?.activePanel;
      this._setActivePanel(fallback);
    }

    this._syncAllParts();
    this._applyDimensions();
    this._emitLayoutChange();
  }

  private _movePartPanel(panel: PartManagedPanel, to: PanelPosition): void {
    let targetPart: PartId | undefined;
    let index: number | undefined;
    if ('part' in to) {
      targetPart = to.part;
      index = to.index;
    } else if ('referencePanel' in to) {
      targetPart = this._partPanels.get(to.referencePanel)?.group;
    }
    if (!targetPart) return;

    const sourcePart = panel.group;
    if (sourcePart === targetPart) {
      if (index !== undefined) {
        const list = this._parts[sourcePart].panels;
        const fromIdx = list.indexOf(panel.id);
        if (fromIdx >= 0) {
          const adjusted = Math.max(0, Math.min(list.length - 1, index > fromIdx ? index - 1 : index));
          list.splice(fromIdx, 1);
          list.splice(adjusted, 0, panel.id);
        }
      }
      this._parts[targetPart].activePanel = panel.id;
    } else {
      this._detachFromPart(sourcePart, panel.id);
      panel.group = targetPart;
      this._insertIntoPart(targetPart, panel.id, index);
      this._mountPartPanelElement(panel);
      this._parts[targetPart].visible = true;
      this._parts[targetPart].activePanel = panel.id;
      if (targetPart === 'sidebar' || targetPart === 'secondary') {
        this._splitView?.setPaneVisible(targetPart, true);
      }
    }

    this._setActivePanel(panel.ref);
    this._syncAllParts();
    this._applyDimensions();
    this._emitLayoutChange();
  }

  private _moveEditorPanel(id: string, sourceGroupId: string, to: PanelPosition): void {
    const sourceGroup = this._gridView.getGroup(sourceGroupId);
    if (!sourceGroup) return;

    const resolved = this._resolveEditorMoveTarget(to, sourceGroupId);
    if (!resolved) return;

    const targetGroup = this._gridView.getGroup(resolved.groupId);
    if (!targetGroup) return;

    if (resolved.direction === 'within') {
      this._moveEditorPanelWithin(id, sourceGroup, targetGroup, resolved.index);
      return;
    }

    if (sourceGroup.id === targetGroup.id && sourceGroup.size <= 1) return;

    this._suppressEvents = true;
    try {
      const newGroup = this._gridView.splitGroup(targetGroup.id, resolved.direction);
      if (!newGroup) return;
      this._syncGroupSubscriptions();
      const detached = sourceGroup.detachPanel(id);
      if (!detached) return;
      newGroup.attachPanel(detached, undefined, true);
      this._editorPanelGroup.set(id, newGroup.id);
      this._cleanupEmptyGroup(sourceGroup.id);
      this._gridView.setActiveGroup(newGroup.id);
    } finally {
      this._suppressEvents = false;
    }

    const activeGroup = this._gridView.getActiveGroup();
    this._setActivePanel(activeGroup?.activePanel);
    this._syncActiveTopicFromPanel(activeGroup?.activePanel, activeGroup);
    this._applyDimensions();
    this._emitLayoutChange();
  }

  private _resolveEditorMoveTarget(
    to: PanelPosition,
    fallbackGroupId: string,
  ): { readonly groupId: string; readonly direction: Direction; readonly index?: number } | undefined {
    if ('part' in to) return undefined;
    if ('group' in to) {
      return {
        groupId: to.group,
        direction: to.direction ?? 'within',
        index: to.index,
      };
    }
    const refGroupId = this._editorPanelGroup.get(to.referencePanel) ?? fallbackGroupId;
    return {
      groupId: refGroupId,
      direction: to.direction,
    };
  }

  private _moveEditorPanelWithin(
    id: string,
    sourceGroup: EditorGroup,
    targetGroup: EditorGroup,
    index?: number,
  ): void {
    if (sourceGroup.id === targetGroup.id) {
      if (index !== undefined) {
        const fromIdx = sourceGroup.getPanelIds().indexOf(id);
        if (fromIdx >= 0) {
          const toIdx = Math.max(
            0,
            Math.min(sourceGroup.size - 1, index > fromIdx ? index - 1 : index),
          );
          sourceGroup.reorderTab(fromIdx, toIdx);
        }
      }
      sourceGroup.setActivePanel(id, true);
      this._setActivePanel(sourceGroup.activePanel);
      this._syncActiveTopicFromPanel(sourceGroup.activePanel, sourceGroup);
      this._emitLayoutChange();
      return;
    }

    this._suppressEvents = true;
    try {
      const detached = sourceGroup.detachPanel(id);
      if (!detached) return;
      targetGroup.attachPanel(detached, index, true);
      this._editorPanelGroup.set(id, targetGroup.id);
      this._cleanupEmptyGroup(sourceGroup.id);
      this._gridView.setActiveGroup(targetGroup.id);
    } finally {
      this._suppressEvents = false;
    }

    this._setActivePanel(targetGroup.activePanel);
    this._syncActiveTopicFromPanel(targetGroup.activePanel, targetGroup);
    this._applyDimensions();
    this._emitLayoutChange();
  }

  private _cleanupEmptyGroup(groupId: string): void {
    const group = this._gridView.getGroup(groupId);
    if (!group || !group.isEmpty) return;
    if (this._gridView.getGroups().length <= 1) return;
    if (this._maximizedGroup === groupId) {
      this._maximizedGroup = undefined;
    }
    this._gridView.removeGroup(groupId);
    this._syncGroupSubscriptions();
  }

  private _refreshActiveAfterRemoval(prevGroupId: string): void {
    const activeGroup = this._gridView.getActiveGroup() ?? this._gridView.getGroup(prevGroupId);
    const activeRef = activeGroup?.activePanel;
    if (activeRef) {
      this._setActivePanel(activeRef);
      this._syncActiveTopicFromPanel(activeRef, activeGroup);
      return;
    }
    this._setActivePanel(undefined);
    const hasAnyEditor = this._gridView.getGroups().some((g) => !g.isEmpty);
    if (!hasAnyEditor) {
      this._setActiveTopic(undefined);
    }
  }

  private _focusPartPanel(id: string): void {
    const panel = this._partPanels.get(id);
    if (!panel) return;
    this._parts[panel.group].visible = true;
    this._parts[panel.group].activePanel = id;
    if (this._maximizedGroup) {
      this._maximizedGroup = undefined;
      this._gridView.exitMaximized();
    }
    this._setActivePanel(panel.ref);
    this._syncAllParts();
    this._applyDimensions();
    panel.component.focus?.();
    this._emitLayoutChange();
  }

  private _setActivePanel(ref: PanelRef | undefined): void {
    const nextId = ref?.id;
    if (this._activePanelId === nextId) return;
    this._activePanelId = nextId;
    this._onDidActivePanelChange.fire(ref);
  }

  private _syncActiveTopicFromPanel(ref: PanelRef | undefined, group?: EditorGroup): void {
    if (!ref) {
      if (!this._gridView.getGroups().some((g) => !g.isEmpty)) {
        this._setActiveTopic(undefined);
      }
      return;
    }
    if (isPartId(ref.group)) return;
    const owner = group ?? this._gridView.getGroup(ref.group);
    const tab = owner?.getPanels().find((t) => t.id === ref.id);
    if (!tab) return;
    const topicId = this._resolveTopicId
      ? this._resolveTopicId(ref, tab.componentName)
      : extractTopicId(tab.componentName, ref.params);
    if (topicId !== undefined) {
      this._setActiveTopic(topicId);
    }
  }

  private _setActiveTopic(topicId: string | undefined): void {
    if (this._activeTopicId === topicId) return;
    this._activeTopicId = topicId;
    this._onDidActiveTopicChange.fire(topicId);
  }

  private _syncActiveFromActiveGroup(): void {
    const activeGroup = this._gridView.getActiveGroup();
    const activeRef = activeGroup?.activePanel;
    this._setActivePanel(activeRef);
    this._syncActiveTopicFromPanel(activeRef, activeGroup);
  }

  private _restorePrunedLayout(state: LayoutState): void {
    this._clearAllPanels();
    this._restorePartsFromState(state);
    this._restoreGridFromState(state);
    this._maximizedGroup = state.maximizedGroup;
  }

  private _restorePartsFromState(state: LayoutState): void {
    for (const partId of PART_IDS) {
      const saved = state.parts[partId];
      this._parts[partId].visible = saved.visible;
      this._parts[partId].size = saved.size;
      if (partId === 'sidebar' || partId === 'secondary') {
        this._splitView?.setPaneSize(partId, saved.size);
        this._splitView?.setPaneVisible(partId, saved.visible);
      }
      for (const panelId of saved.panels) {
        const meta = state.panels[panelId];
        const factory = meta ? this._factories.get(meta.component) : undefined;
        if (!meta || !factory) continue;
        this._addPartPanel(
          { id: meta.id, component: meta.component, title: meta.title, params: meta.params },
          factory,
          partId,
        );
      }
      if (saved.activePanel && this._parts[partId].panels.includes(saved.activePanel)) {
        this._parts[partId].activePanel = saved.activePanel;
      }
    }
  }

  private _restoreGridFromState(state: LayoutState): void {
    this._gridView.setTree(state.grid, state.activeGroup, state.maximizedGroup);
    this._syncGroupSubscriptions();

    for (const leaf of listGroups(state.grid)) {
      const group = this._gridView.getGroup(leaf.group);
      if (!group) continue;
      for (const panelId of leaf.panels) {
        const meta = state.panels[panelId];
        const factory = meta ? this._factories.get(meta.component) : undefined;
        if (!meta || !factory) continue;
        group.addPanel({
          id: meta.id,
          componentName: meta.component,
          component: factory(),
          title: meta.title,
          params: meta.params,
          activate: false,
        });
        this._editorPanelGroup.set(meta.id, group.id);
      }
      const wantedActive =
        leaf.activePanel && group.getPanel(leaf.activePanel)
          ? leaf.activePanel
          : group.getPanelIds()[0];
      if (wantedActive) {
        group.setActivePanel(wantedActive, false);
      }
    }
    if (state.activeGroup && this._gridView.getGroup(state.activeGroup)) {
      this._gridView.setActiveGroup(state.activeGroup);
    }
  }

  private _applyDefaultLayout(): void {
    this._suppressEvents = true;
    try {
      this._applyDefaultLayoutInternal();
    } finally {
      this._suppressEvents = false;
    }
    this._syncAllParts();
    this._applyDimensions();
    this._syncActiveFromActiveGroup();
    this._emitLayoutChange();
  }

  private _applyDefaultLayoutInternal(): void {
    const fallback =
      this._defaultLayoutFactory?.() ??
      createDefaultLayoutState({
        partSizes: this._initialOptions.partSizes,
        initialVisible: this._initialOptions.initialVisible,
      });
    const pruned = pruneMissingComponents(fallback, new Set(this._factories.keys()));
    this._restorePrunedLayout(pruned);
  }

  private _clearAllPanels(): void {
    this._clearPartPanels();
    this._editorPanelGroup.clear();
    this._gridView.setTree(createLeafNode(MAIN_GROUP_ID), MAIN_GROUP_ID);
    this._syncGroupSubscriptions();
    this._activePanelId = undefined;
    this._maximizedGroup = undefined;
  }

  private _clearPartPanels(): void {
    for (const panel of this._partPanels.values()) {
      if (panel.visible) {
        panel.visible = false;
        panel.visibilityEmitter.fire(false);
      }
      panel.component.element.remove();
      panel.component.dispose();
      panel.visibilityEmitter.dispose();
      panel.dimensionsEmitter.dispose();
    }
    this._partPanels.clear();
    for (const partId of PART_IDS) {
      this._parts[partId].panels = [];
      this._parts[partId].activePanel = undefined;
    }
  }

  private _insertIntoPart(part: PartId, id: string, index?: number): void {
    const list = this._parts[part].panels;
    const existingIdx = list.indexOf(id);
    if (existingIdx >= 0) list.splice(existingIdx, 1);
    if (index === undefined || index < 0 || index >= list.length) {
      list.push(id);
    } else {
      list.splice(index, 0, id);
    }
  }

  private _detachFromPart(part: PartId, id: string): void {
    const state = this._parts[part];
    const idx = state.panels.indexOf(id);
    if (idx >= 0) state.panels.splice(idx, 1);
    if (state.activePanel === id) {
      state.activePanel = state.panels[Math.min(idx, state.panels.length - 1)];
    }
  }

  private _mountPartPanelElement(panel: PartManagedPanel): void {
    const host = this._partHosts[panel.group]?.body;
    if (host && panel.component.element.parentElement !== host) {
      host.appendChild(panel.component.element);
    }
  }

  private _rememberPartSize(part: PartId): void {
    if (part === 'sidebar' || part === 'secondary') {
      const live = this._splitView?.getPreferredPaneSize(part) ?? 0;
      if (live > 0) {
        this._parts[part].size = Math.round(live);
        return;
      }
    }
    const hostEl = this._partHosts[part]?.element;
    if (!hostEl) return;
    const measured = part === 'panel' ? hostEl.clientHeight : hostEl.clientWidth;
    if (measured > 0) {
      this._parts[part].size = Math.round(measured);
    }
  }

  private _syncAllParts(): void {
    this._syncPartHostVisibility();
    this._syncPartPanelVisibility();
    this._renderPartHeaders();
  }

  private _syncPartHostVisibility(): void {
    for (const partId of PART_IDS) {
      this._partHosts[partId]?.setVisible?.(this.isPartVisible(partId));
    }
  }

  private _syncPartPanelVisibility(): void {
    for (const panel of this._partPanels.values()) {
      const next =
        this.isPartVisible(panel.group) && this._parts[panel.group].activePanel === panel.id;
      panel.component.element.hidden = !next;
      if (panel.visible !== next) {
        panel.visible = next;
        panel.visibilityEmitter.fire(next);
      }
    }
  }

  private _renderPartHeaders(): void {
    for (const partId of PART_IDS) {
      const host = this._partHosts[partId];
      if (!host?.setTabs) continue;
      const tabs: DockTabInfo[] = this._parts[partId].panels
        .map((id) => this._partPanels.get(id))
        .filter((p): p is PartManagedPanel => Boolean(p))
        .map((p) => ({ id: p.id, title: p.title, badge: p.badge }));
      host.setTabs(tabs, this._parts[partId].activePanel);
    }
  }

  private _applyDimensions(): void {
    if (this._width === 0 && this._height === 0) return;

    const sbW = this.isPartVisible('sidebar') ? this._parts.sidebar.size : 0;
    const secW = this.isPartVisible('secondary') ? this._parts.secondary.size : 0;
    const panH = this.isPartVisible('panel') ? this._parts.panel.size : 0;
    const edW = Math.max(0, this._width - sbW - secW);
    const edH = Math.max(0, this._height - panH);

    this._gridView.layout(edW, edH);

    for (const panel of this._partPanels.values()) {
      if (!panel.visible) continue;
      const dims =
        panel.group === 'sidebar'
          ? { width: sbW, height: this._height }
          : panel.group === 'secondary'
            ? { width: secW, height: this._height }
            : { width: edW, height: panH };
      if (dims.width !== panel.lastWidth || dims.height !== panel.lastHeight) {
        panel.lastWidth = dims.width;
        panel.lastHeight = dims.height;
        panel.dimensionsEmitter.fire(dims);
      }
    }
  }

  private _emitLayoutChange(): void {
    if (!this._suppressEvents) {
      this._onDidLayoutChange.fire();
    }
  }
}
