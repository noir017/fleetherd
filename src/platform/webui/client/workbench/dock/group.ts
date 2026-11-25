import { addDisposableListener, focusSafely } from '../../base/dom.js';
import { Emitter, type Event } from '../../base/event.js';
import { icon } from '../../../icons.js';
import { type Disposable, DisposableStore } from '../../base/lifecycle.js';
import type { GridNodeState, PanelComponent, PanelRef } from '../contracts.js';

export type GridLeafState = Extract<GridNodeState, { readonly type: 'leaf' }>;

export interface EditorGroupTabInfo {
  readonly id: string;
  readonly componentName: string;
  readonly title: string;
  readonly badge: number | null;
  readonly dirty: boolean;
  readonly closable: boolean;
  readonly params: unknown;
}

export interface EditorGroupHeaderActions {
  focus(panelId: string): void;
  close(panelId: string): void;
  reorder(fromIndex: number, toIndex: number): void;
}

export interface EditorGroupTabDragStartEvent {
  readonly groupId: string;
  readonly panelId: string;
  readonly index: number;
  readonly event: PointerEvent;
  readonly tabElement: HTMLElement;
}

export interface EditorGroupTabReorderEvent {
  readonly fromIndex: number;
  readonly toIndex: number;
  readonly panelId: string;
}

export interface EditorGroupOptions {
  readonly id: string;
  readonly doc?: Document;
  readonly resolveIcon?: (name: string) => string;
  readonly alwaysShowTabs?: boolean;
  readonly renderSingleHeader?: (
    head: HTMLElement,
    tab: EditorGroupTabInfo | undefined,
    actions: EditorGroupHeaderActions,
  ) => void;
  readonly onTabPointerDown?: (info: EditorGroupTabDragStartEvent) => void;
}

export interface EditorGroupAddPanelOptions {
  readonly id: string;
  readonly componentName: string;
  readonly component: PanelComponent;
  readonly title: string;
  readonly params?: unknown;
  readonly badge?: number | null;
  readonly dirty?: boolean;
  readonly closable?: boolean;
  readonly index?: number;
  readonly activate?: boolean;
}

interface ManagedPanel {
  readonly id: string;
  readonly componentName: string;
  readonly component: PanelComponent;
  title: string;
  badge: number | null;
  dirty: boolean;
  closable: boolean;
  params: unknown;
  groupId: string;
  visible: boolean;
  lastWidth: number;
  lastHeight: number;
  readonly visibilityEmitter: Emitter<boolean>;
  readonly dimensionsEmitter: Emitter<{ readonly width: number; readonly height: number }>;
  owner: EditorGroup | undefined;
  readonly ref: PanelRef;
}

export interface DetachedGroupPanel {
  readonly id: string;
  readonly ref: PanelRef;
  readonly _managed: ManagedPanel;
}

const CLOSE_SVG = icon('cross');

export function reorderList<T>(items: readonly T[], fromIdx: number, toIdx: number): T[] {
  const len = items.length;
  if (len === 0 || fromIdx < 0 || fromIdx >= len || toIdx < 0 || toIdx >= len || fromIdx === toIdx) {
    return items.slice();
  }
  const next = items.slice();
  const [moved] = next.splice(fromIdx, 1);
  if (moved !== undefined) {
    next.splice(toIdx, 0, moved);
  }
  return next;
}

export function pickAdjacentTabId(panels: readonly string[], removedIndex: number): string | undefined {
  if (panels.length === 0) return undefined;
  const clamped = Math.max(0, Math.min(removedIndex, panels.length - 1));
  return panels[clamped];
}

function defaultResolveIcon(name: string): string {
  return name === 'cross' ? CLOSE_SVG : '';
}

const EDITOR_TAB_ICONS: Readonly<Record<string, string>> = {
  topic: 'chat',
  chat: 'chat',
  history: 'history',
  schedule: 'clock',
  schedules: 'clock',
  task: 'clock',
  review: 'eye',
  reviews: 'eye',
  skill: 'book',
  skills: 'book',
  settings: 'gear',
  diff: 'git',
  changes: 'git',
  terminal: 'terminal',
  file: 'file',
  files: 'file',
  instructions: 'file',
  reader: 'file',
};

