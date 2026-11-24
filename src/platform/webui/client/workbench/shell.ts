import { addDisposableListener, observeResize } from '../base/dom.js';
import { Emitter, type Event } from '../base/event.js';
import { type Disposable, DisposableStore, toDisposable } from '../base/lifecycle.js';
import type {
  EditorContribution,
  OpenEditorOptions,
  TopicToolContribution,
  ViewContribution,
} from '../plugins/api.js';
import type { ContributionRegistry } from '../plugins/registry.js';
import { StorageService } from '../services/storage.js';
import type { DockEngine, LayoutState, PanelRef, PartId } from './contracts.js';
import { SplitView } from './dock/splitview.js';
import { MAIN_GROUP_ID, StaticDockEngine } from './dock/static.js';
import { ActivityBarPart, type ActivityBarItem } from './parts/activity-bar.js';
import { PanelPart } from './parts/panel-part.js';
import { SecondaryPart } from './parts/secondary-part.js';
import { SidebarPart } from './parts/sidebar-part.js';
import { StatusBarPart, type StatusBarItem } from './parts/status-bar.js';
import { StackShell, type StackNavTab, type StackToolItem } from './stack-shell.js';

export const LAYOUT_STORAGE_KEY = 'aa_layout';
export const SPLIT_STORAGE_KEY = 'aa_split_sizes';

export const DESKTOP_BREAKPOINT = 1024;
export const MOBILE_BREAKPOINT = 640;
export const MIN_EDITOR_WIDTH = 640;
export const ACTIVITY_BAR_WIDTH = 52;
export const STATUS_BAR_HEIGHT = 22;

export type ShellMode = 'desktop' | 'tablet' | 'mobile';

export function resolveShellMode(width: number): ShellMode {
  if (width < MOBILE_BREAKPOINT) return 'mobile';
  if (width < DESKTOP_BREAKPOINT) return 'tablet';
  return 'desktop';
}

export interface WorkbenchShellOptions {
  readonly root: HTMLElement;
  readonly doc?: Document;
  readonly win?: Window;
  readonly storage?: StorageService;
  readonly registry?: ContributionRegistry;
  readonly resolveIcon?: (name: string) => string;
  readonly initialWidth?: number;
  readonly initialHeight?: number;
}

export interface OpenEditorRequest extends OpenEditorOptions {
  readonly id?: string;
}

export class WorkbenchShell implements Disposable {
  readonly root: HTMLElement;
  readonly activityBar: ActivityBarPart;
  readonly sidebar: SidebarPart;
  readonly secondary: SecondaryPart;
  readonly panel: PanelPart;
  readonly statusBar: StatusBarPart;
  readonly dock: StaticDockEngine;

  private readonly _doc: Document;
  private readonly _win: Window | null;
  private readonly _storage: StorageService;
  private readonly _resolveIcon?: (name: string) => string;
  private readonly _desktopShell: HTMLElement;
  private readonly _workspaceEl: HTMLElement;
  private readonly _centerEl: HTMLElement;
  private readonly _editorContainer: HTMLElement;
  private readonly _backdrop: HTMLElement;
  private readonly _splitView: SplitView;
  private _stackShell: StackShell | undefined;

  private readonly _views = new Map<string, ViewContribution>();
  private readonly _editors = new Map<string, EditorContribution>();
  private readonly _tools = new Map<string, TopicToolContribution>();

  private readonly _disposables = new DisposableStore();
  private readonly _onDidModeChange = new Emitter<ShellMode>();
  private _mode: ShellMode;
  private _width: number;
  private _height: number;
  private _sidebarAutoCollapsed = false;
  private _editorSeq = 0;

  readonly onDidModeChange: Event<ShellMode> = this._onDidModeChange.event;

  readonly editors = {
    register: (e: EditorContribution): Disposable => this._registerEditor(e),
    open: (kind: string, input: unknown, opts?: OpenEditorRequest): PanelRef | undefined =>
      this._openEditor(kind, input, opts),
    close: (id: string): void => this.dock.removePanel(id),
    active: (): PanelRef | undefined => {
      const id = this.dock.getActiveGroupPanel();
      return id ? this.dock.getPanel(id) : undefined;
    },
  };

