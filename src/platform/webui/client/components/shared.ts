import { unsafeHTML } from 'lit-html/directives/unsafe-html.js';
import { html, nothing, type TemplateResult } from '../base/html.js';

export type IconInput = string | TemplateResult;

export function renderIcon(
  icon: IconInput | null | undefined,
  cls = 'fh-icon',
): TemplateResult | typeof nothing {
  if (!icon) return nothing;
  if (typeof icon === 'string') {
    return html`<span class=${cls} aria-hidden="true">${unsafeHTML(icon)}</span>`;
  }
  return html`<span class=${cls} aria-hidden="true">${icon}</span>`;
}

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function getFocusableElements(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => !el.hidden && el.getAttribute('aria-hidden') !== 'true',
  );
}

export function asElement(target: EventTarget | null): Element | null {
  return target && typeof (target as Element).closest === 'function' ? (target as Element) : null;
}

export function asNode(target: EventTarget | null): Node | null {
  return target && typeof (target as Node).nodeType === 'number' ? (target as Node) : null;
}

export function escapeAttrValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