function resolveEditorTabIconName(componentName: string): string {
  const key = componentName.startsWith('editor:') ? componentName.slice(7) : componentName;
  return EDITOR_TAB_ICONS[key] ?? '';
}

export class EditorGroup implements Disposable {
  readonly id: string;
  readonly element: HTMLElement;
  readonly headerElement: HTMLElement;
  readonly bodyElement: HTMLElement;

  private readonly _doc: Document;
  private readonly _resolveIcon: (name: string) => string;
  private readonly _alwaysShowTabs: boolean;
  private readonly _renderSingleHeader?: EditorGroupOptions['renderSingleHeader'];
  private readonly _onTabPointerDown?: EditorGroupOptions['onTabPointerDown'];

  private _panels: ManagedPanel[] = [];
  private _activePanelId: string | undefined;
  private _active = false;
  private _visible = true;
  private _width = 0;
  private _height = 0;
  private _disposed = false;

  private readonly _disposables = new DisposableStore();
  private readonly _headerDisposables = new DisposableStore();
  private readonly _onDidChange = new Emitter<void>();
  private readonly _onDidActivePanelChange = new Emitter<PanelRef | undefined>();
  private readonly _onDidFocus = new Emitter<void>();
  private readonly _onDidClosePanel = new Emitter<string>();
  private readonly _onDidEmpty = new Emitter<void>();
  private readonly _onDidReorderTab = new Emitter<EditorGroupTabReorderEvent>();

  readonly onDidChange: Event<void> = this._onDidChange.event;
  readonly onDidActivePanelChange: Event<PanelRef | undefined> = this._onDidActivePanelChange.event;
  readonly onDidFocus: Event<void> = this._onDidFocus.event;
  readonly onDidClosePanel: Event<string> = this._onDidClosePanel.event;
  readonly onDidEmpty: Event<void> = this._onDidEmpty.event;
  readonly onDidReorderTab: Event<EditorGroupTabReorderEvent> = this._onDidReorderTab.event;

  constructor(options: EditorGroupOptions) {
    this.id = options.id;
    this._doc = options.doc ?? document;
    this._resolveIcon = options.resolveIcon ?? defaultResolveIcon;
    this._alwaysShowTabs = options.alwaysShowTabs ?? false;
    this._renderSingleHeader = options.renderSingleHeader;
    this._onTabPointerDown = options.onTabPointerDown;

    this.element = this._doc.createElement('div');
    this.element.className = 'wb-editor-group';
    this.element.dataset.groupId = this.id;
    this.element.dataset.active = 'false';

    this.headerElement = this._doc.createElement('div');
    this.headerElement.className = 'wb-group-head wb-single-tab';

    this.bodyElement = this._doc.createElement('div');
    this.bodyElement.className = 'wb-group-body';

    this.element.append(this.headerElement, this.bodyElement);

    this._disposables.add(this._headerDisposables);
    this._disposables.add(this._onDidChange);
    this._disposables.add(this._onDidActivePanelChange);
    this._disposables.add(this._onDidFocus);
    this._disposables.add(this._onDidClosePanel);
    this._disposables.add(this._onDidEmpty);
    this._disposables.add(this._onDidReorderTab);
    this._disposables.add(
      addDisposableListener(this.element, 'pointerdown', () => {
        this._onDidFocus.fire();
      }),
    );

    this._renderHeader();
  }

  get size(): number {
    return this._panels.length;
  }

  get isEmpty(): boolean {
    return this._panels.length === 0;
  }

  get isActive(): boolean {
    return this._active;
  }

  get activePanelId(): string | undefined {
    return this._activePanelId;
  }

  get activePanel(): PanelRef | undefined {
    const found = this._findPanel(this._activePanelId);
    return found?.ref;
  }

  getPanel(panelId: string): PanelRef | undefined {
    return this._findPanel(panelId)?.ref;
  }

  reattachPanel(panelId: string): boolean {
    const panel = this._findPanel(panelId);
    if (!panel) return false;
    if (panel.component.element.parentElement !== this.bodyElement) {
      this.bodyElement.appendChild(panel.component.element);
    }
    this._syncPanelVisibility();
    return true;
  }

  getPanelIds(): readonly string[] {
    return this._panels.map((p) => p.id);
  }

