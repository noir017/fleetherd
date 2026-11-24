import { html, nothing, render, type TemplateResult } from '../../base/html.js';
import { type IconInput, renderIcon } from '../shared.js';

export type BadgeTone = 'accent' | 'neutral' | 'ok' | 'warn' | 'err';
export type StatusTone = 'ok' | 'warn' | 'err' | 'idle';
export type KnownHarness = 'claude' | 'codex' | 'opencode' | 'agy' | 'gemini' | 'dsh';

const KNOWN_HARNESSES = new Set<string>(['claude', 'codex', 'opencode', 'agy', 'gemini', 'dsh']);

export interface BadgeOptions {
  readonly count?: number | string | null;
  readonly max?: number;
  readonly dot?: boolean;
  readonly tone?: BadgeTone;
  readonly title?: string;
  readonly ariaLabel?: string;
  readonly className?: string;
}

export interface TagOptions {
  readonly label: string;
  readonly harness?: KnownHarness | (string & {});
  readonly tone?: BadgeTone;
  readonly icon?: IconInput;
  readonly title?: string;
  readonly className?: string;
}

export interface StatusDotOptions {
  readonly status: StatusTone;
  readonly pulsing?: boolean;
  readonly label?: string;
  readonly className?: string;
}

export function formatBadgeCount(count: number | string, max?: number): string {
  if (typeof count === 'number' && typeof max === 'number' && count > max) {
    return `${max}+`;
  }
  return String(count);
}

export function renderBadge(opts: BadgeOptions): TemplateResult | typeof nothing {
  const tone = opts.tone ?? 'accent';
  if (opts.dot) {
    const cls = `fh-badge fh-badge--dot fh-badge--${tone}${opts.className ? ` ${opts.className}` : ''}`;
    return html`<span
      class=${cls}
      title=${opts.title ?? nothing}
      aria-label=${opts.ariaLabel ?? opts.title ?? nothing}
      aria-hidden=${opts.ariaLabel || opts.title ? nothing : 'true'}
    ></span>`;
  }
  if (opts.count == null || opts.count === '') return nothing;
  const text = formatBadgeCount(opts.count, opts.max);
  const cls = `fh-badge fh-badge--${tone}${opts.className ? ` ${opts.className}` : ''}`;
  return html`<span
    class=${cls}
    title=${opts.title ?? nothing}
    aria-label=${opts.ariaLabel ?? nothing}
  >${text}</span>`;
}

export function renderTag(opts: TagOptions): TemplateResult {
  const harnessKey = opts.harness ? opts.harness.toLowerCase() : '';
  const isKnownHarness = harnessKey !== '' && KNOWN_HARNESSES.has(harnessKey);
  const modifier = isKnownHarness
    ? `fh-tag--hc-${harnessKey}`
    : `fh-tag--${opts.tone ?? 'neutral'}`;
  const cls = `fh-tag ${modifier}${opts.className ? ` ${opts.className}` : ''}`;
  return html`<span
    class=${cls}
    data-harness=${harnessKey || nothing}
    title=${opts.title ?? nothing}
  >${renderIcon(opts.icon, 'fh-tag-icon')}<span class="fh-tag-label">${opts.label}</span></span>`;
}

export function renderStatusDot(opts: StatusDotOptions): TemplateResult {
  const cls =
    `fh-dot fh-dot--${opts.status}` +
    `${opts.pulsing ? ' is-pulsing' : ''}` +
    `${opts.className ? ` ${opts.className}` : ''}`;
  return html`<span
    class=${cls}
    role=${opts.label ? 'img' : nothing}
    title=${opts.label ?? nothing}
    aria-label=${opts.label ?? nothing}
    aria-hidden=${opts.label ? nothing : 'true'}
  ></span>`;
}

export function mountBadge(container: HTMLElement, opts: BadgeOptions): void {
  render(renderBadge(opts), container);
}

export function mountTag(container: HTMLElement, opts: TagOptions): void {
  render(renderTag(opts), container);
}

export function mountStatusDot(container: HTMLElement, opts: StatusDotOptions): void {
  render(renderStatusDot(opts), container);
}
