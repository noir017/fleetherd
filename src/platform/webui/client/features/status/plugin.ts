import { Emitter } from '../../base/event.js';
import { html, nothing, render } from '../../base/html.js';
import { toDisposable } from '../../base/lifecycle.js';
import { openDialog, renderStatusDot, type DialogController, type StatusTone } from '../../components/index.js';
import {
  getLocale,
  localeLabel,
  matchLocale,
  nextLocale,
  onLocaleChange,
  setLocale,
  type Locale,
} from '../../i18n/index.js';
import { definePlugin, type PluginContext, type TopicInfo, type WebuiEvents, type WebuiPlugin } from '../../plugins/api.js';
import { StorageService } from '../../services/storage.js';
import {
  getTheme,
  initTheme,
  isThemeId,
  nextTheme,
  setTheme,
  THEMES,
  type ThemeId,
} from '../../theme.js';
import { createDevicePreferencesPanel } from './device-settings.js';
import { STATUS_I18N_EN, STATUS_I18N_ZH_CN } from './i18n.js';
import { renderStatusIcon, type StatusIconName } from './icons.js';
import { openCloseIdleDialog } from './idle-dialog.js';
import { createStatusNotifyBridge } from './notify-bridge.js';
import { computeIdleTopics, computeRunningCount } from './topics-stats.js';
import type {
  CloseIdleResponse,
  ConnectionState,
  StatusNotifyBridge,
  StatusPluginDeps,
  StatusPluginError,
} from './types.js';

const CALM_STORAGE_KEY = 'aa_calm';
const LAYOUT_STORAGE_KEY = 'aa_layout';

interface ConnectionPresentation {
  readonly tone: StatusTone;
  readonly pulsing: boolean;
  readonly labelKey: string;
}

function mapStreamState(state: WebuiEvents['stream.state']['state']): ConnectionState {
  return state === 'open' ? 'connected' : state;
}

function connectionPresentation(state: ConnectionState): ConnectionPresentation {
  switch (state) {
    case 'connected':
      return { tone: 'ok', pulsing: false, labelKey: 'statusBar.connected' };
    case 'connecting':
      return { tone: 'warn', pulsing: true, labelKey: 'statusBar.connecting' };
    case 'reconnecting':
      return { tone: 'warn', pulsing: true, labelKey: 'statusBar.reconnecting' };
    case 'restarting':
      return { tone: 'warn', pulsing: true, labelKey: 'statusBar.restarting' };
    case 'parked':
      return { tone: 'idle', pulsing: false, labelKey: 'statusBar.parked' };
    case 'closed':
      return { tone: 'err', pulsing: false, labelKey: 'statusBar.disconnected' };
  }
}

function themeIcon(theme: ThemeId): StatusIconName {
  switch (theme) {
    case 'dark':
      return 'moon';
    case 'light':
      return 'sun';
    case 'system':
      return 'monitor';
  }
}

function themeI18nKey(theme: ThemeId): string {
  switch (theme) {
    case 'dark':
      return 'menu.themeDark';
    case 'light':
      return 'menu.themeLight';
    case 'system':
      return 'menu.themeSystem';
  }
}

function formatVersionLabel(version: string): string {
  if (!version) return '';
  return version.startsWith('v') ? version : `v${version}`;
}

interface StatusRuntime {
  readonly ctx: PluginContext;
  readonly deps: StatusPluginDeps;
  readonly doc: Document;
  readonly win: Window;
  readonly storage: StorageService;
  readonly notify: StatusNotifyBridge;
  readonly itemElements: Map<string, HTMLElement>;
  readonly stateChange: Emitter<void>;
  connectionState: ConnectionState;
  topics: readonly TopicInfo[];
  calm: boolean;
  theme: ThemeId;
  locale: Locale;
  version: string;
  updateAvailable: boolean;
  pluginErrors: StatusPluginError[];
  activeIdleDialog: DialogController | null;
  activeErrorDialog: DialogController | null;
}

