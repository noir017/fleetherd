import { Emitter, type Event } from '../base/event.js';
import { html, render } from '../base/html.js';
import { type Disposable, DisposableStore, toDisposable } from '../base/lifecycle.js';
import { getLocale, matchLocale, type MessageKey, t as coreT } from '../i18n/index.js';
import type { ApiClient } from '../services/api.js';
import { CommandRegistry } from '../services/commands.js';
import type { KeybindingService } from '../services/keybindings.js';
import type { StorageService } from '../services/storage.js';
import type { PartId } from '../workbench/contracts.js';
import type {
  ActivityContribution,
  CommandMeta,
  EditorContribution,
  MenuItem,
  MenuLocation,
  OpenEditorOptions,
  PluginContext,
  SettingsSectionContribution,
  StatusBarContribution,
  TopicInfo,
  TopicToolContribution,
  ViewContribution,
  WebuiEvents,
} from './api.js';

export type ContributionKind =
  | 'views'
  | 'editors'
  | 'topicTools'
  | 'activity'
  | 'statusBar'
  | 'commands'
  | 'menus'
  | 'settings';

export type EditorOpener = (kind: string, input: unknown, opts?: OpenEditorOptions) => void;

export interface ContributionRegistryOptions {
  readonly commands?: CommandRegistry;
  readonly keybindings?: KeybindingService;
  readonly openEditor?: EditorOpener;
}

export interface ResolvedMenuItem {
  readonly item: MenuItem;
  readonly disabled: boolean;
  readonly disabledReason?: string;
}

interface Sequenced<T> {
  readonly item: T;
  readonly seq: number;
}

const VALID_PARTS = new Set<PartId>(['sidebar', 'secondary', 'panel']);
const VALID_MENU_LOCATIONS = new Set<MenuLocation>(['topic.row', 'topic.title', 'task.row', 'message']);
const VALID_ALIGN = new Set<'left' | 'right'>(['left', 'right']);

// Public read-only endpoints safe for external plugins to GET.
// Opt-in sensitive surfaces (/api/files/*, /api/instructions/*, /api/push, /api/login, /api/logout) are excluded.
export const DEFAULT_PUBLIC_READONLY_API_PATHS: ReadonlySet<string> = new Set<string>([
  '/api/topic',
  '/api/history',
  '/api/history/search',
  '/api/history/read',
  '/api/schedules',
  '/api/schedules/task',
  '/api/reviews',
  '/api/skills',
  '/api/models',
  '/api/options',
  '/api/git/status',
  '/api/git/file',
  '/api/git/branches',
  '/api/git/log',
  '/api/git/commit',
  '/api/git/commit-file',
  '/api/turn-changes/status',
  '/api/turn-changes/file',
]);

function assertNonEmpty(value: string, label: string): void {
  if (!value || !value.trim()) {
    throw new Error(`${label} must not be empty`);
  }
}

function assertValidPart(part: PartId, label: string): void {
  if (!VALID_PARTS.has(part)) {
    throw new Error(`Invalid ${label} part: ${String(part)}`);
  }
}

function compareOrder(a: Sequenced<{ readonly order?: number }>, b: Sequenced<{ readonly order?: number }>): number {
  const diff = (a.item.order ?? 0) - (b.item.order ?? 0);
  return diff !== 0 ? diff : a.seq - b.seq;
}

function compareMenuEntry(a: Sequenced<MenuItem>, b: Sequenced<MenuItem>): number {
  const ga = a.item.group ?? '\uffff';
  const gb = b.item.group ?? '\uffff';
  if (ga !== gb) return ga < gb ? -1 : 1;
  return compareOrder(a, b);
}

export class ContributionRegistry implements Disposable {
  private readonly _commands: CommandRegistry;
  private readonly _ownsCommands: boolean;
  private readonly _keybindings?: KeybindingService;
  private _openEditor?: EditorOpener;
  private _nextSeq = 1;

  private readonly _views = new Map<string, Sequenced<ViewContribution>>();
  private readonly _editors = new Map<string, EditorContribution>();
  private readonly _topicTools = new Map<string, Sequenced<TopicToolContribution>>();
  private readonly _activities = new Map<string, Sequenced<ActivityContribution>>();
  private readonly _statusBar = new Map<string, Sequenced<StatusBarContribution>>();
  private readonly _menus = new Map<MenuLocation, Map<string, Sequenced<MenuItem>>>([
    ['topic.row', new Map()],
    ['topic.title', new Map()],
    ['task.row', new Map()],
    ['message', new Map()],
  ]);
  private readonly _settings = new Map<string, Sequenced<SettingsSectionContribution>>();