  getPanels(): readonly EditorGroupTabInfo[] {
    return this._panels.map((p) => this._toTabInfo(p));
  }

  isDirty(panelId: string): boolean {
    return this._findPanel(panelId)?.dirty ?? false;
  }

  setDirty(panelId: string, dirty: boolean): void {
    const panel = this._findPanel(panelId);
    if (!panel || panel.dirty === dirty) return;
    panel.dirty = dirty;
    this._renderHeader();
    this._onDidChange.fire();
  }

  setTitle(panelId: string, title: string): void {
    const panel = this._findPanel(panelId);
    if (!panel || panel.title === title) return;
    panel.title = title;
    this._renderHeader();
    this._onDidChange.fire();
  }

  setBadge(panelId: string, badge: number | null): void {
    const panel = this._findPanel(panelId);
    if (!panel || panel.badge === badge) return;
    panel.badge = badge;
    this._renderHeader();
    this._onDidChange.fire();
  }

  setActive(active: boolean): void {
    if (this._active === active) return;
    this._active = active;
    this.element.classList.toggle('is-active', active);
    this.element.dataset.active = String(active);
  }

  setVisible(visible: boolean): void {
    if (this._visible === visible) return;
    this._visible = visible;
    this.element.hidden = !visible;
    this._syncPanelVisibility();
  }

  layout(width: number, height: number): void {
    const nextW = Math.max(0, Math.round(width));
    const nextH = Math.max(0, Math.round(height));
    this._width = nextW;
    this._height = nextH;
    this._notifyDimensions();
  }

  addPanel(options: EditorGroupAddPanelOptions): PanelRef {
    if (this._disposed) throw new Error(`EditorGroup ${this.id} is disposed`);

    const existing = this._findPanel(options.id);
    if (existing) {
      existing.title = options.title;
      existing.params = options.params;
      if (options.dirty !== undefined) existing.dirty = options.dirty;
      if (options.badge !== undefined) existing.badge = options.badge;
      existing.component.update?.(options.params);
      if (options.activate !== false) {
        this.setActivePanel(existing.id, true);
      } else {
        this._renderHeader();
      }
      return existing.ref;
    }

    const managed = this._createManagedPanel(options);
    this._insertManaged(managed, options.index);
    this.bodyElement.appendChild(managed.component.element);
    managed.component.init(options.params, { id: managed.id, api: managed.ref });

    if (options.activate !== false || this._activePanelId === undefined) {
      this._setActivePanelInternal(managed.id, false);
    }

    this._syncPanelVisibility();
    this._renderHeader();
    this._notifyDimensions();
    this._onDidChange.fire();
    return managed.ref;
  }

  detachPanel(panelId: string): DetachedGroupPanel | undefined {
    const idx = this._panels.findIndex((p) => p.id === panelId);
    if (idx < 0) return undefined;
    const panel = this._panels[idx]!;
    this._panels.splice(idx, 1);
    panel.owner = undefined;
    panel.component.element.remove();

    if (panel.visible) {
      panel.visible = false;
      panel.visibilityEmitter.fire(false);
    }

    const wasActive = this._activePanelId === panelId;
    if (wasActive) {
      const nextId = pickAdjacentTabId(this.getPanelIds(), idx);
      this._setActivePanelInternal(nextId, false);
    }

    this._syncPanelVisibility();
    this._renderHeader();
    this._notifyDimensions();
    this._onDidChange.fire();
    if (this._panels.length === 0) {
      this._onDidEmpty.fire();
    }

    return { id: panel.id, ref: panel.ref, _managed: panel };
  }

  attachPanel(detached: DetachedGroupPanel, index?: number, activate = true): PanelRef {
    if (this._disposed) throw new Error(`EditorGroup ${this.id} is disposed`);
    const panel = detached._managed;
    panel.groupId = this.id;
    panel.owner = this;
    panel.lastWidth = -1;
    panel.lastHeight = -1;

    this._insertManaged(panel, index);
    this.bodyElement.appendChild(panel.component.element);

    if (activate || this._activePanelId === undefined) {
      this._setActivePanelInternal(panel.id, false);
    }

    this._syncPanelVisibility();
    this._renderHeader();
    this._notifyDimensions();
    this._onDidChange.fire();
    return panel.ref;
  }

