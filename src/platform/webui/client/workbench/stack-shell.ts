import { addDisposableListener } from '../base/dom.js';
import { Emitter, type Event } from '../base/event.js';
import { type Disposable, DisposableStore, toDisposable } from '../base/lifecycle.js';
import type { PanelComponent, PanelRef } from './contracts.js';

export type StackMode = 'list' | 'detail';

export interface StackNavTab {
  readonly id: string;
  readonly title: string;
  readonly icon: string;
  readonly view: string;
  readonly badge?: () => number | 'dot' | null;
}

export interface StackToolItem {
  readonly id: string;
  readonly title: string;
  readonly badge?: number | null;
  readonly component: PanelComponent;
  readonly params?: unknown;
}

export interface StackShellOptions {
  readonly doc?: Document;
  readonly tabs?: readonly StackNavTab[];
  readonly resolveIcon?: (name: string) => string;
}

const DEFAULT_TABS: readonly StackNavTab[] = [
  { id: 'topics', title: 'Topics', icon: 'chat', view: 'topics' },
  { id: 'history', title: 'History', icon: 'history', view: 'history' },
  { id: 'schedules', title: 'Scheduled', icon: 'clock', view: 'schedules' },
  { id: 'more', title: 'More', icon: 'more', view: 'more' },
];

function defaultResolveIcon(_name: string): string {
  return '';
}

function createNoopPanelRef(id: string, params: unknown, onClose: () => void): PanelRef {
  const vis = new Emitter<boolean>();
  const dim = new Emitter<{ readonly width: number; readonly height: number }>();
  return {
    id,
    group: 'stack',
    params,
    onDidVisibilityChange: vis.event,
    onDidDimensionsChange: dim.event,
    setTitle() {
      // Managed by stack shell header.
    },
    setBadge() {
      // Managed by stack shell tool strip.
    },
    focus() {
      // Focus handled by stack shell.
    },
    close: onClose,
  };
}

export class StackShell implements Disposable {
  readonly element: HTMLElement;
  private readonly _doc: Document;
  private readonly _resolveIcon: (name: string) => string;
  private readonly _listPage: HTMLElement;
  private readonly _listBody: HTMLElement;
  private readonly _tabBar: HTMLElement;
  private readonly _detailPage: HTMLElement;
  private readonly _detailHead: HTMLElement;
  private readonly _backBtn: HTMLButtonElement;
  private readonly _detailTitle: HTMLElement;
  private readonly _toolsBar: HTMLElement;
  private readonly _detailBody: HTMLElement;

  private _tabs: StackNavTab[];
  private _activeTabId: string;
  private _mode: StackMode = 'list';
  private _tools: StackToolItem[] = [];
  private _activeToolId: string | undefined;
  private readonly _mountedViews = new Map<string, PanelComponent>();
  private readonly _initialized = new WeakSet<PanelComponent>();
  private readonly _tabButtons = new Map<string, HTMLButtonElement>();

  private readonly _disposables = new DisposableStore();
  private readonly _tabDisposables = new DisposableStore();
  private readonly _toolDisposables = new DisposableStore();
  private readonly _onDidModeChange = new Emitter<StackMode>();
  private readonly _onDidSelectTab = new Emitter<StackNavTab>();
  private readonly _onDidSelectTool = new Emitter<string>();

  readonly onDidModeChange: Event<StackMode> = this._onDidModeChange.event;
  readonly onDidSelectTab: Event<StackNavTab> = this._onDidSelectTab.event;
  readonly onDidSelectTool: Event<string> = this._onDidSelectTool.event;

