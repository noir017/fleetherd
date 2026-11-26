import { addDisposableListener } from '../../base/dom.js';
import { Emitter, type Event } from '../../base/event.js';
import { type Disposable, DisposableStore, toDisposable } from '../../base/lifecycle.js';
import type {
  AddPanelOptions,
  DockEngine,
  LayoutState,
  PanelComponent,
  PanelLayoutState,
  PanelPosition,
  PanelRef,
  PartId,
  PartLayoutState,
} from '../contracts.js';

export const MAIN_GROUP_ID = 'main';

const PART_IDS: readonly PartId[] = ['sidebar', 'secondary', 'panel'];

const DEFAULT_PART_SIZES: Record<PartId, number> = {
  sidebar: 264,
  secondary: 420,
  panel: 220,
};

export interface StaticDockPartHost {
  readonly header?: HTMLElement;
  readonly body: HTMLElement;
  setVisible?(visible: boolean): void;
  setTabs?(tabs: readonly StaticTabInfo[], activeId: string | undefined): void;
}

export interface StaticTabInfo {
  readonly id: string;
  readonly title: string;
  readonly badge: number | null;
}

export interface StaticDockOptions {
  readonly doc?: Document;
  readonly editorContainer?: HTMLElement;
  readonly parts?: Partial<Record<PartId, StaticDockPartHost>>;
  readonly partSizes?: Partial<Record<PartId, number>>;
  readonly initialVisible?: Partial<Record<PartId, boolean>>;
  readonly renderEditorHeader?: (
    head: HTMLElement,
    tabs: readonly StaticTabInfo[],
    activeId: string | undefined,
    actions: { focus(id: string): void; close(id: string): void },
  ) => void;
}

interface PartState {
  visible: boolean;
  size: number;
  panels: string[];
  activePanel: string | undefined;
}

interface ManagedPanel {
  readonly id: string;
  readonly componentName: string;
  title: string;
  badge: number | null;
  params: unknown;
  group: string | PartId;
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

function createInitialParts(options: StaticDockOptions): Record<PartId, PartState> {
  const vis = options.initialVisible;
  const sizes = options.partSizes;
  return {
    sidebar: { visible: vis?.sidebar ?? true, size: sizes?.sidebar ?? DEFAULT_PART_SIZES.sidebar, panels: [], activePanel: undefined },
    secondary: { visible: vis?.secondary ?? false, size: sizes?.secondary ?? DEFAULT_PART_SIZES.secondary, panels: [], activePanel: undefined },
    panel: { visible: vis?.panel ?? false, size: sizes?.panel ?? DEFAULT_PART_SIZES.panel, panels: [], activePanel: undefined },
  };
}

export class StaticDockEngine implements DockEngine {
  private readonly _doc: Document | undefined;
  private readonly _editorContainer: HTMLElement | undefined;
  private readonly _editorHead: HTMLElement | undefined;
  private readonly _editorBody: HTMLElement | undefined;
  private readonly _partHosts: Partial<Record<PartId, StaticDockPartHost>>;
  private readonly _renderEditorHeader?: StaticDockOptions['renderEditorHeader'];

  private readonly _factories = new Map<string, () => PanelComponent>();
  private readonly _panels = new Map<string, ManagedPanel>();
  private readonly _parts: Record<PartId, PartState>;
  private _groupPanels: string[] = [];
  private _groupActive: string | undefined;
  private _activePanelId: string | undefined;
  private _maximizedGroup: string | undefined;
  private _width = 0;
  private _height = 0;
  private _disposed = false;

  private readonly _disposables = new DisposableStore();
  private readonly _tabDisposables = new DisposableStore();
  private readonly _onDidLayoutChange = new Emitter<void>();
  private readonly _onDidActivePanelChange = new Emitter<PanelRef | undefined>();

  readonly onDidLayoutChange: Event<void> = this._onDidLayoutChange.event;
  readonly onDidActivePanelChange: Event<PanelRef | undefined> = this._onDidActivePanelChange.event;