  removePanel(panelId: string): boolean {
    const idx = this._panels.findIndex((p) => p.id === panelId);
    if (idx < 0) return false;
    const panel = this._panels[idx]!;
    this._panels.splice(idx, 1);
    panel.owner = undefined;

    if (panel.visible) {
      panel.visible = false;
      panel.visibilityEmitter.fire(false);
    }
    panel.component.element.remove();
    panel.component.dispose();
    panel.visibilityEmitter.dispose();
    panel.dimensionsEmitter.dispose();

    if (this._activePanelId === panelId) {
      const nextId = pickAdjacentTabId(this.getPanelIds(), idx);
      this._setActivePanelInternal(nextId, false);
    }

    this._syncPanelVisibility();
    this._renderHeader();
    this._notifyDimensions();
    this._onDidClosePanel.fire(panelId);
    this._onDidChange.fire();
    if (this._panels.length === 0) {
      this._onDidEmpty.fire();
    }
    return true;
  }

  setActivePanel(panelId: string, focusComponent = false): void {
    const panel = this._findPanel(panelId);
    if (!panel) return;
    const changed = this._setActivePanelInternal(panelId, focusComponent);
    if (changed) {
      this._syncPanelVisibility();
      this._renderHeader();
      this._notifyDimensions();
      this._onDidChange.fire();
    } else if (focusComponent) {
      panel.component.focus?.();
    }
    this._onDidFocus.fire();
  }

  reorderTab(fromIdx: number, toIdx: number): boolean {
    if (
      fromIdx < 0 ||
      fromIdx >= this._panels.length ||
      toIdx < 0 ||
      toIdx >= this._panels.length ||
      fromIdx === toIdx
    ) {
      return false;
    }
    const moved = this._panels[fromIdx]!;
    this._panels = reorderList(this._panels, fromIdx, toIdx);
    this._renderHeader();
    this._onDidReorderTab.fire({ fromIndex: fromIdx, toIndex: toIdx, panelId: moved.id });
    this._onDidChange.fire();
    return true;
  }

  toLeafState(): GridLeafState {
    return {
      type: 'leaf',
      group: this.id,
      panels: this.getPanelIds(),
      ...(this._activePanelId !== undefined ? { activePanel: this._activePanelId } : {}),
    };
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    for (const panel of this._panels) {
      panel.owner = undefined;
      if (panel.visible) {
        panel.visible = false;
        panel.visibilityEmitter.fire(false);
      }
      panel.component.element.remove();
      panel.component.dispose();
      panel.visibilityEmitter.dispose();
      panel.dimensionsEmitter.dispose();
    }
    this._panels = [];
    this._activePanelId = undefined;
    this.headerElement.replaceChildren();
    this.bodyElement.replaceChildren();
    this.element.remove();
    this._disposables.dispose();
  }

  private _createManagedPanel(options: EditorGroupAddPanelOptions): ManagedPanel {
    const visibilityEmitter = new Emitter<boolean>();
    const dimensionsEmitter = new Emitter<{ readonly width: number; readonly height: number }>();

    const managed: ManagedPanel = {
      id: options.id,
      componentName: options.componentName,
      component: options.component,
      title: options.title,
      badge: options.badge ?? null,
      dirty: options.dirty ?? false,
      closable: options.closable ?? true,
      params: options.params,
      groupId: this.id,
      visible: false,
      lastWidth: -1,
      lastHeight: -1,
      visibilityEmitter,
      dimensionsEmitter,
      owner: this,
      ref: undefined as unknown as PanelRef,
    };

    const ref: PanelRef = {
      get id() {
        return managed.id;
      },
      get group() {
        return managed.groupId;
      },
      get params() {
        return managed.params;
      },
      onDidVisibilityChange: visibilityEmitter.event,
      onDidDimensionsChange: dimensionsEmitter.event,
      setTitle: (title: string) => {
        managed.owner?.setTitle(managed.id, title);
      },
      setBadge: (n: number | null) => {
        managed.owner?.setBadge(managed.id, n);
      },
      focus: () => {
        managed.owner?.setActivePanel(managed.id, true);
      },
      close: () => {
        managed.owner?.removePanel(managed.id);
      },
    };
    (managed as { ref: PanelRef }).ref = ref;
    return managed;
  }

