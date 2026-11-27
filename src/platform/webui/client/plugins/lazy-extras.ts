import { icon } from '../../icons.js';
import { type Disposable, DisposableStore, toDisposable } from '../base/lifecycle.js';
import type { ChangesPluginDeps } from '../features/changes/types.js';
import type { FilesPluginDeps } from '../features/files/types.js';
import type { HistoryPluginDeps } from '../features/history/helpers.js';
import type { PalettePluginDeps } from '../features/palette/types.js';
import type { ReaderPluginDeps } from '../features/reader/plugin.js';
import type { ReviewsPluginDeps } from '../features/reviews/types.js';
import type { SchedulesPluginDeps } from '../features/schedules/types.js';
import type { SettingsPluginBridge, SettingsPluginDeps } from '../features/settings/workbench-types.js';
import type { SkillsPluginDeps } from '../features/skills/types.js';
import type { TerminalPluginDeps } from '../features/terminal/plugin.js';
import { getLocale, type Locale, onLocaleChange, t as tr } from '../i18n/index.js';
import type { PanelComponent, PanelInitContext, PartId } from '../workbench/contracts.js';
import {
  type ActivityContribution,
  definePlugin,
  type EditorContribution,
  type PluginContext,
  type TopicInfo,
  type TopicToolContribution,
  type ViewContribution,
  type WebuiPlugin,
} from './api.js';

// Replaced at build time by scripts/webui-client.mjs (`assets/workbench-extras-<hash>.js` or null).
declare const __WEBUI_EXTRAS_ASSET__: string | null | undefined;

export interface WorkbenchExtrasModule {
  readonly createChangesPlugin: (deps?: ChangesPluginDeps) => WebuiPlugin;
  readonly createFilesPlugin: (deps?: FilesPluginDeps) => WebuiPlugin;
  readonly createHistoryPlugin: (deps?: HistoryPluginDeps) => WebuiPlugin;
  readonly createPalettePlugin: (deps?: PalettePluginDeps) => WebuiPlugin;
  readonly createReaderPlugin: (deps?: ReaderPluginDeps) => WebuiPlugin;
  readonly createReviewsPlugin: (deps?: ReviewsPluginDeps) => WebuiPlugin;
  readonly createSchedulesPlugin: (deps?: SchedulesPluginDeps) => WebuiPlugin;
  readonly createSettingsPlugin: (deps: SettingsPluginDeps) => WebuiPlugin;
  readonly createSkillsPlugin: (deps?: SkillsPluginDeps) => WebuiPlugin;
  readonly createTerminalPlugin?: (deps?: TerminalPluginDeps) => WebuiPlugin;
  readonly initLocale?: () => void;
  readonly setLocale?: (locale: Locale) => void;
}

export interface ExtrasLoaderOptions {
  readonly bundleUrl?: string | null;
  readonly win?: Window;
  readonly doc?: Document;
  readonly importModule?: (url: string) => Promise<unknown>;
  readonly warn?: (message: string, err: unknown) => void;
}

export type ExtrasLoader = () => Promise<WorkbenchExtrasModule | null>;

type WindowWithExtras = Window & { __fhWorkbenchExtras?: WorkbenchExtrasModule };

export function resolveExtrasUrl(doc: Pick<Document, 'getElementById'> = document): string | null {
  try {
    const raw = doc.getElementById('boot-config')?.textContent;
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (typeof parsed.extras === 'string' && parsed.extras) return parsed.extras;
    }
  } catch {
    // Fall through to build-time asset constant.
  }
  return typeof __WEBUI_EXTRAS_ASSET__ === 'string' && __WEBUI_EXTRAS_ASSET__
    ? __WEBUI_EXTRAS_ASSET__
    : null;
}

function isExtrasModule(mod: unknown): mod is WorkbenchExtrasModule {
  if (!mod || typeof mod !== 'object') return false;
  return typeof (mod as Record<string, unknown>).createSchedulesPlugin === 'function';
}