  constructor(options: StaticDockOptions = {}) {
    this._doc = options.doc ?? options.editorContainer?.ownerDocument;
    this._partHosts = options.parts ?? {};
    this._renderEditorHeader = options.renderEditorHeader;
    this._parts = createInitialParts(options);

    if (options.editorContainer && this._doc) {
      this._editorContainer = options.editorContainer;
      this._editorContainer.classList.add('wb-editor-group');
      this._editorHead = this._doc.createElement('div');
      this._editorHead.className = 'wb-group-head wb-single-tab';
      this._editorBody = this._doc.createElement('div');
      this._editorBody.className = 'wb-group-body';
      this._editorContainer.replaceChildren(this._editorHead, this._editorBody);
    }

    this._disposables.add(this._onDidLayoutChange);
    this._disposables.add(this._onDidActivePanelChange);
    this._disposables.add(this._tabDisposables);
    this._syncPartHostVisibility();
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
    if (this._disposed) throw new Error('StaticDockEngine is disposed');
    const existing = this._panels.get(o.id);
    if (existing) {
      existing.params = o.params;
      existing.title = o.title;
      existing.component.update?.(o.params);
      this._focusPanel(existing.id);
      return existing.ref;
    }

    const factory = this._factories.get(o.component);
    if (!factory) {
      throw new Error(`Unknown dock component: ${o.component}`);
    }

    const { target, index } = this._resolvePosition(o.position);
    const component = factory();
    const visibilityEmitter = new Emitter<boolean>();
    const dimensionsEmitter = new Emitter<{ readonly width: number; readonly height: number }>();

    const managed: ManagedPanel = {
      id: o.id,
      componentName: o.component,
      title: o.title,
      badge: null,
      params: o.params,
      group: target,
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
      get isVisible() {
        return managed.visible;
      },
      onDidVisibilityChange: visibilityEmitter.event,
      onDidDimensionsChange: dimensionsEmitter.event,
      setTitle: (title: string) => {
        if (managed.title === title) return;
        managed.title = title;
        this._renderHeaders();
        this._onDidLayoutChange.fire();
      },
      setBadge: (n: number | null) => {
        if (managed.badge === n) return;
        managed.badge = n;
        this._renderHeaders();
      },
      focus: () => {
        this._focusPanel(managed.id);
      },
      close: () => {
        this.removePanel(managed.id);
      },
    };
    (managed as { ref: PanelRef }).ref = ref;

    this._panels.set(o.id, managed);
    this._insertIntoTarget(o.id, target, index);
    managed.component.element.hidden = true;
    this._mountPanelElement(managed);
    component.init(o.params, { id: o.id, api: ref });
    this._setActiveInTarget(target, o.id);
    this._setActivePanel(managed);
    this._syncAll();
    this._onDidLayoutChange.fire();
    return ref;
  }

  getPanel(id: string): PanelRef | undefined {
    return this._panels.get(id)?.ref;
  }

  removePanel(id: string): void {
    const panel = this._panels.get(id);
    if (!panel) return;

    const prevTarget = panel.group;
    this._detachFromTarget(id, prevTarget);
    this._panels.delete(id);

    if (panel.visible) {
      panel.visible = false;
      panel.visibilityEmitter.fire(false);
    }
    panel.component.element.remove();
    panel.component.dispose();
    panel.visibilityEmitter.dispose();
    panel.dimensionsEmitter.dispose();

    if (this._activePanelId === id) {
      const fallbackId = this._pickFallbackActive(prevTarget);
      this._setActivePanel(fallbackId ? this._panels.get(fallbackId) : undefined);
    }

    this._syncAll();
    this._onDidLayoutChange.fire();
  }

  movePanel(id: string, to: PanelPosition): void {
    const panel = this._panels.get(id);
    if (!panel) return;

    const { target, index } = this._resolvePosition(to);
    this._detachFromTarget(id, panel.group);
    panel.group = target;
    this._insertIntoTarget(id, target, index);
    this._mountPanelElement(panel);
    this._setActiveInTarget(target, id);
    this._syncAll();
    this._onDidLayoutChange.fire();
  }

  setPartVisible(part: PartId, visible: boolean): void {
    const state = this._parts[part];
    if (state.visible === visible) return;
    state.visible = visible;
    if (visible && this._maximizedGroup) {
      this._maximizedGroup = undefined;
    }
    this._syncAll();
    this._onDidLayoutChange.fire();
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
    if (this._parts[part].size === size) return;
    this._parts[part].size = Math.round(size);
    this._notifyDimensions();
    this._onDidLayoutChange.fire();
  }

  getPartPanels(part: PartId): readonly string[] {
    return this._parts[part].panels;
  }

  getActivePartPanel(part: PartId): string | undefined {
    return this._parts[part].activePanel;
  }

