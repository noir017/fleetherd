import { addDisposableListener, observeResize } from '../base/dom.js';
import { Emitter, type Event } from '../base/event.js';
import { type Disposable, DisposableStore, toDisposable } from '../base/lifecycle.js';
import { createMenu, type MenuController } from '../components/menu/index.js';
import type {
  EditorContribution,
  OpenEditorOptions,
  TopicToolContribution,
  ViewContribution,
} from '../plugins/api.js';
import type { ContributionRegistry } from '../plugins/registry.js';
import type { CommandRegistry } from '../services/commands.js';
import type { KeybindingService } from '../services/keybindings.js';
import type { OverlayManager } from '../services/overlays.js';
import { StorageService } from '../services/storage.js';
import type { DockEngine, LayoutState, PanelRef, PartId } from './contracts.js';
import { DynamicDockEngine, MAIN_GROUP_ID } from './dock/engine.js';
import {
  buildMoveViewMenuItems,
  registerLayoutCommands,
} from './dock/layout-commands.js';
import {
  LAYOUT_STORAGE_KEY as SERIALIZE_LAYOUT_KEY,
  loadSavedLayout,
  resetSavedLayout,
} from './dock/serialize.js';
import { SplitView } from './dock/splitview.js';
import { ActivityBarPart, type ActivityBarItem } from './parts/activity-bar.js';
import { PanelPart } from './parts/panel-part.js';
import { SecondaryPart } from './parts/secondary-part.js';
import { SidebarPart } from './parts/sidebar-part.js';
import { StatusBarPart, type StatusBarItem } from './parts/status-bar.js';
import { StackShell, type StackNavTab, type StackToolItem } from './stack-shell.js';

export const LAYOUT_STORAGE_KEY = SERIALIZE_LAYOUT_KEY;
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

function isPartId(value: string): value is PartId {
  return value === 'sidebar' || value === 'secondary' || value === 'panel';
}

function createRegistryCommandAdapter(registry: ContributionRegistry): CommandRegistry {
  return {
    register: (id, run, meta) => registry.registerCommand(id, run, meta),
    has: (id) => registry.commands.has(id),
    get: (id) => registry.commands.get(id),
    list: () => registry.commands.list(),
    execute: (id, ...args) => registry.executeCommand(id, ...args),
    onDidChange: registry.commands.onDidChange,
    dispose: () => {},
  } as CommandRegistry;
}

export interface WorkbenchShellOptions {
  readonly root: HTMLElement;
  readonly doc?: Document;
  readonly win?: Window;
  readonly storage?: StorageService;
  readonly registry?: ContributionRegistry;
  readonly commands?: CommandRegistry;
  readonly keybindings?: KeybindingService;
  readonly overlays?: OverlayManager;
  readonly notify?: (message: string) => void;
  readonly autoSaveLayout?: boolean;
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
  readonly dock: DynamicDockEngine;

  private readonly _doc: Document;
  private readonly _win: Window | null;
  private readonly _storage: StorageService;
  private readonly _overlays?: OverlayManager;
  private readonly _notifyCallback?: (message: string) => void;
  private readonly _autoSaveLayout: boolean;
  private readonly _resolveIcon?: (name: string) => string;
  private readonly _desktopShell: HTMLElement;
  private readonly _workspaceEl: HTMLElement;
  private readonly _centerEl: HTMLElement;
  private readonly _editorContainer: HTMLElement;
  private readonly _backdrop: HTMLElement;
  private readonly _splitView: SplitView;
  private readonly _moveMenu: MenuController;
  private _stackShell: StackShell | undefined;
  private _commands: CommandRegistry | undefined;
  private _layoutCommandsRegistered = false;
  private _toastEl: HTMLElement | undefined;
  private _toastTimer: ReturnType<typeof setTimeout> | undefined;

  private readonly _views = new Map<string, ViewContribution>();
  private readonly _editors = new Map<string, EditorContribution>();
  private readonly _tools = new Map<string, TopicToolContribution>();

  private readonly _disposables = new DisposableStore();
  private readonly _onDidModeChange = new Emitter<ShellMode>();
  private readonly _onDidActiveTopicChange = new Emitter<string | undefined>();
  private _mode: ShellMode;
  private _width: number;
  private _height: number;
  private _sidebarAutoCollapsed = false;
  private _editorSeq = 0;
  private _pendingSavedLayout: LayoutState | null = null;
  private _suppressAutoSave = true;
  private _syncingLayout = false;