export function createExtrasLoader(opts: ExtrasLoaderOptions = {}): ExtrasLoader {
  const win = opts.win ?? (typeof window !== 'undefined' ? window : undefined);
  const doc = opts.doc ?? (typeof document !== 'undefined' ? document : undefined);
  const warnFn = opts.warn ?? ((msg: string, err: unknown) => console.warn(msg, err));
  const bundleUrl = opts.bundleUrl !== undefined ? opts.bundleUrl : doc ? resolveExtrasUrl(doc) : null;

  let pending: Promise<WorkbenchExtrasModule | null> | null = null;
  let warned = false;
  let localeSynced = false;

  const syncLocale = (mod: WorkbenchExtrasModule): void => {
    mod.initLocale?.();
    mod.setLocale?.(getLocale());
    if (!localeSynced) {
      localeSynced = true;
      onLocaleChange((loc) => mod.setLocale?.(loc));
    }
  };

  return () => {
    const injected = (win as WindowWithExtras | undefined)?.__fhWorkbenchExtras;
    if (injected) return Promise.resolve(injected);
    if (!bundleUrl) return Promise.resolve(null);
    if (pending) return pending;
    const base = doc?.baseURI || (typeof location !== 'undefined' ? location.href : 'http://localhost/');
    const resolved = new URL(bundleUrl, base).href;
    const load = opts.importModule
      ? opts.importModule(resolved)
      : (import(resolved) as Promise<unknown>);
    pending = load
      .then((raw) => {
        const candidate =
          raw && typeof raw === 'object' && 'default' in raw && isExtrasModule((raw as { default?: unknown }).default)
            ? (raw as { default: WorkbenchExtrasModule }).default
            : raw;
        if (!isExtrasModule(candidate)) return null;
        syncLocale(candidate);
        return candidate;
      })
      .catch((err: unknown) => {
        pending = null;
        if (!warned) {
          warned = true;
          warnFn('workbench extras chunk unavailable:', err);
        }
        return null;
      });
    return pending;
  };
}

export function createLazyPanel(
  ensureFactory: () => Promise<(() => PanelComponent) | null>,
  getSyncFactory: () => (() => PanelComponent) | null,
  doc: Document = document,
): PanelComponent {
  const element = doc.createElement('div');
  element.className = 'wb-lazy-host';

  let real: PanelComponent | null = null;
  let disposed = false;
  let pendingFocus = false;
  let latestParams: unknown;
  let savedCtx: PanelInitContext | null = null;

  const mountReal = (factory: () => PanelComponent): void => {
    if (disposed || !savedCtx) return;
    const instance = factory();
    real = instance;
    element.replaceChildren(instance.element);
    instance.init(latestParams, savedCtx);
    if (pendingFocus) {
      pendingFocus = false;
      instance.focus?.();
    }
  };

  return {
    element,
    init(params: unknown, initCtx: PanelInitContext): void {
      latestParams = params;
      savedCtx = initCtx;
      const syncFactory = getSyncFactory();
      if (syncFactory) {
        mountReal(syncFactory);
        return;
      }
      void ensureFactory().then((factory) => {
        if (factory) mountReal(factory);
      });
    },
    update(params: unknown): void {
      latestParams = params;
      real?.update?.(params);
    },
    focus(): void {
      if (real) real.focus?.();
      else pendingFocus = true;
    },
    dispose(): void {
      disposed = true;
      real?.dispose();
      real = null;
      element.replaceChildren();
    },
  };
}

interface CapturedContributions {
  readonly views: Map<string, ViewContribution>;
  readonly editors: Map<string, EditorContribution>;
  readonly topicTools: Map<string, TopicToolContribution>;
  readonly activities: Map<string, ActivityContribution>;
  readonly commands: Map<string, (...args: unknown[]) => unknown>;
}

const NOOP_DISPOSABLE: Disposable = { dispose() {} };

