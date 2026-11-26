import { addDisposableListener } from '../../base/dom.js';
import { Emitter, type Event } from '../../base/event.js';
import { type Disposable, DisposableStore, toDisposable } from '../../base/lifecycle.js';

export interface ActivityBarItem {
  readonly id: string;
  readonly title: string;
  readonly icon: string;
  readonly view: string;
  readonly badge?: () => number | 'dot' | null;
  readonly order?: number;
  readonly section?: 'top' | 'bottom';
}

export interface ActivityBarOptions {
  readonly doc?: Document;
  readonly logoText?: string;
  readonly resolveIcon?: (name: string) => string;
}

interface RegisteredActivity {
  readonly item: ActivityBarItem;
  readonly seq: number;
}

function defaultResolveIcon(_name: string): string {
  return '';
}

export class ActivityBarPart implements Disposable {
  readonly element: HTMLElement;
  private readonly _doc: Document;
  private readonly _logoText: string;
  private readonly _resolveIcon: (name: string) => string;
  private readonly _items = new Map<string, RegisteredActivity>();
  private readonly _buttons = new Map<string, HTMLButtonElement>();
  private readonly _disposables = new DisposableStore();
  private readonly _renderDisposables = new DisposableStore();
  private readonly _onDidSelect = new Emitter<ActivityBarItem>();
  private _activeId: string | undefined;
  private _seq = 0;

  readonly onDidSelect: Event<ActivityBarItem> = this._onDidSelect.event;

  constructor(options: ActivityBarOptions = {}) {
    this._doc = options.doc ?? document;
    this._logoText = options.logoText ?? 'f';
    this._resolveIcon = options.resolveIcon ?? defaultResolveIcon;
    this.element = this._doc.createElement('nav');
    this.element.className = 'wb-activity-bar';
    this.element.setAttribute('aria-label', 'Activity bar');
    this._disposables.add(this._onDidSelect);
    this._disposables.add(this._renderDisposables);
    this._render();
  }

  registerItem(item: ActivityBarItem): Disposable {
    this._items.set(item.id, { item, seq: this._seq++ });
    this._render();
    return toDisposable(() => {
      if (this._items.get(item.id)?.item === item) {
        this._items.delete(item.id);
        this._render();
      }
    });
  }

  setActive(idOrView: string | undefined): void {
    let resolved = idOrView;
    if (idOrView && !this._items.has(idOrView)) {
      for (const entry of this._items.values()) {
        if (entry.item.view === idOrView) {
          resolved = entry.item.id;
          break;
        }
      }
    }
    if (this._activeId === resolved) return;
    this._activeId = resolved;
    for (const [id, btn] of this._buttons) {
      const on = id === this._activeId;
      btn.classList.toggle('is-active', on);
      if (on) btn.setAttribute('aria-current', 'page');
      else btn.removeAttribute('aria-current');
    }
  }

  getActive(): string | undefined {
    return this._activeId;
  }

  getItems(): readonly ActivityBarItem[] {
    return this._sortedItems().map((e) => e.item);
  }

  refreshBadges(): void {
    for (const [id, entry] of this._items) {
      const btn = this._buttons.get(id);
      if (!btn) continue;
      this._paintBadge(btn, entry.item.badge?.() ?? null);
    }
  }

  dispose(): void {
    this._items.clear();
    this._buttons.clear();
    this._disposables.dispose();
  }

  private _sortedItems(): RegisteredActivity[] {
    return [...this._items.values()].sort((a, b) => {
      const oa = a.item.order ?? 0;
      const ob = b.item.order ?? 0;
      return oa !== ob ? oa - ob : a.seq - b.seq;
    });
  }

  private _render(): void {
    this._renderDisposables.clear();
    this._buttons.clear();
    this.element.replaceChildren();

    const logo = this._doc.createElement('div');
    logo.className = 'wb-activity-logo';
    logo.setAttribute('aria-hidden', 'true');
    logo.textContent = this._logoText;
    this.element.appendChild(logo);

    const sorted = this._sortedItems();
    const topItems = sorted.filter((e) => (e.item.section ?? 'top') === 'top');
    const bottomItems = sorted.filter((e) => e.item.section === 'bottom');

    for (const entry of topItems) {
      this.element.appendChild(this._createItemButton(entry.item));
    }

    const spacer = this._doc.createElement('div');
    spacer.className = 'wb-activity-spacer';
    this.element.appendChild(spacer);

    for (const entry of bottomItems) {
      this.element.appendChild(this._createItemButton(entry.item));
    }
  }

  private _createItemButton(item: ActivityBarItem): HTMLButtonElement {
    const btn = this._doc.createElement('button');
    btn.type = 'button';
    btn.className = `wb-activity-item${item.id === this._activeId ? ' is-active' : ''}`;
    btn.dataset.activityId = item.id;
    btn.dataset.viewId = item.view;
    btn.title = item.title;
    btn.setAttribute('aria-label', item.title);
    if (item.id === this._activeId) btn.setAttribute('aria-current', 'page');

    const iconWrap = this._doc.createElement('span');
    iconWrap.className = 'wb-activity-icon';
    const svg = this._resolveIcon(item.icon);
    if (svg) iconWrap.innerHTML = svg;
    btn.appendChild(iconWrap);

    const label = this._doc.createElement('span');
    label.className = 'wb-activity-label';
    label.textContent = item.title;
    btn.appendChild(label);

    this._paintBadge(btn, item.badge?.() ?? null);
    this._renderDisposables.add(
      addDisposableListener(btn, 'click', () => {
        this._onDidSelect.fire(item);
      }),
    );
    this._buttons.set(item.id, btn);
    return btn;
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