function applyCalmClass(rt: StatusRuntime): void {
  const target = rt.deps.appElement ?? rt.doc.getElementById('app') ?? rt.doc.documentElement;
  target?.classList.toggle('calm', rt.calm);
}

function getAllPluginErrors(rt: StatusRuntime): readonly StatusPluginError[] {
  const fromDeps = rt.deps.getPluginErrors ? rt.deps.getPluginErrors() : [];
  if (fromDeps.length === 0) return rt.pluginErrors;
  if (rt.pluginErrors.length === 0) return fromDeps;
  const seen = new Set(fromDeps.map((e) => `${e.pluginId}:${e.phase ?? ''}:${e.message}`));
  const merged = [...fromDeps];
  for (const err of rt.pluginErrors) {
    const key = `${err.pluginId}:${err.phase ?? ''}:${err.message}`;
    if (!seen.has(key)) merged.push(err);
  }
  return merged;
}

function renderBrandItem(rt: StatusRuntime, el: HTMLElement): void {
  const label = rt.deps.brandLabel || 'fleetherd';
  el.classList.add('is-prominent');
  el.title = label;
  render(
    html`${renderStatusIcon('remote')}<span class="wb-status-label">${label}</span>`,
    el,
  );
}

function renderConnectionItem(rt: StatusRuntime, el: HTMLElement): void {
  const pres = connectionPresentation(rt.connectionState);
  const label = rt.ctx.i18n.t(pres.labelKey);
  el.title = rt.ctx.i18n.t('statusBar.connectionTitle', { state: label });
  el.dataset.state = rt.connectionState;
  render(
    html`${rt.connectionState === 'connected' ? renderStatusIcon('check') : renderStatusDot({ status: pres.tone, pulsing: pres.pulsing })}<span class="wb-status-label">${label}</span>`,
    el,
  );
}

function renderRunningItem(rt: StatusRuntime, el: HTMLElement): void {
  const count = computeRunningCount(rt.topics);
  el.title = rt.ctx.i18n.t('statusBar.runningTitle', { count });
  el.dataset.count = String(count);
  el.classList.toggle('is-active', count > 0);
  render(
    html`<span class=${count > 0 ? 'wb-status-ok-icon' : 'wb-status-icon'}>${renderStatusIcon('play')}</span><span class="wb-status-label">${rt.ctx.i18n.t('statusBar.running', { count })}</span>`,
    el,
  );
}

function renderIdleItem(rt: StatusRuntime, el: HTMLElement): void {
  const idleCount = computeIdleTopics(rt.topics).length;
  el.title = idleCount > 0
    ? rt.ctx.i18n.t('statusBar.idleTitle', { count: idleCount })
    : rt.ctx.i18n.t('statusBar.idleNoneTitle');
  el.dataset.count = String(idleCount);
  if (el instanceof HTMLButtonElement) {
    el.disabled = idleCount === 0;
  }
  render(
    html`${renderStatusIcon('pause')}<span class="wb-status-label">${rt.ctx.i18n.t('statusBar.idle', { count: idleCount })}</span>`,
    el,
  );
}

function renderPluginErrorsItem(rt: StatusRuntime, el: HTMLElement): void {
  const errors = getAllPluginErrors(rt);
  el.hidden = errors.length === 0;
  if (errors.length === 0) {
    render(nothing, el);
    return;
  }
  const label = errors.length === 1
    ? rt.ctx.i18n.t('statusBar.pluginErrorsOne')
    : rt.ctx.i18n.t('statusBar.pluginErrorsMany', { count: errors.length });
  el.title = rt.ctx.i18n.t('statusBar.pluginErrorsTitle');
  el.classList.add('is-warn');
  render(html`${renderStatusIcon('alert')}<span class="wb-status-label">${label}</span>`, el);
}