function createCapturingContext(
  realCtx: PluginContext,
  captured: CapturedContributions,
  shellCommands: ReadonlySet<string>,
): PluginContext {
  return {
    id: realCtx.id,
    subscriptions: realCtx.subscriptions,
    views: {
      register(view) {
        captured.views.set(view.id, view);
        return NOOP_DISPOSABLE;
      },
    },
    editors: {
      register(editor) {
        captured.editors.set(editor.kind, editor);
        return NOOP_DISPOSABLE;
      },
      open: (kind, input, opts) => realCtx.editors.open(kind, input, opts),
    },
    topicTools: {
      register(tool) {
        captured.topicTools.set(tool.id, tool);
        return NOOP_DISPOSABLE;
      },
    },
    activity: {
      register(activity) {
        captured.activities.set(activity.id, activity);
        return NOOP_DISPOSABLE;
      },
    },
    statusBar: realCtx.statusBar,
    commands: {
      register(id, run, meta) {
        if (shellCommands.has(id)) {
          captured.commands.set(id, run);
          return toDisposable(() => captured.commands.delete(id));
        }
        return realCtx.commands.register(id, run, meta);
      },
      execute: (id, ...args) => realCtx.commands.execute(id, ...args),
    },
    menus: realCtx.menus,
    settings: realCtx.settings,
    events: realCtx.events,
    topics: realCtx.topics,
    api: realCtx.api,
    storage: realCtx.storage,
    i18n: realCtx.i18n,
    html: realCtx.html,
    render: realCtx.render,
  };
}

interface LazyViewSpec {
  readonly id: string;
  readonly title: string;
  readonly icon?: string;
  readonly part: PartId;
  readonly when?: () => boolean;
}

interface LazyEditorSpec {
  readonly kind: string;
  readonly title: (input: unknown) => string;
}

interface LazyToolSpec {
  readonly id: string;
  readonly title: string;
  readonly icon: string;
  readonly defaultPart: PartId;
  readonly available: (topic: TopicInfo) => boolean;
}

interface LazyActivitySpec {
  readonly id: string;
  readonly title: string;
  readonly icon: string;
  readonly view: string;
  readonly order?: number;
  readonly hasBadge?: boolean;
}

interface LazyCommandSpec {
  readonly id: string;
  readonly title?: string;
  readonly keybinding?: string;
}

interface LazyPluginSpec {
  readonly id: string;
  readonly loadPlugin: () => Promise<WebuiPlugin | null>;
  readonly views?: readonly LazyViewSpec[];
  readonly editors?: readonly LazyEditorSpec[];
  readonly topicTools?: readonly LazyToolSpec[];
  readonly activities?: readonly LazyActivitySpec[];
  readonly commands?: readonly LazyCommandSpec[];
  readonly onActivateShell?: (ctx: PluginContext, ensureActivated: () => Promise<boolean>) => void;
}

function createLazyPluginShell(spec: LazyPluginSpec): WebuiPlugin {
  let realPlugin: WebuiPlugin | null = null;
  let activatePromise: Promise<boolean> | null = null;
  const captured: CapturedContributions = {
    views: new Map(),
    editors: new Map(),
    topicTools: new Map(),
    activities: new Map(),
    commands: new Map(),
  };
  const shellCommands = new Set((spec.commands ?? []).map((c) => c.id));

  return definePlugin({
    id: spec.id,
    activate(ctx) {
      const ensureActivated = (): Promise<boolean> => {
        if (realPlugin) return Promise.resolve(true);
        if (activatePromise) return activatePromise;
        activatePromise = spec
          .loadPlugin()
          .then(async (plugin) => {
            if (!plugin) {
              activatePromise = null;
              return false;
            }
            const proxyCtx = createCapturingContext(ctx, captured, shellCommands);
            await plugin.activate(proxyCtx);
            realPlugin = plugin;
            return true;
          })
          .catch((err: unknown) => {
            activatePromise = null;
            console.warn(`[webui:lazy:${spec.id}] activation failed:`, err);
            return false;
          });
        return activatePromise;
      };

      for (const act of spec.activities ?? []) {
        ctx.activity.register({
          id: act.id,
          title: act.title,
          icon: act.icon,
          view: act.view,
          order: act.order,
          ...(act.hasBadge ? { badge: () => captured.activities.get(act.id)?.badge?.() ?? null } : {}),
        });
      }

      for (const view of spec.views ?? []) {
        ctx.views.register({
          id: view.id,
          title: view.title,
          icon: view.icon,
          part: view.part,
          when: view.when,
          component: () =>
            createLazyPanel(
              async () => ((await ensureActivated()) ? captured.views.get(view.id)?.component ?? null : null),
              () => captured.views.get(view.id)?.component ?? null,
            ),
        });
      }

      for (const editor of spec.editors ?? []) {
        ctx.editors.register({
          kind: editor.kind,
          title: (input) => captured.editors.get(editor.kind)?.title(input) ?? editor.title(input),
          component: () =>
            createLazyPanel(
              async () => ((await ensureActivated()) ? captured.editors.get(editor.kind)?.component ?? null : null),
              () => captured.editors.get(editor.kind)?.component ?? null,
            ),
        });
      }

      for (const tool of spec.topicTools ?? []) {
        ctx.topicTools.register({
          id: tool.id,
          title: tool.title,
          icon: tool.icon,
          defaultPart: tool.defaultPart,
          available: tool.available,
          component: () =>
            createLazyPanel(
              async () => ((await ensureActivated()) ? captured.topicTools.get(tool.id)?.component ?? null : null),
              () => captured.topicTools.get(tool.id)?.component ?? null,
            ),
        });
      }

      for (const cmd of spec.commands ?? []) {
        ctx.commands.register(
          cmd.id,
          async (...args: unknown[]) => {
            if (!(await ensureActivated())) return undefined;
            const fn = captured.commands.get(cmd.id);
            return fn ? fn(...args) : undefined;
          },
          cmd.title || cmd.keybinding ? { title: cmd.title, keybinding: cmd.keybinding } : undefined,
        );
      }

      spec.onActivateShell?.(ctx, ensureActivated);
    },
    deactivate() {
      realPlugin?.deactivate?.();
      realPlugin = null;
      activatePromise = null;
      captured.views.clear();
      captured.editors.clear();
      captured.topicTools.clear();
      captured.activities.clear();
      captured.commands.clear();
    },
  });
}