  private readonly _onDidChange = new Emitter<ContributionKind>();
  private readonly _onDidChangeViews = new Emitter<void>();
  private readonly _onDidChangeEditors = new Emitter<void>();
  private readonly _onDidChangeTopicTools = new Emitter<void>();
  private readonly _onDidChangeActivity = new Emitter<void>();
  private readonly _onDidChangeActivityBadges = new Emitter<void>();
  private readonly _onDidChangeStatusBar = new Emitter<void>();
  private readonly _onDidChangeCommands = new Emitter<void>();
  private readonly _onDidChangeMenus = new Emitter<MenuLocation>();
  private readonly _onDidChangeSettings = new Emitter<void>();

  readonly onDidChange: Event<ContributionKind> = this._onDidChange.event;
  readonly onDidChangeViews: Event<void> = this._onDidChangeViews.event;
  readonly onDidChangeEditors: Event<void> = this._onDidChangeEditors.event;
  readonly onDidChangeTopicTools: Event<void> = this._onDidChangeTopicTools.event;
  readonly onDidChangeActivity: Event<void> = this._onDidChangeActivity.event;
  readonly onDidChangeActivityBadges: Event<void> = this._onDidChangeActivityBadges.event;
  readonly onDidChangeStatusBar: Event<void> = this._onDidChangeStatusBar.event;
  readonly onDidChangeCommands: Event<void> = this._onDidChangeCommands.event;
  readonly onDidChangeMenus: Event<MenuLocation> = this._onDidChangeMenus.event;
  readonly onDidChangeSettings: Event<void> = this._onDidChangeSettings.event;

  constructor(options: ContributionRegistryOptions = {}) {
    this._ownsCommands = !options.commands;
    this._commands = options.commands ?? new CommandRegistry();
    this._keybindings = options.keybindings;
    this._openEditor = options.openEditor;
  }

  get commands(): CommandRegistry {
    return this._commands;
  }

  setEditorOpener(opener: EditorOpener | undefined): void {
    this._openEditor = opener;
  }

  registerView(view: ViewContribution): Disposable {
    assertNonEmpty(view.id, 'View id');
    assertValidPart(view.part, 'view');
    if (this._views.has(view.id)) {
      throw new Error(`View already registered: ${view.id}`);
    }
    const entry: Sequenced<ViewContribution> = { item: view, seq: this._nextSeq++ };
    this._views.set(view.id, entry);
    this._onDidChangeViews.fire();
    this._onDidChange.fire('views');
    return toDisposable(() => {
      if (this._views.get(view.id) === entry) {
        this._views.delete(view.id);
        this._onDidChangeViews.fire();
        this._onDidChange.fire('views');
      }
    });
  }

  getView(id: string): ViewContribution | undefined {
    return this._views.get(id)?.item;
  }

  listViews(part?: PartId, options?: { readonly includeHidden?: boolean }): readonly ViewContribution[] {
    const includeHidden = options?.includeHidden === true;
    const out: ViewContribution[] = [];
    for (const entry of this._views.values()) {
      const view = entry.item;
      if (part !== undefined && view.part !== part) continue;
      if (!includeHidden && view.when && !view.when()) continue;
      out.push(view);
    }
    return out;
  }

  registerEditor(editor: EditorContribution): Disposable {
    assertNonEmpty(editor.kind, 'Editor kind');
    if (this._editors.has(editor.kind)) {
      throw new Error(`Editor already registered: ${editor.kind}`);
    }
    this._editors.set(editor.kind, editor);
    this._onDidChangeEditors.fire();
    this._onDidChange.fire('editors');
    return toDisposable(() => {
      if (this._editors.get(editor.kind) === editor) {
        this._editors.delete(editor.kind);
        this._onDidChangeEditors.fire();
        this._onDidChange.fire('editors');
      }
    });
  }

  getEditor(kind: string): EditorContribution | undefined {
    return this._editors.get(kind);
  }

  listEditors(): readonly EditorContribution[] {
    return [...this._editors.values()];
  }

  openEditor(kind: string, input: unknown, opts?: OpenEditorOptions): void {
    if (!this._editors.has(kind)) {
      throw new Error(`Unknown editor kind: ${kind}`);
    }
    if (!this._openEditor) {
      throw new Error(`Editor host is not configured for kind: ${kind}`);
    }
    this._openEditor(kind, input, opts);
  }