  readonly views = {
    register: (v: ViewContribution): Disposable => this._registerView(v),
    reveal: (id: string): PanelRef | undefined => this._revealView(id),
    active: (part: PartId = 'sidebar'): string | undefined => this.dock.getActivePartPanel(part),
  };

  readonly tools = {
    register: (t: TopicToolContribution): Disposable => this._registerTool(t),
    open: (id: string, params?: unknown): PanelRef | undefined => this._openTool(id, params),
    close: (id: string): void => this._closeTool(id),
    toggle: (id: string, params?: unknown): boolean => this._toggleTool(id, params),
    list: (): readonly TopicToolContribution[] => [...this._tools.values()],
  };

  readonly activity = {
    register: (a: ActivityBarItem): Disposable => this.activityBar.registerItem(a),
    refreshBadges: (): void => {
      this.activityBar.refreshBadges();
      this._stackShell?.refreshBadges();
    },
    setActive: (id: string | undefined): void => this.activityBar.setActive(id),
  };

  readonly statusBarApi = {
    register: (s: StatusBarItem): Disposable => this.statusBar.registerItem(s),
    refresh: (id?: string): void => this.statusBar.refresh(id),
  };

  constructor(options: WorkbenchShellOptions) {
    this.root = options.root;
    this._doc = options.doc ?? options.root.ownerDocument;
    this._win = options.win ?? this._doc.defaultView;
    this._storage = options.storage ?? new StorageService();
    this._resolveIcon = options.resolveIcon;

    this._width = options.initialWidth ?? this._win?.innerWidth ?? DESKTOP_BREAKPOINT;
    this._height = options.initialHeight ?? this._win?.innerHeight ?? 800;
    this._mode = resolveShellMode(this._width);

    this.activityBar = new ActivityBarPart({ doc: this._doc, resolveIcon: this._resolveIcon });
    this.sidebar = new SidebarPart({ doc: this._doc, resolveIcon: this._resolveIcon });
    this.secondary = new SecondaryPart({ doc: this._doc, resolveIcon: this._resolveIcon });
    this.panel = new PanelPart({ doc: this._doc, resolveIcon: this._resolveIcon });
    this.statusBar = new StatusBarPart({ doc: this._doc });

    this._desktopShell = this._doc.createElement('div');
    this._desktopShell.className = 'wb-shell';

    this._workspaceEl = this._doc.createElement('div');
    this._workspaceEl.className = 'wb-workspace';

    this._centerEl = this._doc.createElement('div');
    this._centerEl.className = 'wb-center';

    this._editorContainer = this._doc.createElement('section');
    this._editorContainer.className = 'wb-editor-area';
    this._centerEl.append(this._editorContainer, this.panel.element);

    this._backdrop = this._doc.createElement('div');
    this._backdrop.className = 'wb-drawer-backdrop';
    this._backdrop.hidden = true;

    this._splitView = new SplitView({
      container: this._workspaceEl,
      orientation: 'horizontal',
      storage: this._storage,
      storageKey: SPLIT_STORAGE_KEY,
      panes: [
        {
          id: 'sidebar',
          element: this.sidebar.element,
          minSize: 180,
          maxSize: 480,
          defaultSize: 264,
          visible: true,
          priority: 'low',
        },
        {
          id: 'center',
          element: this._centerEl,
          minSize: 320,
          defaultSize: 640,
          visible: true,
          priority: 'high',
        },
        {
          id: 'secondary',
          element: this.secondary.element,
          minSize: 280,
          maxSize: 720,
          defaultSize: 420,
          visible: false,
          priority: 'normal',
        },
      ],
    });

    this.dock = new StaticDockEngine({
      doc: this._doc,
      editorContainer: this._editorContainer,
      parts: {
        sidebar: this.sidebar,
        secondary: this.secondary,
        panel: this.panel,
      },
      partSizes: {
        sidebar: this._splitView.getPreferredPaneSize('sidebar') || 264,
        secondary: this._splitView.getPreferredPaneSize('secondary') || 420,
        panel: this.panel.getHeight(),
      },
    });

    this._desktopShell.append(
      this.activityBar.element,
      this._workspaceEl,
      this.statusBar.element,
      this._backdrop,
    );
    this.root.classList.add('wb-root');
    this.root.replaceChildren(this._desktopShell);

    this._wireEvents();
    this._disposables.add(this._onDidModeChange);
    this._disposables.add(this.activityBar);
    this._disposables.add(this.sidebar);
    this._disposables.add(this.secondary);
    this._disposables.add(this.panel);
    this._disposables.add(this.statusBar);
    this._disposables.add(this._splitView);
    this._disposables.add(this.dock);

    if (options.registry) {
      this._disposables.add(this.attachRegistry(options.registry));
    }

    this.layout(this._width, this._height);
  }

