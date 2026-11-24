import { focusSafely } from '../../base/dom.js';
import { html, nothing, render, type TemplateResult } from '../../base/html.js';
import { type Disposable } from '../../base/lifecycle.js';
import { type EmptyStateOptions, renderEmptyState } from '../notice/index.js';
import { escapeAttrValue, type IconInput, renderIcon } from '../shared.js';

export interface ListItem<T = unknown> {
  readonly id: string;
  readonly label: string;
  readonly meta?: string | TemplateResult;
  readonly leading?: TemplateResult;
  readonly trailing?: string | TemplateResult;
  readonly indent?: number;
  readonly disabled?: boolean;
  readonly hasMenu?: boolean;
  readonly menuTitle?: string;
  readonly className?: string;
  readonly data?: T;
}

export interface ListGroup<T = unknown> {
  readonly id: string;
  readonly label?: string;
  readonly items: readonly ListItem<T>[];
}

export interface ListOptions<T = unknown> {
  readonly groups: readonly ListGroup<T>[];
  readonly selectedId?: string | null;
  readonly multiSelect?: boolean;
  readonly selectedIds?: ReadonlySet<string>;
  readonly ariaLabel?: string;
  readonly menuIcon?: IconInput;
  readonly empty?: EmptyStateOptions | TemplateResult;
  readonly className?: string;
  readonly renderItem?: (item: ListItem<T>, selected: boolean) => TemplateResult;
  readonly onSelect?: (item: ListItem<T>, ev?: Event) => void;
  readonly onActivate?: (item: ListItem<T>, ev?: Event) => void;
  readonly onSelectionChange?: (ids: ReadonlySet<string>) => void;
  readonly onItemMenu?: (item: ListItem<T>, anchor: HTMLElement, ev: Event) => void;
}

export interface ListController<T = unknown> extends Disposable {
  readonly el: HTMLElement;
  setGroups(groups: readonly ListGroup<T>[]): void;
  setSelected(id: string | null): void;
  getSelected(): string | null;
  setMultiSelect(enabled: boolean): void;
  setSelectedIds(ids: Iterable<string>): void;
  getSelectedIds(): ReadonlySet<string>;
  focusSelected(): void;
}

function flattenEnabled<T>(groups: readonly ListGroup<T>[]): ListItem<T>[] {
  const out: ListItem<T>[] = [];
  for (const g of groups) {
    for (const item of g.items) {
      if (!item.disabled) out.push(item);
    }
  }
  return out;
}

function isTemplateResult(val: EmptyStateOptions | TemplateResult): val is TemplateResult {
  return typeof val === 'object' && val !== null && '_$litType$' in val;
}

function renderDefaultItemContent<T>(item: ListItem<T>): TemplateResult {
  return html`
    ${item.leading ? html`<span class="fh-list-leading">${item.leading}</span>` : nothing}
    <span class="fh-list-main">
      <span class="fh-list-title">${item.label}</span>
      ${item.meta ? html`<span class="fh-list-meta">${item.meta}</span>` : nothing}
    </span>
    ${item.trailing ? html`<span class="fh-list-trailing">${item.trailing}</span>` : nothing}
  `;
}

function computeNextItem<T>(
  enabled: readonly ListItem<T>[],
  currentId: string,
  key: string,
): ListItem<T> | undefined {
  if (enabled.length === 0) return undefined;
  const idx = enabled.findIndex((it) => it.id === currentId);
  if (key === 'Home') return enabled[0];
  if (key === 'End') return enabled[enabled.length - 1];
  if (key === 'ArrowDown') return enabled[idx < 0 ? 0 : (idx + 1) % enabled.length];
  if (key === 'ArrowUp') return enabled[idx < 0 ? enabled.length - 1 : (idx - 1 + enabled.length) % enabled.length];
  return undefined;
}

function computeRangeSelection<T>(
  enabled: readonly ListItem<T>[],
  anchorId: string,
  targetId: string,
  prev: ReadonlySet<string>,
): Set<string> {
  const a = enabled.findIndex((it) => it.id === anchorId);
  const b = enabled.findIndex((it) => it.id === targetId);
  const next = new Set(prev);
  if (a < 0 || b < 0) {
    next.add(targetId);
    return next;
  }
  const [from, to] = a <= b ? [a, b] : [b, a];
  for (let i = from; i <= to; i++) {
    const it = enabled[i];
    if (it) next.add(it.id);
  }
  return next;
}