  getGroupPanels(): readonly string[] {
    return this._groupPanels;
  }

  getActiveGroupPanel(): string | undefined {
    return this._groupActive;
  }

  isMaximized(): boolean {
    return this._maximizedGroup !== undefined;
  }

  maximizeGroup(group: string): void {
    const target = group || MAIN_GROUP_ID;
    if (this._maximizedGroup === target) return;
    this._maximizedGroup = target;
    this._syncAll();
    this._onDidLayoutChange.fire();
  }

  exitMaximized(): void {
    if (!this._maximizedGroup) return;
    this._maximizedGroup = undefined;
    this._syncAll();
    this._onDidLayoutChange.fire();
  }

  toJSON(): LayoutState {
    const parts = {} as Record<PartId, PartLayoutState>;
    for (const partId of PART_IDS) {
      const p = this._parts[partId];
      parts[partId] = {
        visible: p.visible,
        size: p.size,
        panels: [...p.panels],
        ...(p.activePanel ? { activePanel: p.activePanel } : {}),
      };
    }

    const panels: Record<string, PanelLayoutState> = {};
    for (const [id, p] of this._panels) {
      panels[id] = {
        id: p.id,
        component: p.componentName,
        title: p.title,
        ...(p.params !== undefined ? { params: p.params } : {}),
      };
    }

    return {
      v: 1,
      parts,
      grid: {
        type: 'leaf',
        group: MAIN_GROUP_ID,
        panels: [...this._groupPanels],
        ...(this._groupActive ? { activePanel: this._groupActive } : {}),
      },
      panels,
      activeGroup: MAIN_GROUP_ID,
      ...(this._maximizedGroup ? { maximizedGroup: this._maximizedGroup } : {}),
    };
  }

  fromJSON(state: LayoutState): void {
    if (!state || state.v !== 1) return;
    this._clearAllPanels();

    for (const partId of PART_IDS) {
      const saved = state.parts[partId];
      if (!saved) continue;
      this._parts[partId].visible = Boolean(saved.visible);
      if (typeof saved.size === 'number' && Number.isFinite(saved.size) && saved.size > 0) {
        this._parts[partId].size = Math.round(saved.size);
      }
      for (const panelId of saved.panels) {
        const meta = state.panels[panelId];
        if (!meta || !this._factories.has(meta.component)) continue;
        this.addPanel({
          id: meta.id,
          component: meta.component,
          title: meta.title,
          params: meta.params,
          position: { part: partId },
        });
      }
      if (saved.activePanel && this._parts[partId].panels.includes(saved.activePanel)) {
        this._parts[partId].activePanel = saved.activePanel;
      }
    }

    const leafPanels = this._collectGridPanels(state.grid);
    for (const panelId of leafPanels.panels) {
      const meta = state.panels[panelId];
      if (!meta || !this._factories.has(meta.component)) continue;
      this.addPanel({
        id: meta.id,
        component: meta.component,
        title: meta.title,
        params: meta.params,
        position: { group: MAIN_GROUP_ID },
      });
    }
    if (leafPanels.activePanel && this._groupPanels.includes(leafPanels.activePanel)) {
      this._groupActive = leafPanels.activePanel;
    }

    this._maximizedGroup = state.maximizedGroup;
    this._syncAll();
    this._onDidLayoutChange.fire();
  }

  layout(width: number, height: number): void {
    this._width = Math.max(0, Math.round(width));
    this._height = Math.max(0, Math.round(height));
    this._notifyDimensions();
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this._clearAllPanels();
    this._factories.clear();
    this._disposables.dispose();
  }

  private _clearAllPanels(): void {
    for (const id of [...this._panels.keys()]) {
      const panel = this._panels.get(id);
      if (!panel) continue;
      panel.component.element.remove();
      panel.component.dispose();
      panel.visibilityEmitter.dispose();
      panel.dimensionsEmitter.dispose();
    }
    this._panels.clear();
    for (const partId of PART_IDS) {
      this._parts[partId].panels = [];
      this._parts[partId].activePanel = undefined;
    }
    this._groupPanels = [];
    this._groupActive = undefined;
    this._activePanelId = undefined;
    this._maximizedGroup = undefined;
  }