  attachRegistry(registry: ContributionRegistry): Disposable {
    const store = new DisposableStore();
    const activitySubs = new DisposableStore();
    const viewSubs = new DisposableStore();
    const editorSubs = new DisposableStore();
    const toolSubs = new DisposableStore();
    const statusSubs = new DisposableStore();
    store.add(activitySubs);
    store.add(viewSubs);
    store.add(editorSubs);
    store.add(toolSubs);
    store.add(statusSubs);

    const syncActivities = (): void => {
      activitySubs.clear();
      const items = registry.listActivities();
      for (const item of items) {
        activitySubs.add(
          this.activityBar.registerItem({
            id: item.id,
            title: item.title,
            icon: item.icon,
            view: item.view,
            badge: item.badge,
            order: item.order,
            section: (item.order ?? 0) >= 100 ? 'bottom' : 'top',
          }),
        );
      }
      this._syncMobileTabs(items);
    };

    const syncViews = (): void => {
      viewSubs.clear();
      for (const view of registry.listViews()) {
        viewSubs.add(this._registerView(view));
      }
    };

    const syncEditors = (): void => {
      editorSubs.clear();
      for (const editor of registry.listEditors()) {
        editorSubs.add(this._registerEditor(editor));
      }
    };

    const syncTools = (): void => {
      toolSubs.clear();
      for (const tool of registry.listTopicTools()) {
        toolSubs.add(this._registerTool(tool));
      }
    };

    const syncStatusBar = (): void => {
      statusSubs.clear();
      for (const item of registry.listStatusBar()) {
        statusSubs.add(this.statusBar.registerItem(item));
      }
    };

    registry.setEditorOpener((kind, input, opts) => {
      this._openEditor(kind, input, opts);
    });
    store.add(
      toDisposable(() => {
        registry.setEditorOpener(undefined);
      }),
    );

    syncActivities();
    syncViews();
    syncEditors();
    syncTools();
    syncStatusBar();

    store.add(registry.onDidChangeActivity(syncActivities));
    store.add(
      registry.onDidChangeActivityBadges(() => {
        this.activity.refreshBadges();
      }),
    );
    store.add(registry.onDidChangeViews(syncViews));
    store.add(registry.onDidChangeEditors(syncEditors));
    store.add(registry.onDidChangeTopicTools(syncTools));
    store.add(registry.onDidChangeStatusBar(syncStatusBar));

    return store;
  }

  getDock(): DockEngine {
    return this.dock;
  }

  getMode(): ShellMode {
    return this._mode;
  }

  getStackShell(): StackShell {
    return this._ensureStackShell();
  }

  isPartVisible(part: PartId): boolean {
    return this.dock.isPartVisible(part);
  }

  setPartVisible(part: PartId, visible: boolean): void {
    if (part === 'sidebar') {
      this._sidebarAutoCollapsed = false;
      this.dock.setPartVisible('sidebar', visible);
      if (this._mode === 'tablet' && visible) {
        this.dock.setPartVisible('secondary', false);
      }
      this._syncLayout();
      return;
    }

    if (part === 'secondary') {
      if (visible) {
        this._maybeAutoCollapseSidebar();
        if (this._mode === 'tablet') {
          this.dock.setPartVisible('sidebar', false);
        }
        this.dock.setPartVisible('secondary', true);
      } else {
        this.dock.setPartVisible('secondary', false);
        this._maybeRestoreSidebar();
      }
      this._syncLayout();
      return;
    }

    this.dock.setPartVisible(part, visible);
    this._syncLayout();
  }

