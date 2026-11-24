import { addDisposableListener } from '../../base/dom.js';
import { type Disposable, DisposableStore, toDisposable } from '../../base/lifecycle.js';

export interface StatusBarItem {
  readonly id: string;
  readonly align: 'left' | 'right';
  readonly order?: number;
  readonly prominent?: boolean;
  render(el: HTMLElement): void;
  onClick?(): void;
}

export interface StatusBarOptions {
  readonly doc?: Document;
}

interface RegisteredStatusItem {
  readonly item: StatusBarItem;
  readonly seq: number;
  readonly el: HTMLElement;
  readonly clickSub?: Disposable;
}

export class StatusBarPart implements Disposable {
  readonly element: HTMLElement;
  private readonly _doc: Document;
  private readonly _leftEl: HTMLElement;
  private readonly _rightEl: HTMLElement;
  private readonly _items = new Map<string, RegisteredStatusItem>();
  private readonly _disposables = new DisposableStore();
  private _seq = 0;

  constructor(options: StatusBarOptions = {}) {
    this._doc = options.doc ?? document;
    this.element = this._doc.createElement('footer');
    this.element.className = 'wb-status-bar';
    this.element.setAttribute('role', 'status');

    this._leftEl = this._doc.createElement('div');
    this._leftEl.className = 'wb-status-group wb-status-left';

    const spacer = this._doc.createElement('div');
    spacer.className = 'wb-spacer';

    this._rightEl = this._doc.createElement('div');
    this._rightEl.className = 'wb-status-group wb-status-right';

    this.element.append(this._leftEl, spacer, this._rightEl);
  }

  registerItem(item: StatusBarItem): Disposable {
    const existing = this._items.get(item.id);
    if (existing) {
      existing.clickSub?.dispose();
      existing.el.remove();
    }

    const tag = item.onClick ? 'button' : 'span';
    const el = this._doc.createElement(tag);
    if (el instanceof HTMLButtonElement) el.type = 'button';
    el.className = `wb-status-item${item.prominent ? ' is-prominent' : ''}${item.onClick ? ' is-clickable' : ''}`;
    el.dataset.statusId = item.id;

    let clickSub: Disposable | undefined;
    if (item.onClick) {
      const handler = item.onClick;
      clickSub = addDisposableListener(el, 'click', () => handler());
    }

    const record: RegisteredStatusItem = {
      item,
      seq: this._seq++,
      el,
      clickSub,
    };
    this._items.set(item.id, record);
    item.render(el);
    this._syncOrder();

    return toDisposable(() => {
      if (this._items.get(item.id) === record) {
        record.clickSub?.dispose();
        record.el.remove();
        this._items.delete(item.id);
      }
    });
  }

  refresh(id?: string): void {
    if (id !== undefined) {
      const entry = this._items.get(id);
      if (entry) entry.item.render(entry.el);
      return;
    }
    for (const entry of this._items.values()) {
      entry.item.render(entry.el);
    }
  }

  getItems(align?: 'left' | 'right'): readonly StatusBarItem[] {
    return this._sorted(align).map((e) => e.item);
  }

  dispose(): void {
    for (const entry of this._items.values()) {
      entry.clickSub?.dispose();
    }
    this._items.clear();
    this._disposables.dispose();
  }

  private _sorted(align?: 'left' | 'right'): RegisteredStatusItem[] {
    return [...this._items.values()]
      .filter((e) => !align || e.item.align === align)
      .sort((a, b) => {
        const oa = a.item.order ?? 0;
        const ob = b.item.order ?? 0;
        return oa !== ob ? oa - ob : a.seq - b.seq;
      });
  }

  private _syncOrder(): void {
    this._leftEl.replaceChildren(...this._sorted('left').map((e) => e.el));
    this._rightEl.replaceChildren(...this._sorted('right').map((e) => e.el));
  }
}