function renderNotifyItem(rt: StatusRuntime, el: HTMLElement): void {
  const st = rt.notify.getState();
  el.hidden = !st.supported || !st.available;
  if (el.hidden) {
    render(nothing, el);
    return;
  }
  const t = rt.ctx.i18n.t;
  const stateLabel = st.blocked
    ? t('menu.notificationsBlocked')
    : st.enabled
      ? t('common.on')
      : t('common.off');
  el.title = st.blocked
    ? t('menu.notificationsBlockedTitle')
    : st.enabled
      ? t('menu.notificationsOnTitle')
      : t('menu.notificationsOffTitle');
  el.setAttribute('aria-pressed', st.enabled ? 'true' : 'false');
  if (el instanceof HTMLButtonElement) {
    el.disabled = st.blocked || st.busy;
  }
  render(
    html`${renderStatusIcon('bell')}<span class="wb-status-label">${t('statusBar.notify')} ${stateLabel}</span>`,
    el,
  );
}

function renderCalmItem(rt: StatusRuntime, el: HTMLElement): void {
  const t = rt.ctx.i18n.t;
  const stateLabel = rt.calm ? t('common.on') : t('common.off');
  el.title = t('menu.lowAttentionTitle');
  el.setAttribute('aria-pressed', rt.calm ? 'true' : 'false');
  el.classList.toggle('is-active', rt.calm);
  render(
    html`${renderStatusIcon('moon')}<span class="wb-status-label">${t('statusBar.calm')} ${stateLabel}</span>`,
    el,
  );
}

function renderLocaleItem(rt: StatusRuntime, el: HTMLElement): void {
  const label = localeLabel(rt.locale);
  el.title = rt.ctx.i18n.t('statusBar.localeTitle', { label });
  render(html`${renderStatusIcon('globe')}<span class="wb-status-label">${label}</span>`, el);
}

function renderThemeItem(rt: StatusRuntime, el: HTMLElement): void {
  const t = rt.ctx.i18n.t;
  const label = t(themeI18nKey(rt.theme));
  const options = THEMES.map((entry) => t(themeI18nKey(entry.id))).join(' / ');
  el.setAttribute('aria-label', t('menu.themeAria', { label }));
  el.title = t('menu.themeTitle', { label, options });
  render(html`${renderStatusIcon(themeIcon(rt.theme))}<span class="wb-status-label">${label}</span>`, el);
}

function renderVersionItem(rt: StatusRuntime, el: HTMLElement): void {
  const t = rt.ctx.i18n.t;
  const ver = formatVersionLabel(rt.version);
  el.hidden = !ver && !rt.updateAvailable;
  if (el.hidden) {
    render(nothing, el);
    return;
  }
  el.classList.toggle('is-prominent', rt.updateAvailable);
  if (rt.updateAvailable) {
    const label = ver ? `${ver} · ${t('statusBar.updateAvailable')}` : t('statusBar.updateAvailable');
    el.title = t('statusBar.updateTitle');
    render(html`${renderStatusIcon('refresh')}<span class="wb-status-label">${label}</span>`, el);
    return;
  }
  el.title = t('statusBar.versionTitle', { version: ver });
  render(html`<span class="wb-status-label">${ver}</span>`, el);
}

const ITEM_RENDERERS: Readonly<Record<string, (rt: StatusRuntime, el: HTMLElement) => void>> = {
  'status.brand': renderBrandItem,
  'status.connection': renderConnectionItem,
  'status.running': renderRunningItem,
  'status.idle': renderIdleItem,
  'status.pluginErrors': renderPluginErrorsItem,
  'status.notify': renderNotifyItem,
  'status.calm': renderCalmItem,
  'status.locale': renderLocaleItem,
  'status.theme': renderThemeItem,
  'status.version': renderVersionItem,
};