function isContextMenuKey(ev: KeyboardEvent): boolean {
  return ev.key === 'ContextMenu' || (ev.key === 'F10' && ev.shiftKey);
}

function isNavKey(key: string): boolean {
  return key === 'ArrowDown' || key === 'ArrowUp' || key === 'Home' || key === 'End';
}

interface ListRowContext<T> {
  readonly opts: ListOptions<T>;
  readonly selectedId: string | null;
  readonly multiSelect: boolean;
  readonly selectedIds: ReadonlySet<string>;
  readonly firstEnabledId: string | null;
  readonly onRowClick: (item: ListItem<T>, ev: MouseEvent) => void;
  readonly onRowKeydown: (item: ListItem<T>, ev: KeyboardEvent) => void;
  readonly onToggleMulti: (item: ListItem<T>, shiftKey: boolean) => void;
}

function renderListMenuButton<T>(item: ListItem<T>, opts: ListOptions<T>): TemplateResult | typeof nothing {
  if (!item.hasMenu || !opts.onItemMenu) return nothing;
  return html`<button
    type="button"
    class="fh-list-menu-btn"
    tabindex="-1"
    title=${item.menuTitle ?? 'More actions'}
    aria-label=${item.menuTitle ?? `Actions for ${item.label}`}
    aria-haspopup="menu"
    aria-expanded="false"
    @click=${(ev: MouseEvent) => {
      ev.stopPropagation();
      opts.onItemMenu?.(item, ev.currentTarget as HTMLElement, ev);
    }}
  >${opts.menuIcon ? renderIcon(opts.menuIcon, 'fh-icon') : html`<span aria-hidden="true">⋯</span>`}</button>`;
}

function renderListRow<T>(item: ListItem<T>, ctx: ListRowContext<T>): TemplateResult {
  const isSel = ctx.multiSelect ? ctx.selectedIds.has(item.id) : item.id === ctx.selectedId;
  const isTabStop = item.id === ctx.selectedId || (ctx.selectedId === null && item.id === ctx.firstEnabledId);
  const cls = [
    'fh-list-row',
    isSel ? 'is-selected' : '',
    item.disabled ? 'is-disabled' : '',
    item.indent ? 'is-nested' : '',
    item.className ?? '',
  ]
    .filter(Boolean)
    .join(' ');
  const indentStyle = item.indent ? `padding-left:${14 + item.indent * 18}px` : nothing;
  return html`<div
    class=${cls}
    role="option"
    data-list-id=${item.id}
    aria-selected=${isSel ? 'true' : 'false'}
    aria-disabled=${item.disabled ? 'true' : nothing}
    tabindex=${item.disabled ? '-1' : isTabStop ? '0' : '-1'}
    style=${indentStyle}
    @click=${(ev: MouseEvent) => ctx.onRowClick(item, ev)}
    @keydown=${(ev: KeyboardEvent) => ctx.onRowKeydown(item, ev)}
  >
    ${ctx.multiSelect
      ? html`<input
          type="checkbox"
          class="fh-list-check"
          tabindex="-1"
          .checked=${ctx.selectedIds.has(item.id)}
          ?disabled=${Boolean(item.disabled)}
          aria-label=${item.label}
          @click=${(ev: MouseEvent) => {
            ev.stopPropagation();
            if (!item.disabled) ctx.onToggleMulti(item, ev.shiftKey);
          }}
        />`
      : nothing}
    ${ctx.opts.renderItem ? ctx.opts.renderItem(item, isSel) : renderDefaultItemContent(item)}
    ${renderListMenuButton(item, ctx.opts)}
  </div>`;
}

function renderListGroups<T>(
  groups: readonly ListGroup<T>[],
  opts: ListOptions<T>,
  multiSelect: boolean,
  rowCtx: ListRowContext<T>,
): TemplateResult {
  const cls = `fh-list${opts.className ? ` ${opts.className}` : ''}`;
  return html`<div
    class=${cls}
    role="listbox"
    aria-label=${opts.ariaLabel ?? nothing}
    aria-multiselectable=${multiSelect ? 'true' : nothing}
  >
    ${groups.map((group) =>
      group.items.length === 0
        ? nothing
        : html`<div class="fh-list-group" role="group" aria-label=${group.label ?? nothing}>
            ${group.label ? html`<div class="fh-list-group-head">${group.label}</div>` : nothing}
            ${group.items.map((item) => renderListRow(item, rowCtx))}
          </div>`,
    )}
  </div>`;
}