  registerTopicTool(tool: TopicToolContribution): Disposable {
    assertNonEmpty(tool.id, 'Topic tool id');
    assertValidPart(tool.defaultPart, 'topic tool');
    if (this._topicTools.has(tool.id)) {
      throw new Error(`Topic tool already registered: ${tool.id}`);
    }
    const entry: Sequenced<TopicToolContribution> = { item: tool, seq: this._nextSeq++ };
    this._topicTools.set(tool.id, entry);
    this._onDidChangeTopicTools.fire();
    this._onDidChange.fire('topicTools');
    return toDisposable(() => {
      if (this._topicTools.get(tool.id) === entry) {
        this._topicTools.delete(tool.id);
        this._onDidChangeTopicTools.fire();
        this._onDidChange.fire('topicTools');
      }
    });
  }

  getTopicTool(id: string): TopicToolContribution | undefined {
    return this._topicTools.get(id)?.item;
  }

  listTopicTools(defaultPart?: PartId): readonly TopicToolContribution[] {
    const out: TopicToolContribution[] = [];
    for (const entry of this._topicTools.values()) {
      if (defaultPart !== undefined && entry.item.defaultPart !== defaultPart) continue;
      out.push(entry.item);
    }
    return out;
  }

  listAvailableTopicTools(topic: TopicInfo | undefined, defaultPart?: PartId): readonly TopicToolContribution[] {
    if (!topic) return [];
    const out: TopicToolContribution[] = [];
    for (const entry of this._topicTools.values()) {
      const tool = entry.item;
      if (defaultPart !== undefined && tool.defaultPart !== defaultPart) continue;
      if (tool.available(topic)) out.push(tool);
    }
    return out;
  }

  registerActivity(activity: ActivityContribution): Disposable {
    assertNonEmpty(activity.id, 'Activity id');
    if (this._activities.has(activity.id)) {
      throw new Error(`Activity already registered: ${activity.id}`);
    }
    const entry: Sequenced<ActivityContribution> = { item: activity, seq: this._nextSeq++ };
    this._activities.set(activity.id, entry);
    this._onDidChangeActivity.fire();
    this._onDidChange.fire('activity');
    return toDisposable(() => {
      if (this._activities.get(activity.id) === entry) {
        this._activities.delete(activity.id);
        this._onDidChangeActivity.fire();
        this._onDidChange.fire('activity');
      }
    });
  }

  getActivity(id: string): ActivityContribution | undefined {
    return this._activities.get(id)?.item;
  }

  listActivities(): readonly ActivityContribution[] {
    return [...this._activities.values()].sort(compareOrder).map((entry) => entry.item);
  }

  getActivityBadge(id: string): number | 'dot' | null {
    const entry = this._activities.get(id);
    if (!entry?.item.badge) return null;
    return entry.item.badge();
  }

  refreshActivityBadges(): void {
    this._onDidChangeActivityBadges.fire();
  }

  registerStatusBar(item: StatusBarContribution): Disposable {
    assertNonEmpty(item.id, 'Status bar id');
    if (!VALID_ALIGN.has(item.align)) {
      throw new Error(`Invalid status bar align: ${String(item.align)}`);
    }
    if (this._statusBar.has(item.id)) {
      throw new Error(`Status bar item already registered: ${item.id}`);
    }
    const entry: Sequenced<StatusBarContribution> = { item, seq: this._nextSeq++ };
    this._statusBar.set(item.id, entry);
    this._onDidChangeStatusBar.fire();
    this._onDidChange.fire('statusBar');
    return toDisposable(() => {
      if (this._statusBar.get(item.id) === entry) {
        this._statusBar.delete(item.id);
        this._onDidChangeStatusBar.fire();
        this._onDidChange.fire('statusBar');
      }
    });
  }

  getStatusBar(id: string): StatusBarContribution | undefined {
    return this._statusBar.get(id)?.item;
  }

  listStatusBar(align?: 'left' | 'right'): readonly StatusBarContribution[] {
    const entries = [...this._statusBar.values()].filter((e) => align === undefined || e.item.align === align);
    return entries.sort(compareOrder).map((entry) => entry.item);
  }