function refreshItems(rt: StatusRuntime, ids?: readonly string[]): void {
  const targets = ids ?? Object.keys(ITEM_RENDERERS);
  for (const id of targets) {
    const el = rt.itemElements.get(id);
    const fn = ITEM_RENDERERS[id];
    if (el && fn) fn(rt, el);
    rt.deps.onRefreshStatusBar?.(id);
  }
}

function openPluginErrorsDialog(rt: StatusRuntime): void {
  const errors = getAllPluginErrors(rt);
  if (errors.length === 0) return;
  rt.activeErrorDialog?.close(false);
  const t = rt.ctx.i18n.t;
  rt.activeErrorDialog = openDialog({
    title: t('statusBar.pluginErrorsDialogTitle', { count: errors.length }),
    body: html`<ul class="fh-plugin-error-list">
      ${errors.map(
        (err) => html`<li class="fh-plugin-error-row">
          <strong>${err.pluginId}</strong>${err.phase ? html` <span>(${err.phase})</span>` : nothing}: ${err.message}
        </li>`,
      )}
    </ul>`,
    confirmLabel: t('common.close'),
    showCancel: false,
    closeIcon: renderStatusIcon('cross'),
    overlays: rt.deps.overlays,
    doc: rt.doc,
    onClose: () => {
      rt.activeErrorDialog = null;
    },
  });
}

function openIdleDialog(rt: StatusRuntime): void {
  const idle = computeIdleTopics(rt.topics);
  if (idle.length === 0) return;
  rt.activeIdleDialog?.close(false);
  const postCloseIdle =
    rt.deps.postCloseIdle ??
    ((topicIds: readonly string[]) =>
      rt.ctx.api.post<CloseIdleResponse>('/api/topics/close-idle', { topics: topicIds }));
  rt.activeIdleDialog = openCloseIdleDialog({
    topics: idle,
    t: rt.ctx.i18n.t,
    postCloseIdle,
    overlays: rt.deps.overlays,
    doc: rt.doc,
    onClose: () => {
      rt.activeIdleDialog = null;
    },
  });
}

function registerStatusBarItems(
  rt: StatusRuntime,
  actions: {
    readonly openIdle: () => void;
    readonly toggleCalm: () => boolean;
    readonly cycleTheme: () => ThemeId;
    readonly cycleLocale: () => Locale;
    readonly toggleNotify: () => Promise<void>;
    readonly handleVersionClick: () => void;
  },
): void {
  const register = (
    id: string,
    align: 'left' | 'right',
    order: number,
    onClick?: () => void,
  ): void => {
    const renderer = ITEM_RENDERERS[id];
    if (!renderer) return;
    rt.ctx.statusBar.register({
      id,
      align,
      order,
      render(el: HTMLElement): void {
        rt.itemElements.set(id, el);
        renderer(rt, el);
      },
      ...(onClick ? { onClick } : {}),
    });
  };

  register('status.brand', 'left', 0);
  register('status.connection', 'left', 10);
  register('status.running', 'left', 20);
  register('status.idle', 'left', 30, actions.openIdle);

  register('status.pluginErrors', 'right', 10, () => openPluginErrorsDialog(rt));
  register('status.notify', 'right', 20, () => {
    void actions.toggleNotify();
  });
  register('status.calm', 'right', 30, () => {
    actions.toggleCalm();
  });
  register('status.locale', 'right', 40, () => {
    actions.cycleLocale();
  });
  register('status.theme', 'right', 50, () => {
    actions.cycleTheme();
  });
  register('status.version', 'right', 60, actions.handleVersionClick);
}