  layout(width?: number, height?: number): void {
    const nextW = Math.max(0, Math.round(width ?? this._win?.innerWidth ?? this._width));
    const nextH = Math.max(0, Math.round(height ?? this._win?.innerHeight ?? this._height));
    const prevMode = this._mode;
    const nextMode = resolveShellMode(nextW);

    this._width = nextW;
    this._height = nextH;
    this._mode = nextMode;
    this.root.dataset.wbMode = nextMode;

    if (nextMode === 'mobile') {
      this._desktopShell.hidden = true;
      const stack = this._ensureStackShell();
      stack.element.hidden = false;
      this._backdrop.hidden = true;
    } else {
      this._desktopShell.hidden = false;
      if (this._stackShell) this._stackShell.element.hidden = true;
      if (nextMode === 'desktop' && this.dock.isPartVisible('secondary')) {
        this._maybeAutoCollapseSidebar();
      }
      this._syncLayout();
    }

    if (prevMode !== nextMode) {
      this._onDidModeChange.fire(nextMode);
    }
  }

  saveLayout(): void {
    this._storage.setJson(LAYOUT_STORAGE_KEY, this.dock.toJSON());
  }

  restoreLayout(): boolean {
    const saved = this._storage.getJson<LayoutState>(LAYOUT_STORAGE_KEY);
    if (!saved || saved.v !== 1) return false;
    this.dock.fromJSON(saved);
    this._syncLayout();
    return true;
  }

  resetLayout(): void {
    this._storage.remove(LAYOUT_STORAGE_KEY);
    this._storage.remove(SPLIT_STORAGE_KEY);
    this._sidebarAutoCollapsed = false;
    this._splitView.resetSizes();
    this.dock.exitMaximized();
    this.dock.setPartVisible('sidebar', true);
    this.dock.setPartVisible('secondary', false);
    this.dock.setPartVisible('panel', false);
    this._syncLayout();
  }

  openMobileDetail(title: string, tools: readonly StackToolItem[], activeToolId?: string): void {
    const stack = this._ensureStackShell();
    stack.openDetail({ title, tools, activeToolId });
  }

  setMobileTabs(tabs: readonly StackNavTab[]): void {
    this._ensureStackShell().setTabs(tabs);
  }

  dispose(): void {
    this._stackShell?.dispose();
    this._views.clear();
    this._editors.clear();
    this._tools.clear();
    this._disposables.dispose();
  }

  private _wireEvents(): void {
    this._disposables.add(
      this.activityBar.onDidSelect((item) => {
        const isCurrent =
          this.activityBar.getActive() === item.id && this.dock.isPartVisible('sidebar');
        if (isCurrent && this._mode !== 'mobile') {
          this.setPartVisible('sidebar', false);
          return;
        }
        this.activityBar.setActive(item.id);
        this._revealView(item.view);
      }),
    );

    this._disposables.add(
      this.sidebar.onDidSelectTab((panelId) => {
        this.dock.getPanel(panelId)?.focus();
      }),
    );
    this._disposables.add(
      this.sidebar.onDidRequestClose(() => {
        this.setPartVisible('sidebar', false);
      }),
    );

    this._disposables.add(
      this.secondary.onDidSelectTab((panelId) => {
        this.dock.getPanel(panelId)?.focus();
      }),
    );
    this._disposables.add(
      this.secondary.onDidRequestClose(() => {
        this.setPartVisible('secondary', false);
      }),
    );

    this._disposables.add(
      this.panel.onDidSelectTab((panelId) => {
        this.dock.getPanel(panelId)?.focus();
      }),
    );
    this._disposables.add(
      this.panel.onDidRequestClose(() => {
        this.setPartVisible('panel', false);
      }),
    );
    this._disposables.add(
      this.panel.onDidResize((h) => {
        this.dock.setPartSize('panel', h);
      }),
    );

    this._disposables.add(
      this._splitView.onDidChange(() => {
        if (this._mode !== 'desktop') return;
        const sb = this._splitView.getPreferredPaneSize('sidebar');
        const sec = this._splitView.getPreferredPaneSize('secondary');
        if (sb > 0) this.dock.setPartSize('sidebar', sb);
        if (sec > 0) this.dock.setPartSize('secondary', sec);
      }),
    );

    this._disposables.add(
      addDisposableListener(this._backdrop, 'click', () => {
        if (this._mode === 'tablet') {
          this.dock.setPartVisible('sidebar', false);
          this.dock.setPartVisible('secondary', false);
          this._syncLayout();
        }
      }),
    );

    if (this._win) {
      this._disposables.add(
        addDisposableListener(this._win, 'resize', () => {
          this.layout(this._win?.innerWidth, this._win?.innerHeight);
        }),
      );
    }

    this._disposables.add(
      observeResize(this.root, ({ width, height }) => {
        if (width > 0 && height > 0) this.layout(width, height);
      }),
    );
  }

