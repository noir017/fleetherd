import { addDisposableListener } from '../base/dom.js';
import { Emitter, type Event } from '../base/event.js';
import { html, nothing, render, type TemplateResult } from '../base/html.js';
import { type Disposable, DisposableStore } from '../base/lifecycle.js';
import {
  renderGroupedList,
  renderRadioGroup,
  renderSwitch,
  type GroupedListItem,
} from '../components/form/index.js';
import { t as tr } from '../i18n/index.js';
import type { PanelComponent } from './contracts.js';

export interface MobileNavTab {
  readonly id: string;
  readonly title: string;
  readonly icon: string;
  readonly view: string;
  readonly badge?: () => number | 'dot' | null;
}

export interface MobileMoreExtraItem {
  readonly id: string;
  readonly title: string;
  readonly icon: string;
  readonly view: string;
  readonly badge?: string;
}

export interface MobileMoreState {
  readonly prefsBadge?: string;
  readonly skillsCount?: number;
  readonly schedulesBadge?: string;
  readonly extraItems?: readonly MobileMoreExtraItem[];
  readonly notificationsEnabled?: boolean;
  readonly lowAttention?: boolean;
  readonly theme?: 'system' | 'dark' | 'light';
  readonly locale?: 'en' | 'zh-CN';
  readonly connected?: boolean;
  readonly version?: string;
  readonly runningCount?: number;
  readonly idleCount?: number;
  readonly onOpenPrefs?: () => void;
  readonly onOpenSkills?: () => void;
  readonly onOpenSchedules?: () => void;
  readonly onOpenSettings?: () => void;
  readonly onOpenExtra?: (viewId: string) => void;
  readonly onToggleNotifications?: (enabled: boolean) => void;
  readonly onToggleLowAttention?: (enabled: boolean) => void;
  readonly onChangeTheme?: (theme: 'system' | 'dark' | 'light') => void;
  readonly onChangeLocale?: (locale: 'en' | 'zh-CN') => void;
  readonly onCloseIdle?: () => void;
}

export interface MobileTabBarOptions {
  readonly doc?: Document;
  readonly resolveIcon?: (name: string) => string;
}

export interface MobileMorePanelController {
  readonly component: PanelComponent;
  setState(next: MobileMoreState): void;
  resetSubview(): void;
  paint(): void;
}

function defaultResolveIcon(_name: string): string {
  return '';
}

function renderInlineSvg(svgStr: string, doc: Document): TemplateResult | undefined {
  if (!svgStr) return undefined;
  const span = doc.createElement('span');
  span.className = 'wb-stack-inline-icon';
  span.innerHTML = svgStr;
  return html`${span}`;
}

export class MobileTabBar implements Disposable {
  readonly element: HTMLElement;
  private readonly _doc: Document;
  private readonly _resolveIcon: (name: string) => string;
  private readonly _tabButtons = new Map<string, HTMLButtonElement>();
  private readonly _disposables = new DisposableStore();
  private readonly _tabDisposables = new DisposableStore();
  private readonly _onDidSelectTab = new Emitter<MobileNavTab>();
  private _tabs: MobileNavTab[] = [];
  private _activeTabId = 'topics';

  readonly onDidSelectTab: Event<MobileNavTab> = this._onDidSelectTab.event;

  constructor(options: MobileTabBarOptions = {}) {
    this._doc = options.doc ?? document;
    this._resolveIcon = options.resolveIcon ?? defaultResolveIcon;
    this.element = this._doc.createElement('nav');
    this.element.className = 'wb-stack-tabbar';
    this.element.setAttribute('aria-label', 'Mobile navigation');
    this.element.hidden = true;
    this._disposables.add(this._onDidSelectTab);
    this._disposables.add(this._tabDisposables);
  }

  getTabs(): readonly MobileNavTab[] {
    return this._tabs;
  }

  getActiveTab(): string {
    return this._activeTabId;
  }

  setTabs(tabs: readonly MobileNavTab[]): void {
    this._tabs = [...tabs];
    if (!this._tabs.some((t) => t.id === this._activeTabId)) {
      this._activeTabId = this._tabs[0]?.id ?? 'topics';
    }
    this._render();
  }