function stringField(input: unknown, key: string): string | null {
  if (!input || typeof input !== 'object') return null;
  const val = (input as Record<string, unknown>)[key];
  return typeof val === 'string' && val.trim() ? val.trim() : null;
}

export function createLazyHistoryPlugin(loader: ExtrasLoader, deps?: HistoryPluginDeps): WebuiPlugin {
  return createLazyPluginShell({
    id: 'history',
    loadPlugin: async () => (await loader())?.createHistoryPlugin(deps) ?? null,
    activities: [{ id: 'history', title: tr('sidebar.history'), icon: 'history', view: 'history', order: 50 }],
    views: [{ id: 'history', title: tr('sidebar.history'), icon: 'history', part: 'sidebar' }],
    editors: [
      {
        kind: 'history',
        title: (input) => stringField(input, 'title') ?? stringField(input, 'id') ?? tr('sidebar.history'),
      },
    ],
    commands: [
      { id: 'history.open', title: tr('sidebar.history') },
      { id: 'history.refresh', title: tr('common.refresh') },
    ],
  });
}

export function createLazySchedulesPlugin(loader: ExtrasLoader, deps?: SchedulesPluginDeps): WebuiPlugin {
  return createLazyPluginShell({
    id: 'schedules',
    loadPlugin: async () => (await loader())?.createSchedulesPlugin(deps) ?? null,
    activities: [
      { id: 'schedules', title: tr('sideTasks.tabScheduled'), icon: 'clock', view: 'schedules', order: 20, hasBadge: true },
    ],
    views: [{ id: 'schedules', title: tr('sideTasks.tabScheduled'), icon: 'clock', part: 'sidebar' }],
    editors: [
      {
        kind: 'schedule',
        title: (input) => {
          const rec = input && typeof input === 'object' ? (input as { mode?: unknown; id?: unknown; title?: unknown }) : undefined;
          if (rec?.mode === 'new' || (!rec?.id && rec?.mode !== 'edit')) return tr('taskPage.newTitle');
          if (typeof rec?.title === 'string' && rec.title) return rec.title;
          return tr('taskPage.title');
        },
      },
    ],
    commands: [
      { id: 'schedules.new', title: tr('sideTasks.newTask') },
      { id: 'schedules.refresh', title: tr('common.refresh') },
    ],
  });
}

