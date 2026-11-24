import { addDisposableListener } from '../../base/dom.js';
import { Emitter, type Event } from '../../base/event.js';
import { type Disposable, DisposableStore } from '../../base/lifecycle.js';
import type { StaticDockPartHost, StaticTabInfo } from '../dock/static.js';

export interface SecondaryPartOptions {
  readonly doc?: Document;
  readonly resolveIcon?: (name: string) => string;
}

function defaultResolveIcon(_name: string): string {
  return '';
}

export class SecondaryPart implements StaticDockPartHost, Disposable {
  readonly element: HTMLElement;
  readonly header: HTMLElement;
  readonly body: HTMLElement;

  private readonly _doc: Document;
  private readonly _tabsEl: HTMLElement;
  private readonly _closeBtn: HTMLButtonElement;
  private readonly _disposables = new DisposableStore();
  private readonly _tabDisposables = new DisposableStore();
  private readonly _onDidSelectTab = new Emitter<string>();
  private readonly _onDidRequestClose = new Emitter<void>();

  readonly onDidSelectTab: Event<string> = this._onDidSelectTab.event;
  readonly onDidRequestClose: Event<void> = this._onDidRequestClose.event;

  constructor(options: SecondaryPartOptions = {}) {
    this._doc = options.doc ?? document;
    const resolveIcon = options.resolveIcon ?? defaultResolveIcon;

    this.element = this._doc.createElement('aside');
    this.element.className = 'wb-secondary';
    this.element.setAttribute('aria-label', 'Secondary sidebar');
    this.element.hidden = true;

    this.header = this._doc.createElement('div');
    this.header.className = 'wb-part-head wb-secondary-head';

    this._tabsEl = this._doc.createElement('div');
    this._tabsEl.className = 'wb-part-tabs wb-secondary-tabs';
    this._tabsEl.setAttribute('role', 'tablist');
    this.header.appendChild(this._tabsEl);

    const spacer = this._doc.createElement('span');
    spacer.className = 'wb-spacer';
    this.header.appendChild(spacer);

    this._closeBtn = this._doc.createElement('button');
    this._closeBtn.type = 'button';
    this._closeBtn.className = 'wb-icon-btn wb-part-close';
    this._closeBtn.setAttribute('aria-label', 'Close secondary sidebar');
    const crossSvg = resolveIcon('cross');
    if (crossSvg) this._closeBtn.innerHTML = crossSvg;
    else this._closeBtn.textContent = '×';
    this.header.appendChild(this._closeBtn);

    this.body = this._doc.createElement('div');
    this.body.className = 'wb-part-body wb-secondary-body';

    this.element.append(this.header, this.body);

    this._disposables.add(this._onDidSelectTab);
    this._disposables.add(this._onDidRequestClose);
    this._disposables.add(this._tabDisposables);
    this._disposables.add(
      addDisposableListener(this._closeBtn, 'click', () => {
        this._onDidRequestClose.fire();
      }),
    );
  }

  setVisible(visible: boolean): void {
    this.element.hidden = !visible;
    this.element.classList.toggle('is-open', visible);
  }

  setTabs(tabs: readonly StaticTabInfo[], activeId: string | undefined): void {
    this._tabDisposables.clear();
    this._tabsEl.replaceChildren();
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
      this._tabsEl.appendChild(btn);
    }
  }

  dispose(): void {
    this._disposables.dispose();
  }
}