  private _collectGridPanels(
    node: LayoutState['grid'],
  ): { panels: string[]; activePanel?: string } {
    if (node.type === 'leaf') {
      return { panels: [...node.panels], activePanel: node.activePanel };
    }
    const panels: string[] = [];
    let activePanel: string | undefined;
    for (const child of node.children) {
      const sub = this._collectGridPanels(child);
      panels.push(...sub.panels);
      if (!activePanel && sub.activePanel) activePanel = sub.activePanel;
    }
    return { panels, activePanel };
  }

  private _resolvePosition(position?: PanelPosition): { target: string | PartId; index?: number } {
    if (!position) return { target: MAIN_GROUP_ID };
    if ('part' in position) return { target: position.part, index: position.index };
    if ('group' in position) return { target: MAIN_GROUP_ID, index: position.index };
    const ref = this._panels.get(position.referencePanel);
    if (!ref) return { target: MAIN_GROUP_ID };
    return { target: ref.group };
  }

  private _insertIntoTarget(id: string, target: string | PartId, index?: number): void {
    const list = isPartId(target) ? this._parts[target].panels : this._groupPanels;
    const existingIdx = list.indexOf(id);
    if (existingIdx >= 0) list.splice(existingIdx, 1);
    if (index === undefined || index < 0 || index >= list.length) {
      list.push(id);
    } else {
      list.splice(index, 0, id);
    }
  }

  private _detachFromTarget(id: string, target: string | PartId): void {
    if (isPartId(target)) {
      const part = this._parts[target];
      const idx = part.panels.indexOf(id);
      if (idx >= 0) part.panels.splice(idx, 1);
      if (part.activePanel === id) {
        part.activePanel = part.panels[Math.min(idx, part.panels.length - 1)];
      }
      return;
    }
    const idx = this._groupPanels.indexOf(id);
    if (idx >= 0) this._groupPanels.splice(idx, 1);
    if (this._groupActive === id) {
      this._groupActive = this._groupPanels[Math.min(idx, this._groupPanels.length - 1)];
    }
  }

  private _setActiveInTarget(target: string | PartId, id: string): void {
    if (isPartId(target)) this._parts[target].activePanel = id;
    else this._groupActive = id;
  }

  private _pickFallbackActive(prevTarget: string | PartId): string | undefined {
    if (isPartId(prevTarget) && this._parts[prevTarget].activePanel) {
      return this._parts[prevTarget].activePanel;
    }
    if (this._groupActive) return this._groupActive;
    for (const partId of PART_IDS) {
      if (this._parts[partId].visible && this._parts[partId].activePanel) {
        return this._parts[partId].activePanel;
      }
    }
    return undefined;
  }

  private _focusPanel(id: string): void {
    const panel = this._panels.get(id);
    if (!panel) return;
    if (isPartId(panel.group)) {
      this._parts[panel.group].visible = true;
      this._parts[panel.group].activePanel = id;
    } else {
      this._groupActive = id;
    }
    this._setActivePanel(panel);
    this._syncAll();
    panel.component.focus?.();
    this._onDidLayoutChange.fire();
  }

  private _setActivePanel(panel: ManagedPanel | undefined): void {
    const nextId = panel?.id;
    if (this._activePanelId === nextId) return;
    this._activePanelId = nextId;
    this._onDidActivePanelChange.fire(panel?.ref);
  }

  private _mountPanelElement(panel: ManagedPanel): void {
    const host = isPartId(panel.group) ? this._partHosts[panel.group]?.body : this._editorBody;
    if (host && panel.component.element.parentElement !== host) {
      host.appendChild(panel.component.element);
    }
  }

  private _syncAll(): void {
    this._syncPartHostVisibility();
    this._syncPanelVisibility();
    this._renderHeaders();
    this._notifyDimensions();
  }

  private _syncPartHostVisibility(): void {
    for (const partId of PART_IDS) {
      this._partHosts[partId]?.setVisible?.(this.isPartVisible(partId));
    }
  }

  private _isPanelEffectivelyVisible(panel: ManagedPanel): boolean {
    if (isPartId(panel.group)) {
      return this.isPartVisible(panel.group) && this._parts[panel.group].activePanel === panel.id;
    }
    return this._groupActive === panel.id;
  }

  private _syncPanelVisibility(): void {
    for (const panel of this._panels.values()) {
      const next = this._isPanelEffectivelyVisible(panel);
      panel.component.element.hidden = !next;
      if (panel.visible !== next) {
        panel.visible = next;
        panel.visibilityEmitter.fire(next);
      }
    }
  }