export function createLazyReviewsPlugin(loader: ExtrasLoader, deps?: ReviewsPluginDeps): WebuiPlugin {
  return createLazyPluginShell({
    id: 'reviews',
    loadPlugin: async () => (await loader())?.createReviewsPlugin(deps) ?? null,
    activities: [
      { id: 'reviews', title: tr('sideTasks.tabReviews'), icon: 'eye', view: 'reviews', order: 30, hasBadge: true },
    ],
    views: [{ id: 'reviews', title: tr('sideTasks.tabReviews'), icon: 'eye', part: 'sidebar' }],
    editors: [
      {
        kind: 'review',
        title: (input) => {
          const title = stringField(input, 'title');
          return title ? `${tr('sideTasks.tabReviews')} · ${title}` : tr('sideTasks.tabReviews');
        },
      },
      {
        kind: 'review-prefs',
        title: () => (getLocale() === 'zh-CN' ? '偏好建议' : 'Preference suggestions'),
      },
    ],
    commands: [{ id: 'reviews.refresh', title: tr('common.refresh') }],
  });
}

export function createLazySettingsPlugin(loader: ExtrasLoader, deps: SettingsPluginDeps): WebuiPlugin {
  let realBridge: SettingsPluginBridge | null = null;
  const queuedMessages: Parameters<SettingsPluginBridge['handleMessage']>[0][] = [];

  const wrappedDeps: SettingsPluginDeps = {
    ...deps,
    onReady: (bridge) => {
      realBridge = bridge;
      for (const msg of queuedMessages.splice(0)) {
        bridge.handleMessage(msg);
      }
      deps.onReady?.(bridge);
    },
  };

  return createLazyPluginShell({
    id: 'settings',
    loadPlugin: async () => (await loader())?.createSettingsPlugin(wrappedDeps) ?? null,
    activities: [{ id: 'settings', title: tr('settings.title'), icon: 'gear', view: 'settings', order: 100 }],
    views: [{ id: 'settings', title: tr('settings.title'), icon: 'gear', part: 'sidebar' }],
    editors: [
      { kind: 'settings', title: (input) => stringField(input, 'title') ?? tr('settings.title') },
      { kind: 'instruction', title: (input) => stringField(input, 'title') ?? stringField(input, 'path') ?? tr('settings.title') },
    ],
    commands: [{ id: 'settings.open', title: tr('settings.title') }],
    onActivateShell(_ctx, ensureActivated) {
      deps.onReady?.({
        handleMessage(msg) {
          if (realBridge) return realBridge.handleMessage(msg);
          if (!msg || (!msg.settings && !msg.wasSettings)) return false;
          queuedMessages.push(msg);
          void ensureActivated();
          return true;
        },
        refresh() {
          realBridge?.refresh();
        },
        getMessage() {
          if (realBridge) return realBridge.getMessage();
          for (let i = queuedMessages.length - 1; i >= 0; i--) {
            const m = queuedMessages[i];
            if (m?.settings) return m;
          }
          return null;
        },
      });
    },
  });
}

export function createLazySkillsPlugin(loader: ExtrasLoader, deps?: SkillsPluginDeps): WebuiPlugin {
  return createLazyPluginShell({
    id: 'skills',
    loadPlugin: async () => (await loader())?.createSkillsPlugin(deps) ?? null,
    activities: [
      { id: 'skills', title: tr('skills.title'), icon: 'book', view: 'skills', order: deps?.activityOrder ?? 40 },
    ],
    views: [{ id: 'skills', title: tr('skills.title'), icon: 'book', part: 'sidebar', when: deps?.enabled }],
    editors: [{ kind: 'skill', title: (input) => stringField(input, 'name') ?? tr('skills.title') }],
    commands: [
      { id: 'skills.new', title: tr('skills.newTitle') },
      { id: 'skills.refresh', title: tr('skills.refreshTitle') },
    ],
  });
}

export function createLazyChangesPlugin(loader: ExtrasLoader, deps?: ChangesPluginDeps): WebuiPlugin {
  return createLazyPluginShell({
    id: 'changes',
    loadPlugin: async () => (await loader())?.createChangesPlugin(deps) ?? null,
    topicTools: [
      {
        id: 'changes',
        title: tr('git.title'),
        icon: icon('git'),
        defaultPart: 'secondary',
        available: (topic) => Boolean(topic.id && topic.dir?.path),
      },
    ],
    editors: [{ kind: 'diff', title: (input) => stringField(input, 'path') ?? tr('git.title') }],
    commands: [{ id: 'changes.openDiff' }],
  });
}

