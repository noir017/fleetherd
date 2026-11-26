import { html, nothing, render, type TemplateResult } from '../../base/html.js';
import { type Disposable } from '../../base/lifecycle.js';
import { renderBadge } from '../badge/index.js';
import { type IconInput, renderIcon } from '../shared.js';

export type ActionVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export interface ActionItem {
  readonly id: string;
  readonly label?: string;
  readonly icon?: IconInput;
  readonly title?: string;
  readonly ariaLabel?: string;
  readonly variant?: ActionVariant;
  readonly active?: boolean;
  readonly disabled?: boolean;
  readonly badge?: number | string | null;
  readonly onClick?: (ev: MouseEvent) => void;
}

export interface ActionBarOptions {
  readonly items: readonly ActionItem[];
  readonly ariaLabel?: string;
  readonly compact?: boolean;
  readonly className?: string;
  readonly onAction?: (id: string, ev: MouseEvent) => void;
}

export interface ActionBarController extends Disposable {
  readonly el: HTMLElement;
  update(items: readonly ActionItem[]): void;
  setDisabled(id: string, disabled: boolean): void;
  setActive(id: string, active: boolean): void;
}

function renderActionButton(
  item: ActionItem,
  onAction?: (id: string, ev: MouseEvent) => void,
): TemplateResult {
  const variant = item.variant ?? (item.icon && !item.label ? 'ghost' : 'secondary');
  const iconOnly = Boolean(item.icon && !item.label);
  const cls =
    `fh-btn fh-btn--${variant}` +
    `${iconOnly ? ' fh-btn--icon' : ''}` +
    `${item.active ? ' is-active' : ''}`;
  const ariaLabel = item.ariaLabel ?? (iconOnly ? (item.title ?? item.id) : undefined);
  return html`<button
    type="button"
    class=${cls}
    data-action-id=${item.id}
    ?disabled=${Boolean(item.disabled)}
    title=${item.title ?? nothing}
    aria-label=${ariaLabel ?? nothing}
    aria-pressed=${item.active !== undefined ? (item.active ? 'true' : 'false') : nothing}
    @click=${(ev: MouseEvent) => {
      if (item.disabled) return;
      item.onClick?.(ev);
      onAction?.(item.id, ev);
    }}
  >${renderIcon(item.icon, 'fh-btn-icon')}${item.label
    ? html`<span class="fh-btn-label">${item.label}</span>`
    : nothing}${item.badge != null && item.badge !== '' ? renderBadge({ count: item.badge }) : nothing}</button>`;
}

export function renderActionBar(opts: ActionBarOptions): TemplateResult {
  const cls =
    `fh-actionbar${opts.compact ? ' fh-actionbar--compact' : ''}` +
    `${opts.className ? ` ${opts.className}` : ''}`;
  return html`<div class=${cls} role="toolbar" aria-label=${opts.ariaLabel ?? nothing}>
    ${opts.items.map((item) => renderActionButton(item, opts.onAction))}
  </div>`;
}

export function createActionBar(
  opts: ActionBarOptions,
  doc: Document = document,
): ActionBarController {
  const host = doc.createElement('div');
  host.className = 'fh-actionbar-host';
  let items = [...opts.items];

  const paint = (): void => {
    render(renderActionBar({ ...opts, items }), host);
  };
  paint();

  return {
    el: host,
    update(next: readonly ActionItem[]): void {
      items = [...next];
      paint();
    },
    setDisabled(id: string, disabled: boolean): void {
      items = items.map((it) => (it.id === id ? { ...it, disabled } : it));
      paint();
    },
    setActive(id: string, active: boolean): void {
      items = items.map((it) => (it.id === id ? { ...it, active } : it));
      paint();
    },
    dispose(): void {
      render(nothing, host);
      host.remove();
    },
  };
}

export {
  createSidebarActionBarHost,
  type SidebarActionBarHost,
  type SidebarActionBarHostOptions,
  type SidebarActionBarVisibilityApi,
} from './sidebar-host.js';