  setActive(idOrView: string | undefined): void {
    if (!idOrView) return;
    const direct = this._tabs.find((t) => t.id === idOrView || t.view === idOrView);
    const next = direct ? direct.id : this._tabs.some((t) => t.id === 'more') ? 'more' : this._activeTabId;
    this._activeTabId = next;
    for (const [id, btn] of this._tabButtons) {
      const on = id === this._activeTabId;
      btn.classList.toggle('is-active', on);
      if (on) btn.setAttribute('aria-current', 'page');
      else btn.removeAttribute('aria-current');
    }
  }

  refreshBadges(): void {
    for (const tab of this._tabs) {
      const btn = this._tabButtons.get(tab.id);
      if (!btn) continue;
      this._paintBadge(btn, tab.badge?.() ?? null);
    }
  }

  dispose(): void {
    this._tabButtons.clear();
    this._disposables.dispose();
  }

  private _render(): void {
    this._tabDisposables.clear();
    this._tabButtons.clear();
    this.element.replaceChildren();

    for (const tab of this._tabs) {
      const btn = this._doc.createElement('button');
      btn.type = 'button';
      const active = tab.id === this._activeTabId;
      btn.className = `wb-stack-tab${active ? ' is-active' : ''}`;
      btn.dataset.tabId = tab.id;
      btn.dataset.viewId = tab.view;
      btn.setAttribute('aria-label', tab.title);
      if (active) btn.setAttribute('aria-current', 'page');

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
          this.setActive(tab.id);
          this._onDidSelectTab.fire(tab);
        }),
      );
      this._tabButtons.set(tab.id, btn);
      this.element.appendChild(btn);
    }
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

function buildMoreNavItems(
  state: MobileMoreState,
  iconTpl: (name: string) => TemplateResult | undefined,
): GroupedListItem[] {
  const schedulesValue =
    state.schedulesBadge === 'dot'
      ? html`<span class="fh-dot fh-dot--live" aria-hidden="true"></span>`
      : state.schedulesBadge;
  const items: GroupedListItem[] = [
    {
      id: 'review-prefs',
      label: tr('mobile.prefs'),
      icon: iconTpl('bulb'),
      iconBox: true,
      value: state.prefsBadge,
      chevron: true,
      onClick: () => state.onOpenPrefs?.(),
    },
    {
      id: 'skills',
      label: tr('mobile.skills'),
      icon: iconTpl('book'),
      iconBox: true,
      value: state.skillsCount !== undefined ? String(state.skillsCount) : undefined,
      chevron: true,
      onClick: () => state.onOpenSkills?.(),
    },
    {
      id: 'schedules',
      label: tr('mobile.schedules'),
      icon: iconTpl('clock'),
      iconBox: true,
      value: schedulesValue,
      chevron: true,
      onClick: () => state.onOpenSchedules?.(),
    },
    {
      id: 'settings',
      label: tr('mobile.settings'),
      icon: iconTpl('gear'),
      iconBox: true,
      chevron: true,
      onClick: () => state.onOpenSettings?.(),
    },
  ];
  for (const extra of state.extraItems ?? []) {
    items.push({
      id: extra.id,
      label: extra.title,
      icon: iconTpl(extra.icon),
      iconBox: true,
      value: extra.badge,
      chevron: true,
      onClick: () => state.onOpenExtra?.(extra.view),
    });
  }
  return items;
}

function renderMoreAppearanceTemplate(
  state: MobileMoreState,
  iconTpl: (name: string) => TemplateResult | undefined,
  onBack: () => void,
  onUpdate: (patch: Partial<MobileMoreState>) => void,
): TemplateResult {
  const theme = state.theme ?? 'system';
  const locale = state.locale ?? 'en';
  const backIcon = iconTpl('chevronLeft');
  return html`
    <div class="wb-stack-appearance">
      <div class="wb-stack-subhead">
        <button type="button" class="wb-stack-mib wb-stack-subback" @click=${onBack}>
          ${backIcon ?? html`<span aria-hidden="true">&lsaquo;</span>`}
          <span>${tr('mobile.back')}</span>
        </button>
        <span class="wb-stack-subtitle-head">${tr('mobile.appearanceLang')}</span>
      </div>
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
          onUpdate({ theme: next });
          state.onChangeTheme?.(next);
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
          onUpdate({ locale: next });
          state.onChangeLocale?.(next);
        },
      })}
      <div class="fh-mgroup-foot">${tr('mobile.langHint')}</div>
    </div>
  `;
}

