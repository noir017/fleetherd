import { addDisposableListener } from '../base/dom.js';
import { Emitter, type Event } from '../base/event.js';
import { html, nothing, render, type TemplateResult } from '../base/html.js';
import { type Disposable, DisposableStore, toDisposable } from '../base/lifecycle.js';
import { renderGroupedList, renderRadioGroup, renderSwitch } from '../components/form/index.js';
import { t as tr } from '../i18n/index.js';
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

export interface StackHeaderAction {
  readonly id: string;
  readonly label: string;
  readonly icon?: string;
  readonly primary?: boolean;
  readonly onClick: () => void;
}

export interface StackDetailOptions {
  readonly title: string;
  readonly subtitle?: string;
  readonly subtitleTone?: 'running' | 'asking' | 'live' | 'idle';
  readonly backBadge?: number | null;
  readonly actions?: readonly StackHeaderAction[];
  readonly tools: readonly StackToolItem[];
  readonly activeToolId?: string;
  readonly hideToolsBar?: boolean;
  readonly onDispose?: () => void;
}

export interface MobileMoreState {
  readonly reviewsBadge?: string;
  readonly prefsBadge?: string;
  readonly skillsCount?: number;
  readonly notificationsEnabled?: boolean;
  readonly lowAttention?: boolean;
  readonly theme?: 'system' | 'dark' | 'light';
  readonly locale?: 'en' | 'zh-CN';
  readonly connected?: boolean;
  readonly version?: string;
  readonly runningCount?: number;
  readonly idleCount?: number;
  readonly onOpenReviews?: () => void;
  readonly onOpenPrefs?: () => void;
  readonly onOpenSkills?: () => void;
  readonly onOpenSettings?: () => void;
  readonly onToggleNotifications?: (enabled: boolean) => void;
  readonly onToggleLowAttention?: (enabled: boolean) => void;
  readonly onChangeTheme?: (theme: 'system' | 'dark' | 'light') => void;
  readonly onChangeLocale?: (locale: 'en' | 'zh-CN') => void;
  readonly onCloseIdle?: () => void;
}