  constructor(options: StackShellOptions = {}) {
    this._doc = options.doc ?? document;
    this._resolveIcon = options.resolveIcon ?? defaultResolveIcon;
    this._tabs = [...(options.tabs ?? DEFAULT_TABS)];
    this._activeTabId = this._tabs[0]?.id ?? 'topics';

    this.element = this._doc.createElement('div');
    this.element.className = 'wb-stack';
    this.element.dataset.stackMode = this._mode;

    this._listPage = this._doc.createElement('div');
    this._listPage.className = 'wb-stack-list-page';

    this._listBody = this._doc.createElement('div');
    this._listBody.className = 'wb-stack-body wb-stack-list-body';

    this._tabBar = this._doc.createElement('nav');
    this._tabBar.className = 'wb-stack-tabbar';
    this._tabBar.setAttribute('aria-label', 'Mobile navigation');

    this._listPage.append(this._listBody, this._tabBar);

    this._detailPage = this._doc.createElement('div');
    this._detailPage.className = 'wb-stack-detail-page';
    this._detailPage.hidden = true;

    this._detailHead = this._doc.createElement('div');
    this._detailHead.className = 'wb-stack-head';

    this._backBtn = this._doc.createElement('button');
    this._backBtn.type = 'button';
    this._backBtn.className = 'wb-icon-btn wb-stack-back';
    this._backBtn.setAttribute('aria-label', 'Back');
    const backSvg = this._resolveIcon('chevronLeft');
    if (backSvg) this._backBtn.innerHTML = backSvg;
    else this._backBtn.textContent = '<';

    this._detailTitle = this._doc.createElement('span');
    this._detailTitle.className = 'wb-stack-title';

    this._detailHead.append(this._backBtn, this._detailTitle);

    this._toolsBar = this._doc.createElement('div');
    this._toolsBar.className = 'wb-stack-tools';
    this._toolsBar.setAttribute('role', 'tablist');

    this._detailBody = this._doc.createElement('div');
    this._detailBody.className = 'wb-stack-body wb-stack-detail-body';

    this._detailPage.append(this._detailHead, this._toolsBar, this._detailBody);
    this.element.append(this._listPage, this._detailPage);

    this._disposables.add(this._onDidModeChange);
    this._disposables.add(this._onDidSelectTab);
    this._disposables.add(this._onDidSelectTool);
    this._disposables.add(this._tabDisposables);
    this._disposables.add(this._toolDisposables);
    this._disposables.add(
      addDisposableListener(this._backBtn, 'click', () => {
        this.backToList();
      }),
    );

    this._renderTabBar();
  }

  getMode(): StackMode {
    return this._mode;
  }

  getActiveTab(): string {
    return this._activeTabId;
  }

  getActiveTool(): string | undefined {
    return this._activeToolId;
  }

  getTabs(): readonly StackNavTab[] {
    return this._tabs;
  }

  setTabs(tabs: readonly StackNavTab[]): void {
    this._tabs = [...tabs];
    if (!this._tabs.some((t) => t.id === this._activeTabId)) {
      this._activeTabId = this._tabs[0]?.id ?? 'topics';
    }
    this._renderTabBar();
  }

  selectTab(tabId: string): void {
    const tab = this._tabs.find((t) => t.id === tabId || t.view === tabId);
    if (!tab) return;
    this._activeTabId = tab.id;
    this._syncTabActive();
    if (this._mode !== 'list') this.backToList();
    this._onDidSelectTab.fire(tab);
  }

  mountListView(id: string, component: PanelComponent, params?: unknown): Disposable {
    this._ensureInit(id, component, params, () => {
      this._mountedViews.delete(id);
      component.element.remove();
    });
    this._mountedViews.set(id, component);
    if (component.element.parentElement !== this._listBody) {
      this._listBody.appendChild(component.element);
    }
    for (const [viewId, comp] of this._mountedViews) {
      comp.element.hidden = viewId !== id;
    }
    return toDisposable(() => {
      if (this._mountedViews.get(id) === component) {
        this._mountedViews.delete(id);
      }
    });
  }

  openDetail(options: {
    readonly title: string;
    readonly tools: readonly StackToolItem[];
    readonly activeToolId?: string;
  }): void {
    this._detailTitle.textContent = options.title;
    this._tools = [...options.tools];
    this._activeToolId =
      options.activeToolId && this._tools.some((t) => t.id === options.activeToolId)
        ? options.activeToolId
        : this._tools[0]?.id;

    this._renderTools();
    this._mountActiveTool();
    this._setMode('detail');
  }

  selectTool(toolId: string): void {
    if (!this._tools.some((t) => t.id === toolId)) return;
    if (this._activeToolId === toolId) return;
    this._activeToolId = toolId;
    this._renderTools();
    this._mountActiveTool();
    this._onDidSelectTool.fire(toolId);
  }

  backToList(): void {
    if (this._mode === 'list') return;
    this._setMode('list');
  }