  registerCommand(id: string, run: (...a: unknown[]) => unknown, meta?: CommandMeta): Disposable {
    const cmdSub = this._commands.register(id, run, meta);
    let keySub: Disposable | undefined;
    if (meta?.keybinding && this._keybindings) {
      try {
        keySub = this._keybindings.register({ keybinding: meta.keybinding, command: id });
      } catch (err) {
        cmdSub.dispose();
        throw err;
      }
    }
    this._onDidChangeCommands.fire();
    this._onDidChange.fire('commands');
    return toDisposable(() => {
      keySub?.dispose();
      cmdSub.dispose();
      this._onDidChangeCommands.fire();
      this._onDidChange.fire('commands');
    });
  }

  executeCommand(id: string, ...args: unknown[]): Promise<unknown> {
    return this._commands.execute(id, ...args);
  }

  registerMenu(where: MenuLocation, item: MenuItem): Disposable {
    if (!VALID_MENU_LOCATIONS.has(where)) {
      throw new Error(`Invalid menu location: ${String(where)}`);
    }
    assertNonEmpty(item.id, 'Menu item id');
    const bucket = this._menus.get(where)!;
    if (bucket.has(item.id)) {
      throw new Error(`Menu item already registered at ${where}: ${item.id}`);
    }
    const entry: Sequenced<MenuItem> = { item, seq: this._nextSeq++ };
    bucket.set(item.id, entry);
    this._onDidChangeMenus.fire(where);
    this._onDidChange.fire('menus');
    return toDisposable(() => {
      if (bucket.get(item.id) === entry) {
        bucket.delete(item.id);
        this._onDidChangeMenus.fire(where);
        this._onDidChange.fire('menus');
      }
    });
  }

  listMenuItems(
    where: MenuLocation,
    target?: unknown,
    options?: { readonly includeHidden?: boolean },
  ): readonly MenuItem[] {
    const bucket = this._menus.get(where);
    if (!bucket) return [];
    const includeHidden = options?.includeHidden === true;
    const entries: Sequenced<MenuItem>[] = [];
    for (const entry of bucket.values()) {
      if (!includeHidden && entry.item.when && !entry.item.when(target)) continue;
      entries.push(entry);
    }
    return entries.sort(compareMenuEntry).map((entry) => entry.item);
  }

  listMenuGroups(where: MenuLocation, target?: unknown): readonly (readonly ResolvedMenuItem[])[] {
    const items = this.listMenuItems(where, target);
    const groups: ResolvedMenuItem[][] = [];
    let currentKey: string | undefined;
    let currentGroup: ResolvedMenuItem[] | undefined;
    for (const item of items) {
      const key = item.group ?? '\uffff';
      if (!currentGroup || key !== currentKey) {
        currentKey = key;
        currentGroup = [];
        groups.push(currentGroup);
      }
      const rawDisabled = item.disabled ? item.disabled(target) : false;
      const resolved: ResolvedMenuItem =
        typeof rawDisabled === 'string'
          ? { item, disabled: true, disabledReason: rawDisabled }
          : { item, disabled: Boolean(rawDisabled) };
      currentGroup.push(resolved);
    }
    return groups;
  }

  registerSettingsSection(section: SettingsSectionContribution): Disposable {
    assertNonEmpty(section.id, 'Settings section id');
    // Enforce scope at runtime: external JS plugins are not checked by TypeScript.
    if ((section.scope as string) !== 'device') {
      throw new Error(`Settings section "${section.id}" only supports scope "device"`);
    }
    if (this._settings.has(section.id)) {
      throw new Error(`Settings section already registered: ${section.id}`);
    }
    const entry: Sequenced<SettingsSectionContribution> = { item: section, seq: this._nextSeq++ };
    this._settings.set(section.id, entry);
    this._onDidChangeSettings.fire();
    this._onDidChange.fire('settings');
    return toDisposable(() => {
      if (this._settings.get(section.id) === entry) {
        this._settings.delete(section.id);
        this._onDidChangeSettings.fire();
        this._onDidChange.fire('settings');
      }
    });
  }

  getSettingsSection(id: string): SettingsSectionContribution | undefined {
    return this._settings.get(id)?.item;
  }

  listSettingsSections(): readonly SettingsSectionContribution[] {
    return [...this._settings.values()].map((entry) => entry.item);
  }