  private _renderHeaders(): void {
    for (const partId of PART_IDS) {
      const host = this._partHosts[partId];
      if (!host?.setTabs) continue;
      const tabs = this._parts[partId].panels
        .map((id) => this._panels.get(id))
        .filter((p): p is ManagedPanel => Boolean(p))
        .map((p) => ({ id: p.id, title: p.title, badge: p.badge }));
      host.setTabs(tabs, this._parts[partId].activePanel);
    }

    if (!this._editorHead || !this._doc) return;
    this._tabDisposables.clear();
    const tabs: StaticTabInfo[] = this._groupPanels
      .map((id) => this._panels.get(id))
      .filter((p): p is ManagedPanel => Boolean(p))
      .map((p) => ({ id: p.id, title: p.title, badge: p.badge }));

    if (this._renderEditorHeader) {
      this._renderEditorHeader(this._editorHead, tabs, this._groupActive, {
        focus: (id) => this._focusPanel(id),
        close: (id) => this.removePanel(id),
      });
      return;
    }

    this._renderDefaultEditorHeader(this._editorHead, tabs);
  }

  private _renderDefaultEditorHeader(head: HTMLElement, tabs: readonly StaticTabInfo[]): void {
    const doc = this._doc!;
    const multi = tabs.length >= 2;
    head.classList.toggle('wb-single-tab', !multi);
    head.classList.toggle('wb-multi-tab', multi);
    head.replaceChildren();

    if (!multi) {
      const only = tabs[0];
      const titleEl = doc.createElement('span');
      titleEl.className = 'wb-group-title';
      titleEl.textContent = only?.title ?? '';
      head.appendChild(titleEl);
      if (only && only.badge !== null && only.badge > 0) {
        const badgeEl = doc.createElement('span');
        badgeEl.className = 'wb-badge';
        badgeEl.textContent = String(only.badge);
        head.appendChild(badgeEl);
      }
      return;
    }

    const list = doc.createElement('div');
    list.className = 'wb-tab-strip';
    list.setAttribute('role', 'tablist');
    for (const tab of tabs) {
      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.className = `wb-tab${tab.id === this._groupActive ? ' is-active' : ''}`;
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-selected', String(tab.id === this._groupActive));
      btn.dataset.panelId = tab.id;

      const label = doc.createElement('span');
      label.className = 'wb-tab-label';
      label.textContent = tab.title;
      btn.appendChild(label);

      if (tab.badge !== null && tab.badge > 0) {
        const b = doc.createElement('span');
        b.className = 'wb-badge';
        b.textContent = String(tab.badge);
        btn.appendChild(b);
      }

      const close = doc.createElement('span');
      close.className = 'wb-tab-close';
      close.setAttribute('role', 'button');
      close.setAttribute('aria-label', `Close ${tab.title}`);
      close.textContent = '×';
      btn.appendChild(close);

      this._tabDisposables.add(
        addDisposableListener(btn, 'click', (ev) => {
          if (ev.target === close) {
            ev.stopPropagation();
            this.removePanel(tab.id);
            return;
          }
          this._focusPanel(tab.id);
        }),
      );
      list.appendChild(btn);
    }
    head.appendChild(list);
  }

  private _computeDimensions(target: string | PartId): { width: number; height: number } {
    const sbW = this.isPartVisible('sidebar') ? this._parts.sidebar.size : 0;
    const secW = this.isPartVisible('secondary') ? this._parts.secondary.size : 0;
    const panH = this.isPartVisible('panel') ? this._parts.panel.size : 0;
    const edW = Math.max(0, this._width - sbW - secW);
    const edH = Math.max(0, this._height - panH);

    if (target === 'sidebar') return { width: sbW, height: this._height };
    if (target === 'secondary') return { width: secW, height: this._height };
    if (target === 'panel') return { width: edW, height: panH };
    return { width: edW, height: edH };
  }

  private _notifyDimensions(): void {
    if (this._width === 0 && this._height === 0) return;
    for (const panel of this._panels.values()) {
      if (!panel.visible) continue;
      const dims = this._computeDimensions(panel.group);
      if (dims.width !== panel.lastWidth || dims.height !== panel.lastHeight) {
        panel.lastWidth = dims.width;
        panel.lastHeight = dims.height;
        panel.dimensionsEmitter.fire(dims);
      }
    }
  }
}
