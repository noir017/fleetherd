import { type Disposable, NOOP_DISPOSABLE, toDisposable } from './lifecycle.js';

export function addDisposableListener<K extends keyof WindowEventMap>(
  target: Window,
  type: K,
  listener: (ev: WindowEventMap[K]) => void,
  options?: boolean | AddEventListenerOptions,
): Disposable;
export function addDisposableListener<K extends keyof DocumentEventMap>(
  target: Document,
  type: K,
  listener: (ev: DocumentEventMap[K]) => void,
  options?: boolean | AddEventListenerOptions,
): Disposable;
export function addDisposableListener<K extends keyof HTMLElementEventMap>(
  target: HTMLElement,
  type: K,
  listener: (ev: HTMLElementEventMap[K]) => void,
  options?: boolean | AddEventListenerOptions,
): Disposable;
export function addDisposableListener(
  target: EventTarget,
  type: string,
  listener: EventListenerOrEventListenerObject,
  options?: boolean | AddEventListenerOptions,
): Disposable;
export function addDisposableListener(
  target: EventTarget,
  type: string,
  listener: EventListenerOrEventListenerObject,
  options?: boolean | AddEventListenerOptions,
): Disposable {
  target.addEventListener(type, listener, options);
  return toDisposable(() => {
    target.removeEventListener(type, listener, options);
  });
}

export function toggleClass(el: Element | null | undefined, cls: string, force?: boolean): void {
  if (!el) return;
  if (force === undefined) el.classList.toggle(cls);
  else el.classList.toggle(cls, force);
}

export function setAttr(
  el: Element | null | undefined,
  name: string,
  value: string | null | undefined,
): void {
  if (!el) return;
  if (value == null) el.removeAttribute(name);
  else el.setAttribute(name, value);
}

export function focusSafely(el: HTMLElement | null | undefined, options?: FocusOptions): void {
  if (!el || typeof el.focus !== 'function') return;
  try {
    el.focus(options);
  } catch {
    // Ignore focus errors on detached or inert elements.
  }
}

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || typeof target !== 'object') return false;
  const el = target as { tagName?: string; isContentEditable?: boolean };
  const tag = typeof el.tagName === 'string' ? el.tagName.toUpperCase() : '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return Boolean(el.isContentEditable);
}

export interface ElementSize {
  readonly width: number;
  readonly height: number;
}

export function observeResize(el: Element, cb: (size: ElementSize) => void): Disposable {
  if (typeof ResizeObserver !== 'function') return NOOP_DISPOSABLE;
  const ro = new ResizeObserver((entries) => {
    for (const entry of entries) {
      if (entry.target === el) {
        cb({ width: entry.contentRect.width, height: entry.contentRect.height });
      }
    }
  });
  ro.observe(el);
  return toDisposable(() => {
    ro.unobserve(el);
    ro.disconnect();
  });
}
