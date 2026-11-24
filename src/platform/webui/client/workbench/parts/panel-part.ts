import { addDisposableListener } from '../../base/dom.js';
import { Emitter, type Event } from '../../base/event.js';
import { type Disposable, DisposableStore } from '../../base/lifecycle.js';
import { clampSize } from '../dock/splitview.js';
import type { StaticDockPartHost, StaticTabInfo } from '../dock/static.js';

export interface PanelPartOptions {
  readonly doc?: Document;
  readonly minHeight?: number;
  readonly maxHeight?: number;
  readonly defaultHeight?: number;
  readonly resolveIcon?: (name: string) => string;
}

const DEFAULT_MIN_HEIGHT = 120;
const DEFAULT_MAX_HEIGHT = 600;
const DEFAULT_HEIGHT = 220;

function defaultResolveIcon(_name: string): string {
  return '';
}

export class PanelPart implements StaticDockPartHost, Disposable {
  readonly element: HTMLElement;
  readonly sash: HTMLDivElement;
  readonly header: HTMLElement;
  readonly body: HTMLElement;

  private readonly _doc: Document;
  private readonly _minHeight: number;
  private readonly _maxHeight: number;
  private readonly _defaultHeight: number;
  private readonly _tabsEl: HTMLElement;
  private readonly _closeBtn: HTMLButtonElement;
  private readonly _disposables = new DisposableStore();
  private readonly _tabDisposables = new DisposableStore();
  private readonly _onDidSelectTab = new Emitter<string>();
  private readonly _onDidRequestClose = new Emitter<void>();
  private readonly _onDidResize = new Emitter<number>();
  private _height: number;

  readonly onDidSelectTab: Event<string> = this._onDidSelectTab.event;
  readonly onDidRequestClose: Event<void> = this._onDidRequestClose.event;
  readonly onDidResize: Event<number> = this._onDidResize.event;

  constructor(options: PanelPartOptions = {}) {
    this._doc = options.doc ?? document;
    const resolveIcon = options.resolveIcon ?? defaultResolveIcon;
    this._minHeight = options.minHeight ?? DEFAULT_MIN_HEIGHT;
    this._maxHeight = options.maxHeight ?? DEFAULT_MAX_HEIGHT;
    this._defaultHeight = options.defaultHeight ?? DEFAULT_HEIGHT;
    this._height = clampSize(this._defaultHeight, this._minHeight, this._maxHeight);

    this.element = this._doc.createElement('section');
    this.element.className = 'wb-panel';
    this.element.setAttribute('aria-label', 'Bottom panel');
    this.element.hidden = true;
    this.element.style.height = `${this._height}px`;

    this.sash = this._doc.createElement('div');
    this.sash.className = 'wb-sash wb-sash-horizontal wb-panel-sash';
    this.sash.setAttribute('role', 'separator');
    this.sash.setAttribute('aria-orientation', 'horizontal');
    this.sash.setAttribute('aria-label', 'Resize bottom panel');

    this.header = this._doc.createElement('div');
    this.header.className = 'wb-part-head wb-panel-head';

    this._tabsEl = this._doc.createElement('div');
    this._tabsEl.className = 'wb-part-tabs wb-panel-tabs';
    this._tabsEl.setAttribute('role', 'tablist');
    this.header.appendChild(this._tabsEl);

    const spacer = this._doc.createElement('span');
    spacer.className = 'wb-spacer';
    this.header.appendChild(spacer);

    this._closeBtn = this._doc.createElement('button');
    this._closeBtn.type = 'button';
    this._closeBtn.className = 'wb-icon-btn wb-part-close';
    this._closeBtn.setAttribute('aria-label', 'Close panel');
    const crossSvg = resolveIcon('cross');
    if (crossSvg) this._closeBtn.innerHTML = crossSvg;
    else this._closeBtn.textContent = '×';
    this.header.appendChild(this._closeBtn);

    this.body = this._doc.createElement('div');
    this.body.className = 'wb-part-body wb-panel-body';

    this.element.append(this.sash, this.header, this.body);

    this._disposables.add(this._onDidSelectTab);
    this._disposables.add(this._onDidRequestClose);
    this._disposables.add(this._onDidResize);
    this._disposables.add(this._tabDisposables);
    this._disposables.add(
      addDisposableListener(this._closeBtn, 'click', () => {
        this._onDidRequestClose.fire();
      }),
    );
    this._disposables.add(
      addDisposableListener(this.sash, 'pointerdown', (ev) => this._startResize(ev)),
    );
    this._disposables.add(
      addDisposableListener(this.sash, 'dblclick', () => {
        this.setHeight(this._defaultHeight);
      }),
    );
  }

  getHeight(): number {
    return this._height;
  }

  setHeight(height: number): void {
    const next = Math.round(clampSize(height, this._minHeight, this._maxHeight));
    if (this._height === next) return;
    this._height = next;
    this.element.style.height = `${next}px`;
    this._onDidResize.fire(next);
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

  private _startResize(ev: PointerEvent): void {
    if (ev.button !== 0 && ev.pointerType === 'mouse') return;
    ev.preventDefault();
    const startY = ev.clientY;
    const startH = this._height;
    const win = this._doc.defaultView;
    if (!win) return;

    this.sash.classList.add('is-dragging');
    try {
      this.sash.setPointerCapture?.(ev.pointerId);
    } catch {
      // Synthetic pointer events in jsdom do not support capture.
    }

    const dragDisposables = new DisposableStore();
    dragDisposables.add(
      addDisposableListener(win, 'pointermove', (moveEv) => {
        const delta = startY - moveEv.clientY;
        this.setHeight(startH + delta);
      }),
    );
    const finish = (): void => {
      this.sash.classList.remove('is-dragging');
      dragDisposables.dispose();
    };
    dragDisposables.add(addDisposableListener(win, 'pointerup', finish));
    dragDisposables.add(addDisposableListener(win, 'pointercancel', finish));
  }
}