  refreshBadges(): void {
    for (const tab of this._tabs) {
      const btn = this._tabButtons.get(tab.id);
      if (!btn) continue;
      this._paintBadge(btn, tab.badge?.() ?? null);
    }
  }

  dispose(): void {
    this._mountedViews.clear();
    this._tools = [];
    this._tabButtons.clear();
    this._disposables.dispose();
  }

  private _setMode(next: StackMode): void {
    if (this._mode === next) return;
    this._mode = next;
    this.element.dataset.stackMode = next;
    this._listPage.hidden = next !== 'list';
    this._detailPage.hidden = next !== 'detail';
    this._onDidModeChange.fire(next);
  }

  private _ensureInit(
    id: string,
    component: PanelComponent,
    params: unknown,
    onClose: () => void,
  ): void {
    if (this._initialized.has(component)) {
      if (params !== undefined) component.update?.(params);
      return;
    }
    this._initialized.add(component);
    component.init(params, { id, api: createNoopPanelRef(id, params, onClose) });
  }

  private _renderTabBar(): void {
    this._tabDisposables.clear();
    this._tabButtons.clear();
    this._tabBar.replaceChildren();

    for (const tab of this._tabs) {
      const btn = this._doc.createElement('button');
      btn.type = 'button';
      btn.className = `wb-stack-tab${tab.id === this._activeTabId ? ' is-active' : ''}`;
      btn.dataset.tabId = tab.id;
      btn.dataset.viewId = tab.view;
      btn.setAttribute('aria-label', tab.title);

      const iconWrap = this._doc.createElement('span');
      iconWrap.className = 'wb-stack-tab-icon';
      const svg = this._resolveIcon(tab.icon);
      if (svg) iconWrap.innerHTML = svg;
      btn.appendChild(iconWrap);

      const label = this._doc.createElement('span');
      label.className = 'wb-stack-tab-label';
      label.textContent = tab.title;
      btn.appendChild(label);

      this._paintBadge(btn, tab.badge?.() ?? null);
      this._tabDisposables.add(
        addDisposableListener(btn, 'click', () => {
          this.selectTab(tab.id);
        }),
      );
      this._tabButtons.set(tab.id, btn);
      this._tabBar.appendChild(btn);
    }
  }

  private _syncTabActive(): void {
    for (const [id, btn] of this._tabButtons) {
      btn.classList.toggle('is-active', id === this._activeTabId);
    }
  }

  private _renderTools(): void {
    this._toolDisposables.clear();
    this._toolsBar.replaceChildren();
    this._toolsBar.hidden = this._tools.length === 0;

    for (const tool of this._tools) {
      const btn = this._doc.createElement('button');
      btn.type = 'button';
      btn.className = `wb-stack-tool${tool.id === this._activeToolId ? ' is-active' : ''}`;
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-selected', String(tool.id === this._activeToolId));
      btn.dataset.toolId = tool.id;
      btn.textContent = tool.title;

      if (tool.badge !== undefined && tool.badge !== null && tool.badge > 0) {
        const b = this._doc.createElement('span');
        b.className = 'wb-badge';
        b.textContent = String(tool.badge);
        btn.appendChild(b);
      }

      this._toolDisposables.add(
        addDisposableListener(btn, 'click', () => {
          this.selectTool(tool.id);
        }),
      );
      this._toolsBar.appendChild(btn);
    }
  }

  private _mountActiveTool(): void {
    this._detailBody.replaceChildren();
    const active = this._tools.find((t) => t.id === this._activeToolId);
    if (!active) return;
    this._ensureInit(active.id, active.component, active.params, () => this.backToList());
    active.component.element.hidden = false;
    this._detailBody.appendChild(active.component.element);
    active.component.focus?.();
  }

  private _paintBadge(btn: HTMLButtonElement, value: number | 'dot' | null): void {
    const existing = btn.querySelector('.wb-badge');
    if (value === null || value === 0) {
      existing?.remove();
      return;
    }
    const badge = existing ?? this._doc.createElement('span');
    badge.className = value === 'dot' ? 'wb-badge wb-badge-dot' : 'wb-badge';
    badge.textContent = value === 'dot' ? '' : value > 99 ? '99+' : String(value);
    if (!existing) btn.appendChild(badge);
  }
}
