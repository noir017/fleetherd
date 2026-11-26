import { addDisposableListener } from '../../base/dom.js';
import { Emitter, type Event } from '../../base/event.js';
import { type Disposable, DisposableStore } from '../../base/lifecycle.js';
import type { DockPartHost, DockTabInfo } from '../dock/engine.js';

export interface SidebarPartOptions {
  readonly doc?: Document;
  readonly resolveIcon?: (name: string) => string;
  readonly isActivityView?: (panelId: string) => boolean;
}

export interface PartMoveMenuRequest {
  readonly anchor: HTMLElement;
  readonly panelId: string;
}

function defaultResolveIcon(_name: string): string {
  return '';
}

export class SidebarPart implements DockPartHost, Disposable {
  readonly element: HTMLElement;
  readonly header: HTMLElement;
  readonly body: HTMLElement;
  readonly actionsEl: HTMLElement;

  private readonly _doc: Document;
  private readonly _isActivityView?: (panelId: string) => boolean;
  private readonly _titleEl: HTMLElement;
  private readonly _tabsEl: HTMLElement;
  private readonly _moreBtn: HTMLButtonElement;
  private readonly _closeBtn: HTMLButtonElement;
  private _activePanelId: string | undefined;
  private readonly _disposables = new DisposableStore();
  private readonly _tabDisposables = new DisposableStore();
  private readonly _onDidSelectTab = new Emitter<string>();
  private readonly _onDidRequestClose = new Emitter<void>();
  private readonly _onDidRequestMoveMenu = new Emitter<PartMoveMenuRequest>();

  readonly onDidSelectTab: Event<string> = this._onDidSelectTab.event;
  readonly onDidRequestClose: Event<void> = this._onDidRequestClose.event;
  readonly onDidRequestMoveMenu: Event<PartMoveMenuRequest> = this._onDidRequestMoveMenu.event;

  constructor(options: SidebarPartOptions = {}) {
    this._doc = options.doc ?? document;
    this._isActivityView = options.isActivityView;
    const resolveIcon = options.resolveIcon ?? defaultResolveIcon;

    this.element = this._doc.createElement('aside');
    this.element.className = 'wb-sidebar';
    this.element.setAttribute('aria-label', 'Sidebar');

    this.header = this._doc.createElement('div');
    this.header.className = 'wb-part-head wb-sidebar-head';

    this._titleEl = this._doc.createElement('span');
    this._titleEl.className = 'wb-part-title';
    this.header.appendChild(this._titleEl);

    this.actionsEl = this._doc.createElement('div');
    this.actionsEl.className = 'wb-part-actions';
    this.header.appendChild(this.actionsEl);

    this._moreBtn = this._doc.createElement('button');
    this._moreBtn.type = 'button';
    this._moreBtn.className = 'wb-icon-btn wb-part-more';
    this._moreBtn.dataset.dndIgnore = '1';
    this._moreBtn.setAttribute('aria-label', 'Move view');
    this._moreBtn.setAttribute('aria-haspopup', 'menu');
    this._moreBtn.setAttribute('aria-expanded', 'false');
    this._moreBtn.hidden = true;
    const moreSvg = resolveIcon('more');
    if (moreSvg) this._moreBtn.innerHTML = moreSvg;
    else this._moreBtn.textContent = '⋯';
    this.header.appendChild(this._moreBtn);

    this._closeBtn = this._doc.createElement('button');
    this._closeBtn.type = 'button';
    this._closeBtn.className = 'wb-icon-btn wb-part-close';
    this._closeBtn.setAttribute('aria-label', 'Close sidebar');
    const crossSvg = resolveIcon('cross');
    if (crossSvg) this._closeBtn.innerHTML = crossSvg;
    else this._closeBtn.textContent = '×';
    this.header.appendChild(this._closeBtn);

    this._tabsEl = this._doc.createElement('div');
    this._tabsEl.className = 'wb-part-tabs';
    this._tabsEl.setAttribute('role', 'tablist');
    this._tabsEl.hidden = true;

    this.body = this._doc.createElement('div');
    this.body.className = 'wb-part-body wb-sidebar-body';

    this.element.append(this.header, this._tabsEl, this.body);

    this._disposables.add(this._onDidSelectTab);
    this._disposables.add(this._onDidRequestClose);
    this._disposables.add(this._onDidRequestMoveMenu);
    this._disposables.add(this._tabDisposables);
    this._disposables.add(
      addDisposableListener(this._moreBtn, 'click', () => {
        if (this._activePanelId) {
          this._onDidRequestMoveMenu.fire({ anchor: this._moreBtn, panelId: this._activePanelId });
        }
      }),
    );
    this._disposables.add(
      addDisposableListener(this._closeBtn, 'click', () => {
        this._onDidRequestClose.fire();
      }),
    );
  }

  setTitle(title: string): void {
    this._titleEl.textContent = title;
  }

  setVisible(visible: boolean): void {
    this.element.hidden = !visible;
    this.element.classList.toggle('is-open', visible);
  }

  setTabs(tabs: readonly DockTabInfo[], activeId: string | undefined): void {
    this._tabDisposables.clear();
    const active = tabs.find((t) => t.id === activeId) ?? tabs[0];
    this._activePanelId = active?.id;
    this._titleEl.textContent = active?.title ?? '';
    this._moreBtn.hidden = !active || active.id === 'more';

    this._tabsEl.replaceChildren();
    const allActivityViews =
      this._isActivityView !== undefined &&
      tabs.length > 0 &&
      tabs.every((t) => this._isActivityView!(t.id));
    this._tabsEl.hidden = tabs.length < 2 || allActivityViews;
    if (this._tabsEl.hidden) return;

    for (const tab of tabs) {
      const btn = this._doc.createElement('button');
      btn.type = 'button';
      btn.className = `wb-part-tab${tab.id === activeId ? ' is-active' : ''}`;
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-selected', String(tab.id === activeId));
      btn.dataset.panelId = tab.id;
      btn.textContent = tab.title;
      if (tab.badge !== null && tab.badge > 0) {
        const b = this._doc.createElement('span');
        b.className = 'wb-badge';
        b.textContent = String(tab.badge);
        btn.appendChild(b);
      }
      this._tabDisposables.add(
        addDisposableListener(btn, 'click', () => {
          this._onDidSelectTab.fire(tab.id);
        }),
      );
      this._tabDisposables.add(
        addDisposableListener(btn, 'contextmenu', (ev) => {
          ev.preventDefault();
          this._onDidRequestMoveMenu.fire({ anchor: btn, panelId: tab.id });
        }),
      );
      this._tabsEl.appendChild(btn);
    }
  }

  dispose(): void {
    this._disposables.dispose();
  }
}