function wireEvents(rt: StatusRuntime): void {
  const { ctx, deps } = rt;

  ctx.events.on('topic.list', (ev) => {
    rt.topics = ev.topics;
    refreshItems(rt, ['status.running', 'status.idle']);
  });

  ctx.events.on('stream.state', (ev) => {
    rt.connectionState = mapStreamState(ev.state);
    refreshItems(rt, ['status.connection']);
  });

  ctx.events.on('locale.change', (ev) => {
    const matched = matchLocale(ev.locale);
    if (matched) rt.locale = matched;
    refreshItems(rt);
    rt.stateChange.fire();
  });

  ctx.events.on('theme.change', (ev) => {
    if (isThemeId(ev.theme)) rt.theme = ev.theme;
    refreshItems(rt, ['status.theme']);
    rt.stateChange.fire();
  });

  ctx.subscriptions.add(
    toDisposable(
      onLocaleChange((next) => {
        rt.locale = next;
        refreshItems(rt);
        rt.stateChange.fire();
      }),
    ),
  );

  ctx.subscriptions.add(
    toDisposable(
      initTheme((next) => {
        rt.theme = next;
        refreshItems(rt, ['status.theme']);
        rt.stateChange.fire();
      }),
    ),
  );

  ctx.subscriptions.add(
    rt.notify.onDidChange(() => {
      refreshItems(rt, ['status.notify']);
      rt.stateChange.fire();
    }),
  );

  if (deps.onPluginError) {
    ctx.subscriptions.add(
      deps.onPluginError((record) => {
        rt.pluginErrors.push(record);
        refreshItems(rt, ['status.pluginErrors']);
      }),
    );
  }

  if (deps.onConnectionStateChange) {
    ctx.subscriptions.add(
      deps.onConnectionStateChange((next) => {
        rt.connectionState = next;
        refreshItems(rt, ['status.connection']);
      }),
    );
  }

  if (deps.onUpdateAvailable) {
    ctx.subscriptions.add(
      deps.onUpdateAvailable((available) => {
        rt.updateAvailable = available;
        refreshItems(rt, ['status.version']);
      }),
    );
  }
}

interface StatusActions {
  readonly openIdle: () => void;
  readonly toggleCalm: () => boolean;
  readonly setCalm: (next: boolean) => boolean;
  readonly setThemeChoice: (next: ThemeId) => ThemeId;
  readonly setLocaleChoice: (next: Locale) => Locale;
  readonly cycleTheme: () => ThemeId;
  readonly cycleLocale: () => Locale;
  readonly toggleNotify: () => Promise<void>;
  readonly handleVersionClick: () => void;
  readonly resetLayout: () => void;
}

function createStatusActions(rt: StatusRuntime): StatusActions {
  const setCalm = (next: boolean): boolean => {
    rt.calm = next;
    if (next) rt.storage.setRaw(CALM_STORAGE_KEY, '1');
    else rt.storage.remove(CALM_STORAGE_KEY);
    applyCalmClass(rt);
    refreshItems(rt, ['status.calm']);
    rt.stateChange.fire();
    return rt.calm;
  };

  const setThemeChoice = (next: ThemeId): ThemeId => {
    setTheme(next);
    rt.theme = next;
    rt.deps.emitEvent?.('theme.change', { theme: next });
    refreshItems(rt, ['status.theme']);
    rt.stateChange.fire();
    return next;
  };

  const setLocaleChoice = (next: Locale): Locale => {
    setLocale(next);
    rt.locale = getLocale();
    rt.deps.emitEvent?.('locale.change', { locale: rt.locale });
    refreshItems(rt);
    rt.stateChange.fire();
    return rt.locale;
  };

  return {
    openIdle: () => openIdleDialog(rt),
    setCalm,
    toggleCalm: () => setCalm(!rt.calm),
    setThemeChoice,
    setLocaleChoice,
    cycleTheme: () => setThemeChoice(nextTheme(rt.theme)),
    cycleLocale: () => setLocaleChoice(nextLocale(rt.locale)),
    toggleNotify: async () => {
      await rt.notify.toggle();
    },
    handleVersionClick: () => {
      if (!rt.updateAvailable) return;
      rt.deps.onBeforeReload?.();
      if (rt.deps.onReload) rt.deps.onReload();
      else rt.win.location.reload();
    },
    resetLayout: () => {
      rt.storage.remove(LAYOUT_STORAGE_KEY);
      rt.deps.onResetLayout?.();
    },
  };
}