  private _insertManaged(panel: ManagedPanel, index?: number): void {
    const existingIdx = this._panels.findIndex((p) => p.id === panel.id);
    if (existingIdx >= 0) this._panels.splice(existingIdx, 1);
    if (index === undefined || index < 0 || index >= this._panels.length) {
      this._panels.push(panel);
    } else {
      this._panels.splice(index, 0, panel);
    }
  }

  private _findPanel(panelId: string | undefined): ManagedPanel | undefined {
    if (!panelId) return undefined;
    return this._panels.find((p) => p.id === panelId);
  }

  private _toTabInfo(panel: ManagedPanel): EditorGroupTabInfo {
    return {
      id: panel.id,
      componentName: panel.componentName,
      title: panel.title,
      badge: panel.badge,
      dirty: panel.dirty,
      closable: panel.closable,
      params: panel.params,
    };
  }

  private _setActivePanelInternal(panelId: string | undefined, focusComponent: boolean): boolean {
    if (this._activePanelId === panelId) return false;
    this._activePanelId = panelId;
    const panel = this._findPanel(panelId);
    if (focusComponent) {
      panel?.component.focus?.();
    }
    this._onDidActivePanelChange.fire(panel?.ref);
    return true;
  }

  private _syncPanelVisibility(): void {
    for (const panel of this._panels) {
      const nextVisible = this._visible && panel.id === this._activePanelId;
      panel.component.element.hidden = !nextVisible;
      if (panel.visible !== nextVisible) {
        panel.visible = nextVisible;
        panel.visibilityEmitter.fire(nextVisible);
      }
    }
  }

  private _notifyDimensions(): void {
    if (this._width === 0 && this._height === 0) return;
    for (const panel of this._panels) {
      if (!panel.visible) continue;
      if (panel.lastWidth !== this._width || panel.lastHeight !== this._height) {
        panel.lastWidth = this._width;
        panel.lastHeight = this._height;
        panel.dimensionsEmitter.fire({ width: this._width, height: this._height });
      }
    }
  }

  private _renderHeader(): void {
    this._headerDisposables.clear();
    const multi = this._panels.length >= 2;
    const showTabBar = multi || (this._alwaysShowTabs && this._panels.length >= 1);
    this.headerElement.classList.toggle('wb-single-tab', !multi);
    this.headerElement.classList.toggle('wb-multi-tab', multi);
    this.headerElement.classList.toggle('wb-tab-bar', showTabBar);
    this.headerElement.replaceChildren();

    if (!showTabBar) {
      const only = this._panels[0];
      if (this._renderSingleHeader) {
        this._renderSingleHeader(this.headerElement, only ? this._toTabInfo(only) : undefined, {
          focus: (id) => this.setActivePanel(id, true),
          close: (id) => {
            this.removePanel(id);
          },
          reorder: (from, to) => {
            this.reorderTab(from, to);
          },
        });
        return;
      }
      this._renderDefaultSingleHeader(only);
      return;
    }

    this._renderMultiTabStrip();
  }

  private _renderDefaultSingleHeader(panel: ManagedPanel | undefined): void {
    const titleEl = this._doc.createElement('span');
    titleEl.className = 'wb-group-title';
    titleEl.textContent = panel?.title ?? '';
    this.headerElement.appendChild(titleEl);

    if (!panel) return;
    if (panel.dirty) {
      this.headerElement.appendChild(this._createDirtyDot());
    }
    if (panel.badge !== null && panel.badge > 0) {
      this.headerElement.appendChild(this._createBadge(panel.badge));
    }
  }

  private _renderMultiTabStrip(): void {
    const strip = this._doc.createElement('div');
    strip.className = 'wb-tab-strip';
    strip.setAttribute('role', 'tablist');

    for (let i = 0; i < this._panels.length; i++) {
      const panel = this._panels[i]!;
      strip.appendChild(this._createTabElement(panel, i, strip));
    }
    this.headerElement.appendChild(strip);
  }