export function createLazyFilesPlugin(loader: ExtrasLoader, deps?: FilesPluginDeps): WebuiPlugin {
  const isEnabled = (): boolean =>
    typeof deps?.filesEnabled === 'function' ? Boolean(deps.filesEnabled()) : Boolean(deps?.filesEnabled);
  return createLazyPluginShell({
    id: 'files',
    loadPlugin: async () => (await loader())?.createFilesPlugin(deps) ?? null,
    topicTools: [
      {
        id: 'files',
        title: tr('files.title'),
        icon: icon('folder'),
        defaultPart: 'secondary',
        available: (topic) => isEnabled() && Boolean(topic.id && topic.dir?.path),
      },
    ],
    editors: [{ kind: 'file', title: (input) => stringField(input, 'path') ?? tr('files.title') }],
    commands: [
      { id: 'files.openFile' },
      { id: 'files.revealInTree', title: 'Reveal in file tree' },
      { id: 'files.closeFile', title: 'Close file' },
    ],
  });
}

export function createLazyTerminalPlugin(loader: ExtrasLoader, deps?: TerminalPluginDeps): WebuiPlugin {
  const enabled = Boolean(deps?.boot?.terminal);
  return createLazyPluginShell({
    id: 'terminal',
    loadPlugin: async () => (await loader())?.createTerminalPlugin?.(deps) ?? null,
    topicTools: [
      {
        id: 'terminal',
        title: tr('term.title'),
        icon: 'terminal',
        defaultPart: 'panel',
        available: (topic) => Boolean(enabled && topic.id && /^[0-9a-f]{8}$/.test(topic.id)),
      },
    ],
    editors: [{ kind: 'terminal', title: (input) => stringField(input, 'title') ?? tr('term.title') }],
    commands: [
      { id: 'terminal.toggle' },
      { id: 'terminal.endSession' },
      { id: 'terminal.newTab' },
      { id: 'terminal.closeTab' },
      { id: 'terminal.renameTab' },
      { id: 'terminal.moveToSecondary' },
      { id: 'terminal.moveToPanel' },
      { id: 'terminal.openInEditor' },
    ],
  });
}

export function createLazyReaderPlugin(loader: ExtrasLoader, deps?: ReaderPluginDeps): WebuiPlugin {
  return createLazyPluginShell({
    id: 'reader',
    loadPlugin: async () => (await loader())?.createReaderPlugin(deps) ?? null,
    editors: [{ kind: 'reader', title: (input) => stringField(input, 'title') ?? stringField(input, 'viewUrl') ?? (getLocale() === 'zh-CN' ? '阅读器' : 'Reader') }],
    commands: [{ id: 'reader.open' }, { id: 'reader.openImage' }],
  });
}

export function createLazyPalettePlugin(loader: ExtrasLoader, deps?: PalettePluginDeps): WebuiPlugin {
  // Strip keybindings when forwarding to the real plugin so allowInInput shortcuts are registered once.
  const realDeps: PalettePluginDeps | undefined = deps ? { ...deps, keybindings: undefined } : undefined;
  return createLazyPluginShell({
    id: 'palette',
    loadPlugin: async () => (await loader())?.createPalettePlugin(realDeps) ?? null,
    commands: [
      {
        id: 'palette.quickOpenTopic',
        title: getLocale() === 'zh-CN' ? '命令面板：跳转到话题…' : 'Palette: Go to Topic...',
        keybinding: 'Mod+K',
      },
      {
        id: 'palette.commands',
        title: getLocale() === 'zh-CN' ? '命令面板：显示所有命令' : 'Palette: Show All Commands',
        keybinding: 'Mod+Shift+P',
      },
      {
        id: 'palette.keybindings',
        title: getLocale() === 'zh-CN' ? '命令面板：快捷键一览' : 'Palette: Keyboard Shortcuts',
        keybinding: 'Mod+/',
      },
    ],
    onActivateShell(ctx) {
      if (!deps?.keybindings) return;
      const store = new DisposableStore();
      for (const spec of [
        { command: 'palette.quickOpenTopic', keybinding: 'Mod+K' },
        { command: 'palette.commands', keybinding: 'Mod+Shift+P' },
        { command: 'palette.keybindings', keybinding: 'Mod+/' },
      ]) {
        store.add(
          deps.keybindings.register({
            keybinding: spec.keybinding,
            command: spec.command,
            allowInInput: true,
          }),
        );
      }
      ctx.subscriptions.add(store);
    },
  });
}