export interface StackShellOptions {
  readonly doc?: Document;
  readonly tabs?: readonly StackNavTab[];
  readonly resolveIcon?: (name: string) => string;
  readonly moreState?: MobileMoreState;
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

function renderInlineSvg(svgStr: string): TemplateResult | undefined {
  if (!svgStr) return undefined;
  const span = document.createElement('span');
  span.className = 'wb-stack-inline-icon';
  span.innerHTML = svgStr;
  return html`${span}`;
}

function createStackPanelRef(
  id: string,
  params: unknown,
  onClose: () => void,
  onSetTitle?: (title: string) => void,
): PanelRef {
  const vis = new Emitter<boolean>();
  const dim = new Emitter<{ readonly width: number; readonly height: number }>();
  return {
    id,
    group: 'stack',
    params,
    onDidVisibilityChange: vis.event,
    onDidDimensionsChange: dim.event,
    setTitle(nextTitle: string) {
      onSetTitle?.(nextTitle);
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
  private readonly _listHead: HTMLElement;
  private readonly _listTopbar: HTMLElement;
  private readonly _listBackBtn: HTMLButtonElement;
  private readonly _listActions: HTMLElement;
  private readonly _listLargeTitle: HTMLElement;
  private readonly _listBody: HTMLElement;
  private readonly _tabBar: HTMLElement;
  private readonly _detailPage: HTMLElement;
  private readonly _detailHead: HTMLElement;
  private readonly _backBtn: HTMLButtonElement;
  private readonly _backBadge: HTMLElement;
  private readonly _detailTitleWrap: HTMLElement;
  private readonly _detailTitle: HTMLElement;
  private readonly _detailSubtitle: HTMLElement;
  private readonly _detailActions: HTMLElement;
  private readonly _toolsBar: HTMLElement;
  private readonly _detailBody: HTMLElement;

  private _tabs: StackNavTab[];
  private _activeTabId: string;
  private _mode: StackMode = 'list';
  private _tools: StackToolItem[] = [];
  private _activeToolId: string | undefined;
  private _hideToolsBar = false;
  private _pageStack: StackDetailOptions[] = [];
  private _moreState: MobileMoreState;
  private _moreHost: HTMLElement | undefined;
  private readonly _mountedViews = new Map<string, PanelComponent>();
  private readonly _initialized = new WeakSet<PanelComponent>();
  private readonly _tabButtons = new Map<string, HTMLButtonElement>();

  private readonly _disposables = new DisposableStore();
  private readonly _tabDisposables = new DisposableStore();
  private readonly _toolDisposables = new DisposableStore();
  private readonly _headActionDisposables = new DisposableStore();
  private readonly _listActionDisposables = new DisposableStore();
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
    this._moreState = options.moreState ?? {};

    this.element = this._doc.createElement('div');
    this.element.className = 'wb-stack';
    this.element.dataset.stackMode = this._mode;

    this._listPage = this._doc.createElement('div');
    this._listPage.className = 'wb-stack-list-page';

    this._listHead = this._doc.createElement('header');
    this._listHead.className = 'wb-stack-list-head';

    this._listTopbar = this._doc.createElement('div');
    this._listTopbar.className = 'wb-stack-topbar';

    this._listBackBtn = this._doc.createElement('button');
    this._listBackBtn.type = 'button';
    this._listBackBtn.className = 'wb-stack-mib wb-stack-list-back';
    this._listBackBtn.hidden = true;

    const topSpacer = this._doc.createElement('span');
    topSpacer.className = 'wb-spacer';

    this._listActions = this._doc.createElement('div');
    this._listActions.className = 'wb-stack-list-actions';

    this._listTopbar.append(this._listBackBtn, topSpacer, this._listActions);

    this._listLargeTitle = this._doc.createElement('div');
    this._listLargeTitle.className = 'wb-stack-large-title';

    this._listHead.append(this._listTopbar, this._listLargeTitle);

    this._listBody = this._doc.createElement('div');
    this._listBody.className = 'wb-stack-body wb-stack-list-body';

    this._tabBar = this._doc.createElement('nav');
    this._tabBar.className = 'wb-stack-tabbar';
    this._tabBar.setAttribute('aria-label', 'Mobile navigation');

    this._listPage.append(this._listHead, this._listBody, this._tabBar);

    this._detailPage = this._doc.createElement('div');
    this._detailPage.className = 'wb-stack-detail-page';
    this._detailPage.hidden = true;

    this._detailHead = this._doc.createElement('header');
    this._detailHead.className = 'wb-stack-head';

    this._backBtn = this._doc.createElement('button');
    this._backBtn.type = 'button';
    this._backBtn.className = 'wb-icon-btn wb-stack-back';
    this._backBtn.setAttribute('aria-label', tr('mobile.back'));
    const backSvg = this._resolveIcon('chevronLeft');
    if (backSvg) this._backBtn.innerHTML = backSvg;
    else this._backBtn.textContent = '<';

    this._backBadge = this._doc.createElement('span');
    this._backBadge.className = 'wb-stack-back-badge';
    this._backBadge.hidden = true;
    this._backBtn.appendChild(this._backBadge);

    this._detailTitleWrap = this._doc.createElement('div');
    this._detailTitleWrap.className = 'wb-stack-title-wrap';

    this._detailTitle = this._doc.createElement('span');
    this._detailTitle.className = 'wb-stack-title';

    this._detailSubtitle = this._doc.createElement('small');
    this._detailSubtitle.className = 'wb-stack-subtitle';
    this._detailSubtitle.hidden = true;

    this._detailTitleWrap.append(this._detailTitle, this._detailSubtitle);

    this._detailActions = this._doc.createElement('div');
    this._detailActions.className = 'wb-stack-head-actions';

    this._detailHead.append(this._backBtn, this._detailTitleWrap, this._detailActions);

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
    this._disposables.add(this._headActionDisposables);
    this._disposables.add(this._listActionDisposables);
    this._disposables.add(
      addDisposableListener(this._backBtn, 'click', () => {
        this.popPage();
      }),
    );

    this._renderTabBar();
    this._syncListHeaderTitle();
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

  getStackDepth(): number {
    return this._pageStack.length;
  }

  setMoreState(next: MobileMoreState): void {
    this._moreState = { ...this._moreState, ...next };
    if (this._moreHost) {
      this._paintMoreHost(this._moreHost);
    }
  }

  setListHeader(opts: {
    readonly title?: string;
    readonly backLabel?: string;
    readonly onBack?: () => void;
    readonly actions?: readonly StackHeaderAction[];
  }): void {
    if (opts.title !== undefined) {
      this._listLargeTitle.textContent = opts.title;
    }
    this._listActionDisposables.clear();
    if (opts.backLabel) {
      const backSvg = this._resolveIcon('chevronLeft');
      this._listBackBtn.innerHTML = `${backSvg || '<'}<span>${opts.backLabel}</span>`;
      this._listBackBtn.hidden = false;
      if (opts.onBack) {
        this._listActionDisposables.add(addDisposableListener(this._listBackBtn, 'click', opts.onBack));
      }
    } else {
      this._listBackBtn.hidden = true;
    }
    this._renderHeaderActions(this._listActions, opts.actions ?? [], this._listActionDisposables);
  }

  setTabs(tabs: readonly StackNavTab[]): void {
    this._tabs = [...tabs];
    if (!this._tabs.some((t) => t.id === this._activeTabId)) {
      this._activeTabId = this._tabs[0]?.id ?? 'topics';
    }
    this._renderTabBar();
    this._syncListHeaderTitle();
  }

  selectTab(tabId: string): void {
    const tab = this._tabs.find((t) => t.id === tabId || t.view === tabId);
    if (!tab) return;
    this._activeTabId = tab.id;
    this._syncTabActive();
    this._syncListHeaderTitle();
    if (this._mode !== 'list') this.backToList();
    if (tab.view === 'more' && !this._mountedViews.has('more')) {
      this._mountBuiltinMoreView();
    }
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

  openDetail(options: StackDetailOptions): void {
    this._disposePageStack();
    this._pageStack = [options];
    this._applyDetailEntry(options);
    this._setMode('detail');
  }

  pushPage(options: StackDetailOptions): void {
    this._pageStack.push(options);
    this._applyDetailEntry(options);
    this._setMode('detail');
  }

  popPage(): void {
    if (this._pageStack.length > 1) {
      const popped = this._pageStack.pop();
      popped?.onDispose?.();
      const top = this._pageStack[this._pageStack.length - 1];
      if (top) {
        this._applyDetailEntry(top);
        return;
      }
    }
    this.backToList();
  }

  setDetailTitle(title: string): void {
    this._detailTitle.textContent = title;
  }

  updateDetailHeader(opts: {
    readonly title?: string;
    readonly subtitle?: string;
    readonly subtitleTone?: 'running' | 'asking' | 'live' | 'idle';
    readonly backBadge?: number | null;
  }): void {
    if (opts.title !== undefined) {
      this._detailTitle.textContent = opts.title;
    }
    if (opts.subtitle !== undefined || opts.subtitleTone !== undefined) {
      this._renderDetailSubtitle(opts.subtitle, opts.subtitleTone);
    }
    if (opts.backBadge !== undefined) {
      this._renderBackBadge(opts.backBadge);
    }
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
    this._disposePageStack();
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
    this._disposePageStack();
    if (this._moreHost) {
      render(nothing, this._moreHost);
      this._moreHost = undefined;
    }
    this._mountedViews.clear();
    this._tools = [];
    this._tabButtons.clear();
    this._disposables.dispose();
  }

  private _disposePageStack(): void {
    for (let i = this._pageStack.length - 1; i >= 0; i--) {
      this._pageStack[i]?.onDispose?.();
    }
    this._pageStack = [];
  }

  private _syncListHeaderTitle(): void {
    const activeTab = this._tabs.find((t) => t.id === this._activeTabId);
    this._listLargeTitle.textContent = activeTab?.title ?? '';
    this._listBackBtn.hidden = true;
  }

  private _applyDetailEntry(options: StackDetailOptions): void {
    this._detailTitle.textContent = options.title;
    this._renderDetailSubtitle(options.subtitle, options.subtitleTone);
    this._renderBackBadge(options.backBadge);
    this._renderHeaderActions(this._detailActions, options.actions ?? [], this._headActionDisposables);
    this._tools = [...options.tools];
    this._hideToolsBar = options.hideToolsBar === true || this._tools.length <= 1;
    this._activeToolId =
      options.activeToolId && this._tools.some((t) => t.id === options.activeToolId)
        ? options.activeToolId
        : this._tools[0]?.id;
    this._renderTools();
    this._mountActiveTool();
  }

  private _renderDetailSubtitle(
    subtitle: string | undefined,
    tone: 'running' | 'asking' | 'live' | 'idle' | undefined,
  ): void {
    this._detailSubtitle.replaceChildren();
    if (!subtitle && !tone) {
      this._detailSubtitle.hidden = true;
      return;
    }
    if (tone) {
      const dot = this._doc.createElement('span');
      dot.className = `wb-stack-status-dot is-${tone}`;
      dot.setAttribute('aria-hidden', 'true');
      this._detailSubtitle.appendChild(dot);
    }
    if (subtitle) {
      const txt = this._doc.createElement('span');
      txt.className = 'wb-stack-subtitle-text';
      txt.textContent = subtitle;
      this._detailSubtitle.appendChild(txt);
    }
    this._detailSubtitle.hidden = false;
  }

  private _renderBackBadge(badge: number | null | undefined): void {
    if (badge !== undefined && badge !== null && badge > 0) {
      this._backBadge.textContent = badge > 99 ? '99+' : String(badge);
      this._backBadge.hidden = false;
    } else {
      this._backBadge.textContent = '';
      this._backBadge.hidden = true;
    }
  }

  private _renderHeaderActions(
    container: HTMLElement,
    actions: readonly StackHeaderAction[],
    store: DisposableStore,
  ): void {
    store.clear();
    container.replaceChildren();
    for (const action of actions) {
      const btn = this._doc.createElement('button');
      btn.type = 'button';
      btn.dataset.stackAction = action.id;
      const svg = action.icon ? this._resolveIcon(action.icon) : '';
      if (svg) {
        btn.className = 'wb-stack-mib';
        btn.innerHTML = svg;
        btn.setAttribute('aria-label', action.label);
        btn.title = action.label;
      } else {
        btn.className = `wb-stack-mtx${action.primary ? ' is-primary' : ''}`;
        btn.textContent = action.label;
      }
      store.add(addDisposableListener(btn, 'click', action.onClick));
      container.appendChild(btn);
    }
  }

  private _mountBuiltinMoreView(): void {
    const host = this._doc.createElement('div');
    host.className = 'wb-stack-more';
    this._moreHost = host;
    const comp: PanelComponent = {
      element: host,
      init: () => {
        this._paintMoreHost(host);
      },
      dispose: () => {
        render(nothing, host);
      },
    };
    this.mountListView('more', comp);
  }

  private _openAppearanceSubpage(): void {
    const host = this._doc.createElement('div');
    host.className = 'wb-stack-appearance';
    const paintAppearance = (): void => {
      const theme = this._moreState.theme ?? 'system';
      const locale = this._moreState.locale ?? 'en';
      render(
        html`
          <div class="fh-mgroup-head">${tr('mobile.appearance')}</div>
          ${renderRadioGroup({
            ariaLabel: tr('mobile.appearance'),
            value: theme,
            options: [
              { value: 'system', label: tr('mobile.themeSystem') },
              { value: 'dark', label: tr('mobile.themeDark') },
              { value: 'light', label: tr('mobile.themeLight') },
            ],
            onChange: (val) => {
              const next = val as 'system' | 'dark' | 'light';
              this._moreState = { ...this._moreState, theme: next };
              this._moreState.onChangeTheme?.(next);
              paintAppearance();
              if (this._moreHost) this._paintMoreHost(this._moreHost);
            },
          })}
          <div class="fh-mgroup-head">${tr('mobile.language')}</div>
          ${renderRadioGroup({
            ariaLabel: tr('mobile.language'),
            value: locale,
            options: [
              { value: 'zh-CN', label: '简体中文' },
              { value: 'en', label: 'English' },
            ],
            onChange: (val) => {
              const next = val as 'en' | 'zh-CN';
              this._moreState = { ...this._moreState, locale: next };
              this._moreState.onChangeLocale?.(next);
              paintAppearance();
              if (this._moreHost) this._paintMoreHost(this._moreHost);
            },
          })}
          <div class="fh-mgroup-foot">${tr('mobile.langHint')}</div>
        `,
        host,
      );
    };
    const comp: PanelComponent = {
      element: host,
      init: paintAppearance,
      dispose: () => render(nothing, host),
    };
    this.pushPage({
      title: tr('mobile.appearanceLang'),
      subtitle: tr('mobile.deviceFooter'),
      hideToolsBar: true,
      tools: [{ id: 'appearance', title: tr('mobile.appearanceLang'), component: comp }],
      onDispose: () => comp.dispose(),
    });
  }

  private _paintMoreHost(host: HTMLElement): void {
    const s = this._moreState;
    const themeLabel =
      s.theme === 'dark'
        ? tr('mobile.themeDark')
        : s.theme === 'light'
          ? tr('mobile.themeLight')
          : tr('mobile.themeSystem');
    const langLabel = s.locale === 'zh-CN' ? '中文' : 'English';
    const running = s.runningCount ?? 0;
    const idle = s.idleCount ?? 0;
    const icon = (name: string): TemplateResult | undefined => {
      const raw = this._resolveIcon(name);
      return raw ? renderInlineSvg(raw) : undefined;
    };

    render(
      html`
        ${renderGroupedList({
          items: [
            {
              id: 'reviews',
              label: tr('mobile.reviews'),
              icon: icon('eye'),
              iconBox: true,
              value: s.reviewsBadge,
              chevron: true,
              onClick: () => s.onOpenReviews?.(),
            },
            {
              id: 'review-prefs',
              label: tr('mobile.prefs'),
              icon: icon('eye'),
              iconBox: true,
              value: s.prefsBadge,
              chevron: true,
              onClick: () => s.onOpenPrefs?.(),
            },
            {
              id: 'skills',
              label: tr('mobile.skills'),
              icon: icon('book'),
              iconBox: true,
              value: s.skillsCount !== undefined ? String(s.skillsCount) : undefined,
              chevron: true,
              onClick: () => s.onOpenSkills?.(),
            },
            {
              id: 'settings',
              label: tr('mobile.settings'),
              icon: icon('gear'),
              iconBox: true,
              chevron: true,
              onClick: () => s.onOpenSettings?.(),
            },
          ],
        })}
        ${renderGroupedList({
          header: tr('mobile.deviceSection'),
          footer: tr('mobile.deviceFooter'),
          items: [
            {
              id: 'notifications',
              label: tr('mobile.notifications'),
              subtitle: tr('mobile.notificationsDesc'),
              icon: icon('bell'),
              iconBox: true,
              trailing: renderSwitch({
                checked: Boolean(s.notificationsEnabled),
                ariaLabel: tr('mobile.notifications'),
                onChange: (checked) => {
                  this._moreState = { ...this._moreState, notificationsEnabled: checked };
                  s.onToggleNotifications?.(checked);
                  this._paintMoreHost(host);
                },
              }),
            },
            {
              id: 'low-attention',
              label: tr('mobile.lowAttention'),
              subtitle: tr('mobile.lowAttentionDesc'),
              icon: icon('moon'),
              iconBox: true,
              trailing: renderSwitch({
                checked: Boolean(s.lowAttention),
                ariaLabel: tr('mobile.lowAttention'),
                onChange: (checked) => {
                  this._moreState = { ...this._moreState, lowAttention: checked };
                  s.onToggleLowAttention?.(checked);
                  this._paintMoreHost(host);
                },
              }),
            },
            {
              id: 'appearance',
              label: tr('mobile.appearanceLang'),
              icon: icon('sun'),
              iconBox: true,
              value: `${themeLabel} · ${langLabel}`,
              chevron: true,
              onClick: () => this._openAppearanceSubpage(),
            },
          ],
        })}
        ${renderGroupedList({
          header: tr('mobile.gatewaySection'),
          items: [
            {
              id: 'gateway-status',
              label: 'fleetherd',
              subtitle: html`<span class="fh-dot ${s.connected !== false ? 'fh-dot--ok' : 'fh-dot--err'}"></span> ${s.connected !== false ? tr('mobile.connected') : tr('mobile.disconnected')}`,
              icon: icon('remote'),
              iconBox: true,
              value: s.version,
            },
            {
              id: 'gateway-idle',
              label: tr('mobile.runningIdle', { running, idle }),
              subtitle: tr('mobile.idleDesc'),
              icon: icon('play'),
              iconBox: true,
              trailing: html`<button type="button" class="fh-mgroup-textbtn" @click=${() => s.onCloseIdle?.()}>${tr('mobile.closeIdle')}</button>`,
            },
          ],
        })}
      `,
      host,
    );
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
    onSetTitle?: (title: string) => void,
  ): void {
    if (this._initialized.has(component)) {
      if (params !== undefined) component.update?.(params);
      return;
    }
    this._initialized.add(component);
    component.init(params, { id, api: createStackPanelRef(id, params, onClose, onSetTitle) });
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
    this._toolsBar.hidden = this._hideToolsBar || this._tools.length === 0;

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
    this._ensureInit(
      active.id,
      active.component,
      active.params,
      () => this.popPage(),
      (nextTitle) => {
        const top = this._pageStack[this._pageStack.length - 1];
        if (top && top.tools.some((t) => t.id === active.id)) {
          this.setDetailTitle(nextTitle);
        }
      },
    );
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