export function createList<T = unknown>(
  opts: ListOptions<T>,
  doc: Document = document,
): ListController<T> {
  const host = doc.createElement('div');
  host.className = 'fh-list-host';

  let groups: readonly ListGroup<T>[] = opts.groups;
  let selectedId: string | null = opts.selectedId ?? null;
  let multiSelect = Boolean(opts.multiSelect);
  let selectedIds = new Set<string>(opts.selectedIds ?? []);
  let rangeAnchorId: string | null = selectedId;

  const focusItemById = (id: string): void => {
    const el = host.querySelector<HTMLElement>(`[data-list-id="${escapeAttrValue(id)}"]`);
    focusSafely(el);
  };

  const toggleMultiId = (item: ListItem<T>, shiftKey: boolean): void => {
    const enabled = flattenEnabled(groups);
    if (shiftKey && rangeAnchorId) {
      selectedIds = computeRangeSelection(enabled, rangeAnchorId, item.id, selectedIds);
    } else if (selectedIds.has(item.id)) {
      selectedIds.delete(item.id);
    } else {
      selectedIds.add(item.id);
    }
    rangeAnchorId = item.id;
    selectedId = item.id;
    paint();
    opts.onSelectionChange?.(new Set(selectedIds));
  };

  const handleRowClick = (item: ListItem<T>, ev: MouseEvent): void => {
    if (item.disabled) return;
    if (multiSelect || ev.ctrlKey || ev.metaKey || ev.shiftKey) {
      if (multiSelect || opts.onSelectionChange) {
        toggleMultiId(item, ev.shiftKey);
        return;
      }
    }
    selectedId = item.id;
    rangeAnchorId = item.id;
    paint();
    opts.onSelect?.(item, ev);
    opts.onActivate?.(item, ev);
  };

  const handleRowKeydown = (item: ListItem<T>, ev: KeyboardEvent): void => {
    if (isNavKey(ev.key)) {
      const target = computeNextItem(flattenEnabled(groups), item.id, ev.key);
      if (!target) return;
      ev.preventDefault();
      selectedId = target.id;
      paint();
      focusItemById(target.id);
      opts.onSelect?.(target, ev);
      return;
    }
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault();
      if (multiSelect && ev.key === ' ') {
        toggleMultiId(item, ev.shiftKey);
        return;
      }
      selectedId = item.id;
      paint();
      opts.onSelect?.(item, ev);
      opts.onActivate?.(item, ev);
      return;
    }
    if (isContextMenuKey(ev) && item.hasMenu && opts.onItemMenu) {
      ev.preventDefault();
      const row = ev.currentTarget as HTMLElement;
      const anchor = row.querySelector<HTMLElement>('.fh-list-menu-btn') ?? row;
      opts.onItemMenu(item, anchor, ev);
    }
  };

  const paint = (): void => {
    const enabled = flattenEnabled(groups);
    const totalCount = groups.reduce((acc, g) => acc + g.items.length, 0);
    if (totalCount === 0 && opts.empty) {
      const tpl = isTemplateResult(opts.empty) ? opts.empty : renderEmptyState(opts.empty);
      render(html`<div class=${`fh-list fh-list--empty${opts.className ? ` ${opts.className}` : ''}`}>${tpl}</div>`, host);
      return;
    }
    const firstEnabledId = enabled[0]?.id ?? null;
    const rowCtx: ListRowContext<T> = {
      opts,
      selectedId,
      multiSelect,
      selectedIds,
      firstEnabledId,
      onRowClick: handleRowClick,
      onRowKeydown: handleRowKeydown,
      onToggleMulti: toggleMultiId,
    };
    render(renderListGroups(groups, opts, multiSelect, rowCtx), host);
  };

  paint();

  return {
    el: host,
    setGroups(next): void {
      groups = next;
      paint();
    },
    setSelected(id): void {
      selectedId = id;
      rangeAnchorId = id;
      paint();
    },
    getSelected(): string | null {
      return selectedId;
    },
    setMultiSelect(enabled): void {
      multiSelect = enabled;
      paint();
    },
    setSelectedIds(ids): void {
      selectedIds = new Set(ids);
      paint();
    },
    getSelectedIds(): ReadonlySet<string> {
      return new Set(selectedIds);
    },
    focusSelected(): void {
      const targetId = selectedId ?? flattenEnabled(groups)[0]?.id;
      if (targetId) focusItemById(targetId);
    },
    dispose(): void {
      render(nothing, host);
      host.remove();
    },
  };
}