  dispose(): void {
    this._views.clear();
    this._editors.clear();
    this._topicTools.clear();
    this._activities.clear();
    this._statusBar.clear();
    for (const bucket of this._menus.values()) bucket.clear();
    this._settings.clear();
    if (this._ownsCommands) this._commands.dispose();
    this._onDidChange.dispose();
    this._onDidChangeViews.dispose();
    this._onDidChangeEditors.dispose();
    this._onDidChangeTopicTools.dispose();
    this._onDidChangeActivity.dispose();
    this._onDidChangeActivityBadges.dispose();
    this._onDidChangeStatusBar.dispose();
    this._onDidChangeCommands.dispose();
    this._onDidChangeMenus.dispose();
    this._onDidChangeSettings.dispose();
  }
}

export class WebuiEventBus implements Disposable {
  private readonly _emitters = new Map<string, Emitter<unknown>>();
  private _disposed = false;

  on<K extends keyof WebuiEvents>(key: K, cb: (event: WebuiEvents[K]) => void): Disposable {
    if (this._disposed) return toDisposable(() => undefined);
    const name = String(key);
    let emitter = this._emitters.get(name);
    if (!emitter) {
      emitter = new Emitter<unknown>();
      this._emitters.set(name, emitter);
    }
    return emitter.event(cb as (event: unknown) => void);
  }

  emit<K extends keyof WebuiEvents>(key: K, event: WebuiEvents[K]): void {
    if (this._disposed) return;
    const emitter = this._emitters.get(String(key));
    emitter?.fire(event);
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    for (const emitter of this._emitters.values()) emitter.dispose();
    this._emitters.clear();
  }
}

function interpolate(template: string, vars?: Record<string, unknown>): string {
  if (!vars) return template;
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name: string) => {
    const val = vars[name];
    return val === undefined ? match : String(val);
  });
}

function normalizePluginLocale(locale: string): string {
  return matchLocale(locale) ?? locale.trim();
}

export class PluginI18nRegistry {
  private readonly _dicts = new Map<string, Map<string, string>>();
  private readonly _getLocale: () => string;

  constructor(getLocaleFn: () => string = getLocale) {
    this._getLocale = getLocaleFn;
  }

  add(locale: string, dict: Record<string, string>): void {
    const norm = normalizePluginLocale(locale);
    if (!norm) return;
    let map = this._dicts.get(norm);
    if (!map) {
      map = new Map<string, string>();
      this._dicts.set(norm, map);
    }
    for (const [k, v] of Object.entries(dict)) {
      map.set(k, v);
    }
  }

  t(key: string, vars?: Record<string, unknown>): string {
    const active = normalizePluginLocale(this._getLocale());
    const fromActive = this._dicts.get(active)?.get(key);
    if (fromActive !== undefined) return interpolate(fromActive, vars);
    const fromEn = this._dicts.get('en')?.get(key);
    if (fromEn !== undefined) return interpolate(fromEn, vars);
    const fromCore = coreT(key as MessageKey);
    return interpolate(fromCore, vars);
  }
}

function decodeSegmentStrict(segment: string): string {
  let prev = segment;
  for (let i = 0; i < 2; i++) {
    let next: string;
    try {
      next = decodeURIComponent(prev);
    } catch {
      throw new Error(`Malformed percent-encoding in plugin API path segment: ${segment}`);
    }
    if (next === prev) break;
    prev = next;
  }
  return prev;
}