function registerSettingsAndCommands(rt: StatusRuntime, actions: StatusActions): void {
  const { ctx } = rt;
  ctx.settings.registerSection({
    id: 'device-preferences',
    title: ctx.i18n.t('devicePrefs.title'),
    scope: 'device',
    component: () =>
      createDevicePreferencesPanel({
        doc: rt.doc,
        t: ctx.i18n.t,
        getSnapshot: () => ({
          theme: rt.theme,
          locale: rt.locale,
          calm: rt.calm,
          notify: rt.notify.getState(),
        }),
        onDidChange: (cb) => rt.stateChange.event(cb),
        setTheme: actions.setThemeChoice,
        setLocale: actions.setLocaleChoice,
        setCalm: actions.setCalm,
        toggleNotify: actions.toggleNotify,
        resetLayout: actions.resetLayout,
      }),
  });

  ctx.commands.register('status.closeIdle', actions.openIdle, {
    title: ctx.i18n.t('statusBar.cmdCloseIdle'),
  });
  ctx.commands.register('status.toggleCalm', actions.toggleCalm, {
    title: ctx.i18n.t('statusBar.cmdToggleCalm'),
  });
  ctx.commands.register('status.cycleTheme', actions.cycleTheme, {
    title: ctx.i18n.t('statusBar.cmdCycleTheme'),
  });
  ctx.commands.register('status.cycleLocale', actions.cycleLocale, {
    title: ctx.i18n.t('statusBar.cmdCycleLocale'),
  });
  ctx.commands.register('status.toggleNotify', actions.toggleNotify, {
    title: ctx.i18n.t('statusBar.cmdToggleNotify'),
  });
}

export function createStatusPlugin(deps: StatusPluginDeps = {}): WebuiPlugin {
  return definePlugin({
    id: 'status',
    activate(ctx: PluginContext): void {
      ctx.i18n.add('en', STATUS_I18N_EN);
      ctx.i18n.add('zh-CN', STATUS_I18N_ZH_CN);

      const doc = deps.doc ?? document;
      const win = deps.win ?? window;
      const storage = deps.storage ?? new StorageService();
      const ownsNotify = !deps.notify;
      const notify =
        deps.notify ??
        createStatusNotifyBridge({
          doc,
          win,
          fetchFn: deps.fetchFn,
          postFn: deps.postFn,
          alertFn: deps.alertFn,
        });
      if (ownsNotify) ctx.subscriptions.add(notify);

      const stateChange = ctx.subscriptions.add(new Emitter<void>());
      const rt: StatusRuntime = {
        ctx,
        deps,
        doc,
        win,
        storage,
        notify,
        itemElements: new Map(),
        stateChange,
        connectionState: deps.initialConnectionState ?? 'connecting',
        topics: ctx.topics.list(),
        calm: storage.getRaw(CALM_STORAGE_KEY) === '1',
        theme: getTheme(),
        locale: getLocale(),
        version: deps.version ?? '',
        updateAvailable: Boolean(deps.updateAvailable),
        pluginErrors: [],
        activeIdleDialog: null,
        activeErrorDialog: null,
      };

      applyCalmClass(rt);
      const actions = createStatusActions(rt);
      registerStatusBarItems(rt, actions);
      registerSettingsAndCommands(rt, actions);
      wireEvents(rt);

      ctx.subscriptions.add(
        toDisposable(() => {
          rt.activeIdleDialog?.close(false);
          rt.activeIdleDialog = null;
          rt.activeErrorDialog?.close(false);
          rt.activeErrorDialog = null;
          rt.itemElements.clear();
        }),
      );

      void rt.notify.init();
    },
  });
}