  private _ensureStackShell(): StackShell {
    if (!this._stackShell) {
      this._stackShell = new StackShell({
        doc: this._doc,
        resolveIcon: this._resolveIcon,
      });
      this._stackShell.element.hidden = this._mode !== 'mobile';
      this.root.appendChild(this._stackShell.element);
    }
    return this._stackShell;
  }

  private _syncMobileTabs(
    activities: readonly { readonly id: string; readonly title: string; readonly icon: string; readonly view: string; readonly badge?: () => number | 'dot' | null }[],
  ): void {
    if (!this._stackShell || activities.length === 0) return;
    const primary = activities.slice(0, 3).map((a) => ({
      id: a.id,
      title: a.title,
      icon: a.icon,
      view: a.view,
      badge: a.badge,
    }));
    const extra = activities.slice(3);
    const tabs: StackNavTab[] = extra.length > 0
      ? [...primary, { id: extra[0]!.id, title: extra[0]!.title, icon: extra[0]!.icon, view: extra[0]!.view, badge: extra[0]!.badge }]
      : primary;
    this._stackShell.setTabs(tabs);
  }

  private _maybeAutoCollapseSidebar(): void {
    if (this._mode !== 'desktop') return;
    if (!this.dock.isPartVisible('sidebar')) return;
    const avail = Math.max(0, this._width - ACTIVITY_BAR_WIDTH);
    const sbW = this._splitView.getPreferredPaneSize('sidebar') || this.dock.getPartSize('sidebar');
    const secW =
      this._splitView.getPreferredPaneSize('secondary') || this.dock.getPartSize('secondary');
    if (avail - sbW - secW < MIN_EDITOR_WIDTH) {
      this._sidebarAutoCollapsed = true;
      this.dock.setPartVisible('sidebar', false);
    }
  }

  private _maybeRestoreSidebar(): void {
    if (!this._sidebarAutoCollapsed) return;
    this._sidebarAutoCollapsed = false;
    if (this._mode === 'desktop') {
      this.dock.setPartVisible('sidebar', true);
    }
  }

  private _syncLayout(): void {
    const sbVisible = this.dock.isPartVisible('sidebar');
    const secVisible = this.dock.isPartVisible('secondary');

    if (this._mode === 'tablet') {
      this._splitView.setPaneVisible('sidebar', false);
      this._splitView.setPaneVisible('secondary', false);
      this.sidebar.setVisible(sbVisible);
      this.secondary.setVisible(secVisible);
      this._backdrop.hidden = !(sbVisible || secVisible);
      this._splitView.layout(Math.max(0, this._width - ACTIVITY_BAR_WIDTH));
    } else {
      this._backdrop.hidden = true;
      this._splitView.setPaneVisible('sidebar', sbVisible);
      this._splitView.setPaneVisible('secondary', secVisible);
      this._splitView.layout(Math.max(0, this._width - ACTIVITY_BAR_WIDTH));
    }

    const workW = Math.max(0, this._width - ACTIVITY_BAR_WIDTH);
    const workH = Math.max(0, this._height - STATUS_BAR_HEIGHT);
    this.dock.layout(workW, workH);
  }