function renderMoreMainTemplate(
  state: MobileMoreState,
  iconTpl: (name: string) => TemplateResult | undefined,
  onOpenAppearance: () => void,
  onUpdate: (patch: Partial<MobileMoreState>) => void,
): TemplateResult {
  const themeLabel =
    state.theme === 'dark'
      ? tr('mobile.themeDark')
      : state.theme === 'light'
        ? tr('mobile.themeLight')
        : tr('mobile.themeSystem');
  const langLabel = state.locale === 'zh-CN' ? '中文' : 'English';
  const running = state.runningCount ?? 0;
  const idle = state.idleCount ?? 0;

  return html`
    ${renderGroupedList({ items: buildMoreNavItems(state, iconTpl) })}
        ${renderGroupedList({
          header: tr('mobile.deviceSection'),
          footer: tr('mobile.deviceFooter'),
          items: [
            {
              id: 'notifications',
              label: tr('mobile.notifications'),
              subtitle: tr('mobile.notificationsDesc'),
              icon: iconTpl('bell'),
              iconBox: true,
              trailing: renderSwitch({
                checked: Boolean(state.notificationsEnabled),
                ariaLabel: tr('mobile.notifications'),
                onChange: (checked) => {
                  onUpdate({ notificationsEnabled: checked });
                  state.onToggleNotifications?.(checked);
                },
              }),
            },
            {
              id: 'low-attention',
              label: tr('mobile.lowAttention'),
              subtitle: tr('mobile.lowAttentionDesc'),
              icon: iconTpl('moon'),
              iconBox: true,
              trailing: renderSwitch({
                checked: Boolean(state.lowAttention),
                ariaLabel: tr('mobile.lowAttention'),
                onChange: (checked) => {
                  onUpdate({ lowAttention: checked });
                  state.onToggleLowAttention?.(checked);
                },
              }),
            },
            {
              id: 'appearance',
              label: tr('mobile.appearanceLang'),
              icon: iconTpl('sun'),
              iconBox: true,
              value: `${themeLabel} · ${langLabel}`,
              chevron: true,
              onClick: onOpenAppearance,
            },
          ],
        })}
        ${renderGroupedList({
          header: tr('mobile.gatewaySection'),
          items: [
            {
              id: 'gateway-status',
              label: 'fleetherd',
              subtitle: html`<span class="fh-dot ${state.connected !== false ? 'fh-dot--ok' : 'fh-dot--err'}"></span> ${state.connected !== false ? tr('mobile.connected') : tr('mobile.disconnected')}`,
              icon: iconTpl('remote'),
              iconBox: true,
              value: state.version,
            },
            {
              id: 'gateway-idle',
              label: tr('mobile.runningIdle', { running, idle }),
              subtitle: tr('mobile.idleDesc'),
              icon: iconTpl('play'),
              iconBox: true,
              trailing: html`<button type="button" class="fh-mgroup-textbtn" @click=${() => state.onCloseIdle?.()}>${tr('mobile.closeIdle')}</button>`,
            },
          ],
        })}
  `;
}

export function createMobileMorePanel(options: MobileTabBarOptions = {}): MobileMorePanelController {
  const doc = options.doc ?? document;
  const resolveIcon = options.resolveIcon ?? defaultResolveIcon;
  const host = doc.createElement('div');
  host.className = 'wb-stack-more';

  let state: MobileMoreState = {};
  let subview: 'main' | 'appearance' = 'main';

  const iconTpl = (name: string): TemplateResult | undefined => {
    const raw = resolveIcon(name);
    return raw ? renderInlineSvg(raw, doc) : undefined;
  };

  const updateState = (patch: Partial<MobileMoreState>): void => {
    state = { ...state, ...patch };
    paint();
  };

  const paint = (): void => {
    const tpl =
      subview === 'appearance'
        ? renderMoreAppearanceTemplate(state, iconTpl, () => { subview = 'main'; paint(); }, updateState)
        : renderMoreMainTemplate(state, iconTpl, () => { subview = 'appearance'; paint(); }, updateState);
    render(tpl, host);
  };

  const component: PanelComponent = {
    element: host,
    init: () => {
      paint();
    },
    dispose: () => {
      render(nothing, host);
    },
  };

  return {
    component,
    setState(next: MobileMoreState) {
      state = { ...state, ...next };
      paint();
    },
    resetSubview() {
      if (subview !== 'main') {
        subview = 'main';
        paint();
      }
    },
    paint,
  };
}