function extractSafePathname(rawPath: string): string {
  // Trust boundary: fail closed on non-relative URLs, backslashes, control chars, or dot-segments.
  if (!rawPath || !rawPath.startsWith('/') || rawPath.startsWith('//')) {
    throw new Error(`Plugin API path must be a relative path starting with "/": ${rawPath}`);
  }
  if (/[\x00-\x1f\x7f\\]/.test(rawPath)) {
    throw new Error(`Plugin API path contains forbidden characters: ${rawPath}`);
  }
  const pathname = rawPath.split(/[?#]/, 1)[0] ?? '';
  const segments = pathname.split('/');
  for (const segment of segments) {
    if (!segment) continue;
    const decoded = decodeSegmentStrict(segment);
    if (
      segment === '.' ||
      segment === '..' ||
      decoded === '.' ||
      decoded === '..' ||
      decoded.includes('/') ||
      decoded.includes('\\') ||
      decoded.includes('\0')
    ) {
      throw new Error(`Path traversal is not allowed in plugin API path: ${rawPath}`);
    }
  }
  return pathname;
}

export interface PluginApiGuardOptions {
  readonly builtin: boolean;
  readonly publicReadonlyPaths?: ReadonlySet<string>;
}

export function assertPluginApiPath(
  pluginId: string,
  method: 'GET' | 'POST',
  rawPath: string,
  options: PluginApiGuardOptions,
): string {
  const pathname = extractSafePathname(rawPath);
  if (options.builtin) {
    if (!pathname.startsWith('/api/')) {
      throw new Error(`Built-in plugin "${pluginId}" API path must start with "/api/": ${rawPath}`);
    }
    return rawPath;
  }
  const ownPrefix = `/api/plugins/${pluginId}/`;
  if (pathname.startsWith(ownPrefix)) {
    return rawPath;
  }
  const allowlist = options.publicReadonlyPaths ?? DEFAULT_PUBLIC_READONLY_API_PATHS;
  if (method === 'GET' && allowlist.has(pathname)) {
    return rawPath;
  }
  throw new Error(`Plugin "${pluginId}" is not allowed to ${method} "${pathname}"`);
}

export interface PluginTopicsBridge {
  list(): readonly TopicInfo[];
  active(): TopicInfo | undefined;
  open(id: string): void;
  insertIntoComposer(id: string, text: string): void;
}

export interface CreatePluginContextOptions {
  readonly registry: ContributionRegistry;
  readonly events: WebuiEventBus;
  readonly topics: PluginTopicsBridge;
  readonly api: ApiClient;
  readonly storage: StorageService;
  readonly i18n?: PluginI18nRegistry;
  readonly builtin?: boolean;
  readonly publicReadonlyApiPaths?: ReadonlySet<string>;
}

function trackDisposable(store: DisposableStore, inner: Disposable): Disposable {
  let tracked = true;
  const wrapped = toDisposable(() => {
    tracked = false;
    inner.dispose();
    store.delete(wrapped);
  });
  store.add(wrapped);
  if (!tracked) store.delete(wrapped);
  return wrapped;
}

export function createPluginContext(pluginId: string, options: CreatePluginContextOptions): PluginContext {
  assertNonEmpty(pluginId, 'Plugin id');
  const subscriptions = new DisposableStore();
  const builtin = options.builtin === true;
  const apiGuard: PluginApiGuardOptions = {
    builtin,
    publicReadonlyPaths: options.publicReadonlyApiPaths,
  };
  const scopedStorage = options.storage.scope(`plugin:${pluginId}`);
  const i18n = options.i18n ?? new PluginI18nRegistry();
  const { registry, events, topics, api } = options;

  return {
    id: pluginId,
    subscriptions,
    views: {
      register: (v) => trackDisposable(subscriptions, registry.registerView(v)),
    },
    editors: {
      register: (e) => trackDisposable(subscriptions, registry.registerEditor(e)),
      open: (kind, input, opts) => registry.openEditor(kind, input, opts),
    },
    topicTools: {
      register: (t) => trackDisposable(subscriptions, registry.registerTopicTool(t)),
    },
    activity: {
      register: (a) => trackDisposable(subscriptions, registry.registerActivity(a)),
    },
    statusBar: {
      register: (s) => trackDisposable(subscriptions, registry.registerStatusBar(s)),
    },
    commands: {
      register: (id, run, meta) => trackDisposable(subscriptions, registry.registerCommand(id, run, meta)),
      execute: (id, ...a) => registry.executeCommand(id, ...a),
    },
    menus: {
      register: (where, item) => trackDisposable(subscriptions, registry.registerMenu(where, item)),
    },
    settings: {
      registerSection: (s) => trackDisposable(subscriptions, registry.registerSettingsSection(s)),
    },
    events: {
      on: (k, cb) => trackDisposable(subscriptions, events.on(k, cb)),
    },
    topics: {
      list: () => topics.list(),
      active: () => topics.active(),
      open: (id) => topics.open(id),
      insertIntoComposer: (id, text) => topics.insertIntoComposer(id, text),
    },
    api: {
      get: <T>(path: string) => api.getJson<T>(assertPluginApiPath(pluginId, 'GET', path, apiGuard)),
      post: <T>(path: string, body: unknown) =>
        api.postJson<T>(assertPluginApiPath(pluginId, 'POST', path, apiGuard), body),
    },
    storage: {
      get: <T>(k: string) => scopedStorage.getJson<T>(k),
      set: (k: string, v: unknown) => {
        if (v === undefined) {
          scopedStorage.remove(k);
        } else {
          scopedStorage.setJson(k, v);
        }
      },
    },
    i18n: {
      add: (locale, dict) => i18n.add(locale, dict),
      t: (key, vars) => i18n.t(key, vars),
    },
    html,
    render,
  };
}