  private _registerView(v: ViewContribution): Disposable {
    const compName = `view:${v.id}`;
    const reg = this.dock.registerComponent(compName, v.component);
    this._views.set(v.id, v);
    return toDisposable(() => {
      this._views.delete(v.id);
      this.dock.removePanel(v.id);
      reg.dispose();
    });
  }

  private _revealView(id: string): PanelRef | undefined {
    const existing = this.dock.getPanel(id);
    const view = this._views.get(id);
    if (!view && !existing) return undefined;

    const part = view?.part ?? 'sidebar';
    if (existing) {
      this.setPartVisible(part, true);
      existing.focus();
      return existing;
    }

    this.setPartVisible(part, true);
    const ref = this.dock.addPanel({
      id: view!.id,
      component: `view:${view!.id}`,
      title: view!.title,
      position: { part },
    });
    if (part === 'sidebar') this.activityBar.setActive(view!.id);
    return ref;
  }

  private _registerEditor(e: EditorContribution): Disposable {
    const compName = `editor:${e.kind}`;
    const reg = this.dock.registerComponent(compName, e.component);
    this._editors.set(e.kind, e);
    return toDisposable(() => {
      this._editors.delete(e.kind);
      reg.dispose();
    });
  }

  private _openEditor(
    kind: string,
    input: unknown,
    opts?: OpenEditorRequest,
  ): PanelRef | undefined {
    const editor = this._editors.get(kind);
    if (!editor) return undefined;
    const id = opts?.id ?? `editor:${kind}:${++this._editorSeq}`;
    return this.dock.addPanel({
      id,
      component: `editor:${kind}`,
      title: editor.title(input),
      params: input,
      position: opts?.position ?? { group: MAIN_GROUP_ID },
    });
  }

  private _registerTool(t: TopicToolContribution): Disposable {
    const compName = `tool:${t.id}`;
    const reg = this.dock.registerComponent(compName, t.component);
    this._tools.set(t.id, t);
    return toDisposable(() => {
      this._tools.delete(t.id);
      this.dock.removePanel(`tool:${t.id}`);
      reg.dispose();
    });
  }

  private _openTool(id: string, params?: unknown): PanelRef | undefined {
    const tool = this._tools.get(id);
    if (!tool) return undefined;
    const panelId = `tool:${tool.id}`;
    this.setPartVisible(tool.defaultPart, true);
    const existing = this.dock.getPanel(panelId);
    if (existing) {
      existing.focus();
      return existing;
    }
    return this.dock.addPanel({
      id: panelId,
      component: `tool:${tool.id}`,
      title: tool.title,
      params,
      position: { part: tool.defaultPart },
    });
  }

  private _closeTool(id: string): void {
    const tool = this._tools.get(id);
    if (!tool) return;
    const panelId = `tool:${tool.id}`;
    this.dock.removePanel(panelId);
    if (this.dock.getPartPanels(tool.defaultPart).length === 0) {
      this.setPartVisible(tool.defaultPart, false);
    }
  }

  private _toggleTool(id: string, params?: unknown): boolean {
    const tool = this._tools.get(id);
    if (!tool) return false;
    const panelId = `tool:${tool.id}`;
    const partVisible = this.dock.isPartVisible(tool.defaultPart);
    const isActive = partVisible && this.dock.getActivePartPanel(tool.defaultPart) === panelId;
    if (isActive) {
      this.setPartVisible(tool.defaultPart, false);
      return false;
    }
    this._openTool(id, params);
    return true;
  }
}

export function mountWorkbench(
  doc: Document = document,
  options: Omit<WorkbenchShellOptions, 'root' | 'doc'> = {},
): WorkbenchShell | null {
  const root = doc.getElementById('workbench-root');
  if (!root) return null;
  return new WorkbenchShell({ ...options, root, doc });
}
