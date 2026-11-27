import { unsafeHTML } from 'lit-html/directives/unsafe-html.js';
import { icon } from '../../../icons.js';
import { addDisposableListener, focusSafely } from '../../base/dom.js';
import { html, nothing, render } from '../../base/html.js';
import { type Disposable, DisposableStore, MutableDisposable } from '../../base/lifecycle.js';
import type { OverlayManager } from '../../services/overlays.js';
import { asNode, type IconInput, renderIcon } from '../shared.js';

export interface MenuActionItem {
  readonly kind?: 'item';
  readonly id: string;
  readonly label: string;
  readonly icon?: IconInput;
  readonly shortcut?: string;
  readonly title?: string;
  readonly disabled?: boolean;
  readonly danger?: boolean;
  readonly checked?: boolean;
  readonly onSelect?: () => void;
}

export interface MenuSeparator {
  readonly kind: 'separator';
}

export interface MenuHeader {
  readonly kind: 'header';
  readonly label: string;
}

export type MenuEntry = MenuActionItem | MenuSeparator | MenuHeader;

export type MenuAnchor = HTMLElement | { readonly x: number; readonly y: number };

export interface MenuRect {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

export interface MenuPosition {
  readonly left: number;
  readonly top: number;
}

export interface MenuOptions {
  readonly overlays?: OverlayManager;
  readonly container?: HTMLElement;
  readonly doc?: Document;
  readonly win?: Window;
  readonly align?: 'start' | 'end';
  readonly className?: string;
  readonly onClose?: () => void;
}

export interface MenuController extends Disposable {
  readonly el: HTMLElement;
  isOpen(): boolean;
  open(
    anchor: MenuAnchor,
    items: readonly MenuEntry[],
    onSelect?: (id: string, item: MenuActionItem) => void,
  ): void;
  close(focusBack?: boolean): void;
  setAnchor(anchor: MenuAnchor): void;
  reposition(): void;
}

const MENU_ITEM_SELECTOR = '[role="menuitem"]';

export function computeMenuPosition(
  anchor: MenuRect,
  menuSize: { readonly width: number; readonly height: number },
  viewport: { readonly width: number; readonly height: number },
  align: 'start' | 'end' = 'end',
  margin = 8,
): MenuPosition {
  const rawLeft = align === 'start' ? anchor.left : anchor.right - menuSize.width;
  const maxLeft = Math.max(margin, viewport.width - margin - menuSize.width);
  const left = Math.max(margin, Math.min(rawLeft, maxLeft));

  let top = anchor.bottom + 4;
  if (top + menuSize.height + margin > viewport.height) {
    top = Math.max(margin, anchor.top - 4 - menuSize.height);
  }
  return { left, top };
}

function anchorToRect(anchor: MenuAnchor): MenuRect {
  if ('x' in anchor && 'y' in anchor && typeof anchor.x === 'number') {
    return { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y };
  }
  const r = (anchor as HTMLElement).getBoundingClientRect();
  return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
}

function isAnchorElement(anchor: MenuAnchor | null): anchor is HTMLElement {
  return anchor !== null && !('x' in anchor && typeof anchor.x === 'number');
}

function handleMenuKeydown(
  ev: KeyboardEvent,
  doc: Document,
  hasOverlays: boolean,
  enabledButtons: () => HTMLButtonElement[],
  onClose: () => void,
): void {
  if (ev.key === 'Escape' && !hasOverlays) {
    ev.preventDefault();
    ev.stopPropagation();
    onClose();
    return;
  }
  if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp' && ev.key !== 'Home' && ev.key !== 'End') return;
  const buttons = enabledButtons();
  if (buttons.length === 0) return;
  ev.preventDefault();
  const active = doc.activeElement as HTMLButtonElement | null;
  const idx = active ? buttons.indexOf(active) : -1;
  let next = 0;
  if (ev.key === 'Home') next = 0;
  else if (ev.key === 'End') next = buttons.length - 1;
  else if (ev.key === 'ArrowDown') next = idx < 0 ? 0 : (idx + 1) % buttons.length;
  else next = idx < 0 ? buttons.length - 1 : (idx - 1 + buttons.length) % buttons.length;
  focusSafely(buttons[next]);
}

function renderMenuEntries(
  items: readonly MenuEntry[],
  onPick: (item: MenuActionItem) => void,
) {
  return items.map((entry) => {
    if (entry.kind === 'separator') {
      return html`<div class="fh-menu-sep" role="separator"></div>`;
    }
    if (entry.kind === 'header') {
      return html`<div class="fh-menu-header" role="presentation">${entry.label}</div>`;
    }
    const cls = `fh-menu-item${entry.danger ? ' is-danger' : ''}${entry.checked ? ' is-checked' : ''}`;
    const ariaChecked = typeof entry.checked === 'boolean' ? (entry.checked ? 'true' : 'false') : nothing;
    return html`<button
      type="button"
      class=${cls}
      role="menuitem"
      data-menu-id=${entry.id}
      aria-checked=${ariaChecked}
      ?disabled=${Boolean(entry.disabled)}
      title=${entry.title ?? nothing}
      @click=${() => {
        if (!entry.disabled) onPick(entry);
      }}
    >
      ${renderIcon(entry.icon, 'fh-menu-icon')}
      <span class="fh-menu-label">${entry.label}</span>
      ${entry.checked ? html`<span class="fh-menu-check" aria-hidden="true">${unsafeHTML(icon('check'))}</span>` : nothing}
      ${entry.shortcut ? html`<kbd class="fh-menu-kbd">${entry.shortcut}</kbd>` : nothing}
    </button>`;
  });
}

export function createMenu(opts: MenuOptions = {}): MenuController {
  const doc = opts.doc ?? document;
  const win = opts.win ?? window;
  const align = opts.align ?? 'end';
  const listeners = new DisposableStore();
  const overlaySub = new MutableDisposable();

  const el = doc.createElement('div');
  el.className = `fh-menu${opts.className ? ` ${opts.className}` : ''}`;
  el.setAttribute('role', 'menu');
  el.hidden = true;
  (opts.container ?? doc.body).appendChild(el);

  let currentAnchor: MenuAnchor | null = null;
  let lastAnchorElement: HTMLElement | null = null;
  let currentOnSelect: ((id: string, item: MenuActionItem) => void) | undefined;

  const enabledButtons = (): HTMLButtonElement[] =>
    Array.from(el.querySelectorAll<HTMLButtonElement>(MENU_ITEM_SELECTOR)).filter((b) => !b.disabled);

  const reposition = (): void => {
    if (el.hidden || !currentAnchor) return;
    if (isAnchorElement(currentAnchor) && !currentAnchor.isConnected) return;
    const rect = anchorToRect(currentAnchor);
    const width = el.offsetWidth || 200;
    const height = el.offsetHeight || 0;
    const pos = computeMenuPosition(
      rect,
      { width, height },
      { width: win.innerWidth, height: win.innerHeight },
      align,
    );
    el.style.left = `${pos.left}px`;
    el.style.top = `${pos.top}px`;
  };

  const setAnchor = (anchor: MenuAnchor): void => {
    if (el.hidden) return;
    if (isAnchorElement(currentAnchor) && currentAnchor !== anchor && currentAnchor.isConnected) {
      currentAnchor.setAttribute('aria-expanded', 'false');
    }
    currentAnchor = anchor;
    lastAnchorElement = isAnchorElement(anchor) ? anchor : null;
    if (isAnchorElement(anchor)) anchor.setAttribute('aria-expanded', 'true');
    reposition();
  };

  const close = (focusBack = false): void => {
    if (el.hidden) return;
    const prevAnchor = currentAnchor;
    el.hidden = true;
    currentAnchor = null;
    currentOnSelect = undefined;
    overlaySub.clear();
    if (isAnchorElement(prevAnchor)) {
      prevAnchor.setAttribute('aria-expanded', 'false');
      if (focusBack) focusSafely(prevAnchor);
    }
    opts.onClose?.();
  };

  const pickItem = (item: MenuActionItem): void => {
    const cb = currentOnSelect;
    close(false);
    item.onSelect?.();
    cb?.(item.id, item);
  };

  const open = (
    anchor: MenuAnchor,
    items: readonly MenuEntry[],
    onSelect?: (id: string, item: MenuActionItem) => void,
  ): void => {
    if (isAnchorElement(currentAnchor) && currentAnchor !== anchor) {
      currentAnchor.setAttribute('aria-expanded', 'false');
    }
    currentAnchor = anchor;
    lastAnchorElement = isAnchorElement(anchor) ? anchor : null;
    currentOnSelect = onSelect;
    render(html`${renderMenuEntries(items, pickItem)}`, el);
    el.hidden = false;
    if (isAnchorElement(anchor)) anchor.setAttribute('aria-expanded', 'true');
    reposition();

    if (opts.overlays) {
      overlaySub.value = opts.overlays.push({
        id: 'fh-menu',
        close: () => {
          close(false);
        },
        restoreFocus: () => (lastAnchorElement && lastAnchorElement.isConnected ? lastAnchorElement : null),
      });
    }
    focusSafely(enabledButtons()[0]);
  };

  listeners.add(
    addDisposableListener(el, 'keydown', (ev: KeyboardEvent) =>
      handleMenuKeydown(ev, doc, Boolean(opts.overlays), enabledButtons, () => close(true)),
    ),
  );

  listeners.add(
    addDisposableListener(el, 'focusout', (ev: FocusEvent) => {
      if (el.hidden) return;
      const to = asNode(ev.relatedTarget);
      // iOS Safari reports relatedTarget=null before click; leave that to document click below.
      if (!to || el.contains(to) || (isAnchorElement(currentAnchor) && currentAnchor.contains(to))) {
        return;
      }
      close(false);
    }),
  );

  listeners.add(
    addDisposableListener(doc, 'click', (ev: MouseEvent) => {
      if (el.hidden) return;
      const target = asNode(ev.target);
      if (target && (el.contains(target) || (isAnchorElement(currentAnchor) && currentAnchor.contains(target)))) {
        return;
      }
      close(false);
    }),
  );

  listeners.add(addDisposableListener(doc, 'scroll', () => reposition(), true));
  listeners.add(addDisposableListener(win, 'resize', () => reposition()));

  return {
    el,
    isOpen: () => !el.hidden,
    open,
    close,
    setAnchor,
    reposition,
    dispose(): void {
      close(false);
      overlaySub.dispose();
      listeners.dispose();
      render(nothing, el);
      el.remove();
    },
  };
}