  readonly onDidModeChange: Event<ShellMode> = this._onDidModeChange.event;
  readonly onDidActiveTopicChange: Event<string | undefined> = this._onDidActiveTopicChange.event;

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
    this._overlays = options.overlays;
    this._notifyCallback = options.notify;
    this._autoSaveLayout = options.autoSaveLayout ?? true;
    this._resolveIcon = options.resolveIcon;
    this._commands = options.commands;

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

    this.dock = new DynamicDockEngine({
      doc: this._doc,
      editorContainer: this._editorContainer,
      dndHost: this._desktopShell,
      overlays: this._overlays,
      splitView: this._splitView,
      storage: this._storage,
      storageKey: LAYOUT_STORAGE_KEY,
      allowSplit: this._mode === 'desktop',
      resolveIcon: this._resolveIcon,
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
    this.dock.getDndController().setEnabled(this._mode !== 'mobile');

    this._moveMenu = createMenu({
      doc: this._doc,
      win: this._win ?? undefined,
      overlays: this._overlays,
      className: 'wb-view-move-menu',
    });

    this._desktopShell.append(
      this.activityBar.element,
      this._workspaceEl,
      this.statusBar.element,
      this._backdrop,
    );
    this.root.classList.add('wb-root');
    this.root.replaceChildren(this._desktopShell);

    this._loadInitialSavedLayout();
    this._wireEvents();
    this._disposables.add(this._onDidModeChange);
    this._disposables.add(this._onDidActiveTopicChange);
    this._disposables.add(this.activityBar);
    this._disposables.add(this.sidebar);
    this._disposables.add(this.secondary);
    this._disposables.add(this.panel);
    this._disposables.add(this.statusBar);
    this._disposables.add(this._splitView);
    this._disposables.add(this.dock);
    this._disposables.add(this._moveMenu);

    if (options.commands) {
      this._disposables.add(this._attachLayoutCommands(options.commands, options.keybindings));
    }

    if (options.registry) {
      this._disposables.add(this.attachRegistry(options.registry));
    }

    this.layout(this._width, this._height);
    this._suppressAutoSave = false;
  }

  attachRegistry(registry: ContributionRegistry): Disposable {
    const store = new DisposableStore();
    if (!this._commands) {
      this._commands = registry.commands;
    }
    if (!this._layoutCommandsRegistered) {
      store.add(this._attachLayoutCommands(createRegistryCommandAdapter(registry)));
    }
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

  getActiveTopicId(): string | undefined {
    return this.dock.getActiveTopicId();
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
    this.dock.setAllowSplit(nextMode === 'desktop');
    this.dock.getDndController().setEnabled(nextMode !== 'mobile');

    if (nextMode === 'mobile') {
      this._desktopShell.hidden = true;
      const stack = this._ensureStackShell();
      stack.element.hidden = false;
      this._backdrop.hidden = true;
    } else {
      this._desktopShell.hidden = false;
      if (this._stackShell) this._stackShell.element.hidden = true;
      if (nextMode === 'tablet' && this.dock.getGroups().length > 1) {
        this._collapseExtraGroups();
      }
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
    this.dock.saveToStorage(this._storage);
  }

  restoreLayout(): boolean {
    if (this._pendingSavedLayout) {
      return this._applyPendingSavedLayout();
    }
    const raw = this._storage.getRaw(LAYOUT_STORAGE_KEY);
    if (raw === null) return false;
    const saved = loadSavedLayout(this._storage, undefined, LAYOUT_STORAGE_KEY);
    if (!saved) {
      resetSavedLayout(this._storage, LAYOUT_STORAGE_KEY);
      return false;
    }
    this._applySavedLayout(saved);
    return true;
  }

  resetLayout(): void {
    this._pendingSavedLayout = null;
    const prevSuppress = this._suppressAutoSave;
    this._suppressAutoSave = true;
    try {
      resetSavedLayout(this._storage, LAYOUT_STORAGE_KEY);
      this._storage.remove(SPLIT_STORAGE_KEY);
      this._sidebarAutoCollapsed = false;
      this._splitView.resetSizes();
      this.dock.exitMaximized();
      this._collapseExtraGroups();
      this._restoreDefaultViewParts();
      this.dock.setPartVisible('sidebar', true);
      this.dock.setPartVisible('secondary', false);
      this.dock.setPartVisible('panel', false);
      this._syncLayout();
    } finally {
      this._suppressAutoSave = prevSuppress;
    }
  }

  openMobileDetail(title: string, tools: readonly StackToolItem[], activeToolId?: string): void {
    const stack = this._ensureStackShell();
    stack.openDetail({ title, tools, activeToolId });
  }

  setMobileTabs(tabs: readonly StackNavTab[]): void {
    this._ensureStackShell().setTabs(tabs);
  }

  dispose(): void {
    if (this._toastTimer) {
      clearTimeout(this._toastTimer);
      this._toastTimer = undefined;
    }
    this._toastEl?.remove();
    this._toastEl = undefined;
    this._stackShell?.dispose();
    this._views.clear();
    this._editors.clear();
    this._tools.clear();
    this._disposables.dispose();
  }

  private _loadInitialSavedLayout(): void {
    const raw = this._storage.getRaw(LAYOUT_STORAGE_KEY);
    if (raw === null) return;
    const saved = loadSavedLayout(this._storage, undefined, LAYOUT_STORAGE_KEY);
    if (!saved) {
      resetSavedLayout(this._storage, LAYOUT_STORAGE_KEY);
      return;
    }
    this._pendingSavedLayout = saved;
  }

  private _applyPendingSavedLayout(): boolean {
    const saved = this._pendingSavedLayout;
    if (!saved) return false;
    this._pendingSavedLayout = null;
    this._applySavedLayout(saved);
    return true;
  }

  private _applySavedLayout(saved: LayoutState): void {
    const prevSuppress = this._suppressAutoSave;
    this._suppressAutoSave = true;
    try {
      this.dock.fromJSON(saved);
      const panelHeight = this.dock.getPartSize('panel');
      if (panelHeight > 0) this.panel.setHeight(panelHeight);
      if (this._mode === 'tablet' && this.dock.getGroups().length > 1) {
        this._collapseExtraGroups();
      }
      this._syncLayout();
    } finally {
      this._suppressAutoSave = prevSuppress;
    }
  }

  private _attachLayoutCommands(
    commands: CommandRegistry,
    keybindings?: KeybindingService,
  ): Disposable {
    this._layoutCommandsRegistered = true;
    const reg = registerLayoutCommands({
      engine: this.dock,
      commands,
      keybindings,
      storage: this._storage,
      storageKey: LAYOUT_STORAGE_KEY,
      isSplitAllowed: () => this._mode === 'desktop' && this.dock.getAllowSplit(),
      notify: (msg) => this._notify(msg),
      setPartVisible: (part, visible) => this.setPartVisible(part, visible),
      onResetLayout: () => this.resetLayout(),
      getActiveViewId: () => this._getActiveViewId(),
    });
    return toDisposable(() => {
      reg.dispose();
      this._layoutCommandsRegistered = false;
    });
  }

  private _getActiveViewId(): string | undefined {
    for (const part of ['sidebar', 'secondary', 'panel'] as const) {
      if (!this.dock.isPartVisible(part)) continue;
      const active = this.dock.getActivePartPanel(part);
      if (active) return active;
    }
    return undefined;
  }

  private _openMoveViewMenu(part: PartId, anchor: HTMLElement, panelId: string): void {
    const items = buildMoveViewMenuItems(panelId, part, this.dock, {
      commands: this._commands,
      setPartVisible: (targetPart, visible) => this.setPartVisible(targetPart, visible),
    });
    if (items.length === 0) return;
    this._moveMenu.open(anchor, items);
  }

  private _notify(message: string): void {
    if (this._notifyCallback) {
      this._notifyCallback(message);
      return;
    }
    if (!this._toastEl) {
      this._toastEl = this._doc.createElement('div');
      this._toastEl.className = 'wb-toast';
      this._toastEl.setAttribute('role', 'status');
      this._toastEl.setAttribute('aria-live', 'polite');
      this._desktopShell.appendChild(this._toastEl);
    }
    this._toastEl.textContent = message;
    this._toastEl.hidden = false;
    if (this._toastTimer) clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => {
      if (this._toastEl) this._toastEl.hidden = true;
    }, 2500);
  }

  private _collapseExtraGroups(): void {
    const groups = this.dock.getGroups();
    if (groups.length <= 1) return;
    const targetId = this.dock.getActiveGroupId() ?? groups[0]!.id;
    for (const group of groups) {
      if (group.id === targetId) continue;
      for (const panelId of [...group.getPanelIds()]) {
        this.dock.movePanel(panelId, { group: targetId, direction: 'within' });
      }
    }
  }

  private _restoreDefaultViewParts(): void {
    for (const view of this._views.values()) {
      const panel = this.dock.getPanel(view.id);
      if (panel && panel.group !== view.part) {
        this.dock.movePanel(view.id, { part: view.part });
      }
    }
    for (const tool of this._tools.values()) {
      const panelId = `tool:${tool.id}`;
      const panel = this.dock.getPanel(panelId);
      if (panel && panel.group !== tool.defaultPart) {
        this.dock.movePanel(panelId, { part: tool.defaultPart });
      }
    }
  }

  private _wireEvents(): void {
    this._wirePartEvents();
    this._wireDockAndViewportEvents();
  }

  private _wirePartEvents(): void {
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

    const partPairs: readonly [PartId, SidebarPart | SecondaryPart | PanelPart][] = [
      ['sidebar', this.sidebar],
      ['secondary', this.secondary],
      ['panel', this.panel],
    ];
    for (const [partId, host] of partPairs) {
      this._disposables.add(
        host.onDidSelectTab((panelId) => {
          this.dock.getPanel(panelId)?.focus();
        }),
      );
      this._disposables.add(
        host.onDidRequestClose(() => {
          this.setPartVisible(partId, false);
        }),
      );
      this._disposables.add(
        host.onDidRequestMoveMenu(({ anchor, panelId }) => {
          this._openMoveViewMenu(partId, anchor, panelId);
        }),
      );
    }

    this._disposables.add(
      this.panel.onDidResize((h) => {
        this.dock.setPartSize('panel', h);
      }),
    );
  }

  private _wireDockAndViewportEvents(): void {
    this._disposables.add(
      this.dock.onDidActiveTopicChange((topicId) => {
        this._onDidActiveTopicChange.fire(topicId);
      }),
    );

    this._disposables.add(
      this.dock.onDidLayoutChange(() => {
        this._syncLayout();
        if (this._autoSaveLayout && !this._suppressAutoSave && !this._pendingSavedLayout) {
          this.saveLayout();
        }
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
    if (this._syncingLayout) return;
    this._syncingLayout = true;
    try {
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
    } finally {
      this._syncingLayout = false;
    }
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
    this._applyPendingSavedLayout();
    const existing = this.dock.getPanel(id);
    const view = this._views.get(id);
    if (!view && !existing) return undefined;

    if (existing) {
      const targetPart = isPartId(existing.group) ? existing.group : (view?.part ?? 'sidebar');
      this.setPartVisible(targetPart, true);
      existing.focus();
      return existing;
    }

    const part = view!.part;
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
    this._applyPendingSavedLayout();
    const editor = this._editors.get(kind);
    if (!editor) return undefined;
    const id = opts?.id ?? `editor:${kind}:${++this._editorSeq}`;
    const activeGroup = this.dock.getActiveGroupId() ?? MAIN_GROUP_ID;
    return this.dock.addPanel({
      id,
      component: `editor:${kind}`,
      title: editor.title(input),
      params: input,
      position: opts?.position ?? { group: activeGroup },
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
    this._applyPendingSavedLayout();
    const tool = this._tools.get(id);
    if (!tool) return undefined;
    const panelId = `tool:${tool.id}`;
    const existing = this.dock.getPanel(panelId);
    if (existing) {
      const part = isPartId(existing.group) ? existing.group : tool.defaultPart;
      this.setPartVisible(part, true);
      existing.focus();
      return existing;
    }
    this.setPartVisible(tool.defaultPart, true);
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
    const existing = this.dock.getPanel(panelId);
    const part = existing && isPartId(existing.group) ? existing.group : tool.defaultPart;
    this.dock.removePanel(panelId);
    if (this.dock.getPartPanels(part).length === 0) {
      this.setPartVisible(part, false);
    }
  }

  private _toggleTool(id: string, params?: unknown): boolean {
    this._applyPendingSavedLayout();
    const tool = this._tools.get(id);
    if (!tool) return false;
    const panelId = `tool:${tool.id}`;
    const existing = this.dock.getPanel(panelId);
    const part = existing && isPartId(existing.group) ? existing.group : tool.defaultPart;
    const partVisible = this.dock.isPartVisible(part);
    const isActive = partVisible && this.dock.getActivePartPanel(part) === panelId;
    if (isActive) {
      this.setPartVisible(part, false);
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