  private _createTabElement(panel: ManagedPanel, index: number, strip: HTMLElement): HTMLButtonElement {
    const isActive = panel.id === this._activePanelId;
    const btn = this._doc.createElement('button');
    btn.type = 'button';
    btn.className = `wb-tab${isActive ? ' is-active' : ''}${panel.dirty ? ' is-dirty' : ''}`;
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', String(isActive));
    btn.dataset.panelId = panel.id;
    btn.dataset.tabIndex = String(index);

    const iconName = resolveEditorTabIconName(panel.componentName);
    const iconMarkup = iconName ? this._resolveIcon(iconName) : '';
    if (iconMarkup) {
      const iconEl = this._doc.createElement('span');
      iconEl.className = 'wb-tab-icon';
      iconEl.innerHTML = iconMarkup;
      btn.appendChild(iconEl);
    }

    const label = this._doc.createElement('span');
    label.className = 'wb-tab-label';
    label.textContent = panel.title;
    btn.appendChild(label);

    if (panel.dirty) {
      btn.appendChild(this._createDirtyDot());
    }
    if (panel.badge !== null && panel.badge > 0) {
      btn.appendChild(this._createBadge(panel.badge));
    }

    let closeEl: HTMLSpanElement | undefined;
    if (panel.closable) {
      closeEl = this._createCloseButton(panel.title);
      btn.appendChild(closeEl);
    }

    this._bindTabEvents(btn, closeEl, panel, index, strip);
    return btn;
  }

  private _bindTabEvents(
    btn: HTMLButtonElement,
    closeEl: HTMLSpanElement | undefined,
    panel: ManagedPanel,
    index: number,
    strip: HTMLElement,
  ): void {
    this._headerDisposables.add(
      addDisposableListener(btn, 'click', (ev) => {
        if (closeEl && ev.target instanceof Node && closeEl.contains(ev.target)) {
          ev.stopPropagation();
          this.removePanel(panel.id);
          return;
        }
        this.setActivePanel(panel.id, true);
      }),
    );

    this._headerDisposables.add(
      addDisposableListener(btn, 'auxclick', (ev) => {
        if (ev.button === 1 && panel.closable) {
          ev.preventDefault();
          ev.stopPropagation();
          this.removePanel(panel.id);
        }
      }),
    );

    this._headerDisposables.add(
      addDisposableListener(btn, 'pointerdown', (ev) => {
        if (ev.button === 1) {
          ev.preventDefault();
          return;
        }
        if (ev.button !== 0 && ev.pointerType === 'mouse') return;
        if (closeEl && ev.target instanceof Node && closeEl.contains(ev.target)) return;
        this._onTabPointerDown?.({
          groupId: this.id,
          panelId: panel.id,
          index,
          event: ev,
          tabElement: btn,
        });
      }),
    );

    this._headerDisposables.add(
      addDisposableListener(btn, 'keydown', (ev) => {
        this._handleTabKeydown(ev, index, strip);
      }),
    );
  }

  private _handleTabKeydown(ev: KeyboardEvent, index: number, strip: HTMLElement): void {
    const len = this._panels.length;
    if (len < 2) return;
    let nextIdx = -1;
    if (ev.key === 'ArrowRight') nextIdx = (index + 1) % len;
    else if (ev.key === 'ArrowLeft') nextIdx = (index - 1 + len) % len;
    else if (ev.key === 'Home') nextIdx = 0;
    else if (ev.key === 'End') nextIdx = len - 1;
    if (nextIdx < 0) return;

    const target = this._panels[nextIdx];
    if (!target) return;
    ev.preventDefault();
    this.setActivePanel(target.id, false);
    const nextBtn = strip.querySelector<HTMLElement>(`[data-panel-id="${target.id}"]`);
    focusSafely(nextBtn);
  }

  private _createDirtyDot(): HTMLSpanElement {
    const dot = this._doc.createElement('span');
    dot.className = 'wb-tab-dirty';
    dot.setAttribute('aria-label', 'Unsaved');
    return dot;
  }

  private _createBadge(count: number): HTMLSpanElement {
    const badge = this._doc.createElement('span');
    badge.className = 'wb-badge';
    badge.textContent = String(count);
    return badge;
  }

  private _createCloseButton(title: string): HTMLSpanElement {
    const close = this._doc.createElement('span');
    close.className = 'wb-tab-close';
    close.setAttribute('role', 'button');
    close.setAttribute('aria-label', `Close ${title}`);
    close.innerHTML = this._resolveIcon('cross') || CLOSE_SVG;
    return close;
  }
}
