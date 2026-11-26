import { addDisposableListener, focusSafely } from '../../base/dom.js';
import { html, nothing, render, type TemplateResult } from '../../base/html.js';
import { DisposableStore, type Disposable } from '../../base/lifecycle.js';
import { getLocale } from '../../i18n/index.js';
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

export interface ListBatchAction<T = unknown> {
  readonly id: string;
  readonly label: string;
  readonly title?: string;
  readonly icon?: IconInput;
  readonly variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  readonly disabled?: boolean | ((items: readonly ListItem<T>[], ids: ReadonlySet<string>) => boolean);
  readonly onAction: (items: readonly ListItem<T>[], ids: ReadonlySet<string>) => void | Promise<void>;
}

export interface ListBatchLabels {
  readonly selectedCount?: (count: number, total: number) => string;
  readonly selectAll?: string;
  readonly clearSelection?: string;
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
  readonly batchActions?: readonly ListBatchAction<T>[];
  readonly batchLabels?: ListBatchLabels;
  readonly renderItem?: (item: ListItem<T>, selected: boolean) => TemplateResult;
  readonly onSelect?: (item: ListItem<T>, ev?: Event) => void;
  readonly onActivate?: (item: ListItem<T>, ev?: Event) => void;
  readonly onSelectionChange?: (ids: ReadonlySet<string>) => void;
  readonly onExitMultiSelect?: () => void;
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
  selectAll(): void;
  clearSelection(): void;
  setBatchActions(actions: readonly ListBatchAction<T>[]): void;
  focusSelected(): void;
}

export interface DomListBatchAction {
  readonly id: string;
  readonly label: string;
  readonly title?: string;
  readonly icon?: IconInput;
  readonly variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  readonly disabled?: boolean | ((ids: ReadonlySet<string>) => boolean);
  readonly onAction: (ids: ReadonlySet<string>) => void | Promise<void>;
}

export interface DomListNavigationOptions {
  readonly container: HTMLElement;
  readonly batchBarHost?: HTMLElement;
  readonly rowSelector: string;
  readonly getRowId: (row: HTMLElement) => string | null;
  readonly ignoreSelector?: string;
  readonly getBatchActions?: (ids: ReadonlySet<string>) => readonly DomListBatchAction[];
  readonly batchLabels?: ListBatchLabels;
  /** Allow Ctrl/Cmd+Click to toggle multi-select (default: true). Set false when Ctrl/Cmd+Click has a dedicated action (e.g., open in new tab). */
  readonly ctrlSelect?: boolean;
  readonly onActivate?: (id: string, row: HTMLElement, ev: Event) => void;
  readonly onFocusChange?: (id: string | null) => void;
  readonly onSelectionChange?: (ids: ReadonlySet<string>) => void;
}

export interface DomListNavigationController extends Disposable {
  sync(): void;
  getSelectedIds(): ReadonlySet<string>;
  setSelectedIds(ids: Iterable<string>): void;
  selectAll(): void;
  clearSelection(): void;
  focusFirst(): void;
  isBatchMode(): boolean;
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
  const idx = computeNextIndex(
    enabled.map((it) => it.id),
    currentId,
    key,
  );
  return idx >= 0 ? enabled[idx] : undefined;
}

function computeNextIndex(ids: readonly string[], currentId: string, key: string): number {
  if (ids.length === 0) return -1;
  const idx = ids.indexOf(currentId);
  if (key === 'Home') return 0;
  if (key === 'End') return ids.length - 1;
  if (key === 'ArrowDown') return idx < 0 ? 0 : (idx + 1) % ids.length;
  if (key === 'ArrowUp') return idx < 0 ? ids.length - 1 : (idx - 1 + ids.length) % ids.length;
  return -1;
}

function computeRangeIds(
  orderedIds: readonly string[],
  anchorId: string,
  targetId: string,
  prev: ReadonlySet<string>,
): Set<string> {
  const a = orderedIds.indexOf(anchorId);
  const b = orderedIds.indexOf(targetId);
  const next = new Set(prev);
  if (a < 0 || b < 0) {
    next.add(targetId);
    return next;
  }
  const [from, to] = a <= b ? [a, b] : [b, a];
  for (let i = from; i <= to; i++) {
    const id = orderedIds[i];
    if (id !== undefined) next.add(id);
  }
  return next;
}

function computeRangeSelection<T>(
  enabled: readonly ListItem<T>[],
  anchorId: string,
  targetId: string,
  prev: ReadonlySet<string>,
): Set<string> {
  return computeRangeIds(
    enabled.map((it) => it.id),
    anchorId,
    targetId,
    prev,
  );
}

function isContextMenuKey(ev: KeyboardEvent): boolean {
  return ev.key === 'ContextMenu' || (ev.key === 'F10' && ev.shiftKey);
}

function isNavKey(key: string): boolean {
  return key === 'ArrowDown' || key === 'ArrowUp' || key === 'Home' || key === 'End';
}

function isSelectAllKey(ev: KeyboardEvent): boolean {
  return (ev.ctrlKey || ev.metaKey) && !ev.altKey && ev.key.toLowerCase() === 'a';
}

function defaultBatchLabels(): Required<ListBatchLabels> {
  const zh = getLocale() === 'zh-CN';
  return {
    selectedCount: (count) => (zh ? `已选 ${count} 项` : `${count} selected`),
    selectAll: zh ? '全选' : 'Select all',
    clearSelection: zh ? '取消' : 'Cancel',
  };
}

interface BatchBarButton {
  readonly id: string;
  readonly label: string;
  readonly title?: string;
  readonly icon?: IconInput;
  readonly variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  readonly disabled?: boolean;
  readonly onClick: () => void;
}

function renderBatchBar(
  count: number,
  total: number,
  buttons: readonly BatchBarButton[],
  labels: ListBatchLabels | undefined,
  onSelectAll: () => void,
  onClear: () => void,
): TemplateResult | typeof nothing {
  if (count === 0) return nothing;
  const defaults = defaultBatchLabels();
  const countText = labels?.selectedCount ? labels.selectedCount(count, total) : defaults.selectedCount(count, total);
  const selectAllLabel = labels?.selectAll ?? defaults.selectAll;
  const clearLabel = labels?.clearSelection ?? defaults.clearSelection;
  const allSelected = total > 0 && count >= total;
  return html`<div class="fh-list-batch" role="toolbar" aria-label=${countText}>
    <span class="fh-list-batch-count" data-batch-count=${count}>${countText}</span>
    <div class="fh-list-batch-actions">
      ${buttons.map((btn) => {
        const variant = btn.variant ?? 'secondary';
        return html`<button
          type="button"
          class=${`fh-btn fh-btn--${variant} fh-list-batch-btn`}
          data-batch-action=${btn.id}
          title=${btn.title ?? btn.label}
          ?disabled=${Boolean(btn.disabled)}
          @click=${(ev: MouseEvent) => {
            ev.stopPropagation();
            btn.onClick();
          }}
        >
          ${btn.icon ? html`<span class="fh-btn-icon">${renderIcon(btn.icon)}</span>` : nothing}
          <span>${btn.label}</span>
        </button>`;
      })}
      <button
        type="button"
        class="fh-btn fh-btn--ghost fh-list-batch-btn"
        data-batch-select-all="1"
        ?disabled=${allSelected}
        @click=${(ev: MouseEvent) => {
          ev.stopPropagation();
          onSelectAll();
        }}
      >${selectAllLabel}</button>
      <button
        type="button"
        class="fh-btn fh-btn--ghost fh-list-batch-btn"
        data-batch-clear="1"
        @click=${(ev: MouseEvent) => {
          ev.stopPropagation();
          onClear();
        }}
      >${clearLabel}</button>
    </div>
  </div>`;
}

interface ListRowContext<T> {
  readonly opts: ListOptions<T>;
  readonly selectedId: string | null;
  readonly multiSelect: boolean;
  readonly showChecks: boolean;
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
  const isSel = ctx.showChecks ? ctx.selectedIds.has(item.id) : item.id === ctx.selectedId;
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
    ${ctx.showChecks
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

function buildListBatchButtons<T>(
  batchActions: readonly ListBatchAction<T>[],
  enabled: readonly ListItem<T>[],
  selectedIds: ReadonlySet<string>,
): BatchBarButton[] {
  const selectedItems = enabled.filter((it) => selectedIds.has(it.id));
  return batchActions.map((act) => ({
    id: act.id,
    label: act.label,
    title: act.title,
    icon: act.icon,
    variant: act.variant,
    disabled: typeof act.disabled === 'function' ? act.disabled(selectedItems, selectedIds) : act.disabled,
    onClick: () => {
      void act.onAction(selectedItems, new Set(selectedIds));
    },
  }));
}

function renderListHost<T>(
  host: HTMLElement,
  groups: readonly ListGroup<T>[],
  opts: ListOptions<T>,
  rowCtx: ListRowContext<T>,
  batchActions: readonly ListBatchAction<T>[],
  supportsMulti: boolean,
  onSelectAll: () => void,
  onClear: () => void,
): void {
  const enabled = flattenEnabled(groups);
  const totalCount = groups.reduce((acc, g) => acc + g.items.length, 0);
  if (totalCount === 0 && opts.empty) {
    const tpl = isTemplateResult(opts.empty) ? opts.empty : renderEmptyState(opts.empty);
    render(html`<div class=${`fh-list fh-list--empty${opts.className ? ` ${opts.className}` : ''}`}>${tpl}</div>`, host);
    return;
  }
  const batchButtons = buildListBatchButtons(batchActions, enabled, rowCtx.selectedIds);
  const batchTpl = supportsMulti
    ? renderBatchBar(rowCtx.selectedIds.size, enabled.length, batchButtons, opts.batchLabels, onSelectAll, onClear)
    : nothing;
  render(html`${batchTpl}${renderListGroups(groups, opts, rowCtx.showChecks, rowCtx)}`, host);
}

function openListItemMenu<T>(item: ListItem<T>, opts: ListOptions<T>, ev: KeyboardEvent): void {
  if (!item.hasMenu || !opts.onItemMenu) return;
  ev.preventDefault();
  const row = ev.currentTarget as HTMLElement;
  const anchor = row.querySelector<HTMLElement>('.fh-list-menu-btn') ?? row;
  opts.onItemMenu(item, anchor, ev);
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
  let batchActions: readonly ListBatchAction<T>[] = opts.batchActions ?? [];
  let rangeAnchorId: string | null = selectedId;

  const supportsMultiSelect = (): boolean =>
    multiSelect || batchActions.length > 0 || Boolean(opts.onSelectionChange);

  const focusItemById = (id: string): void => {
    const el = host.querySelector<HTMLElement>(`[data-list-id="${escapeAttrValue(id)}"]`);
    focusSafely(el);
  };

  const clearSelection = (): void => {
    if (selectedIds.size === 0) return;
    selectedIds.clear();
    paint();
    opts.onSelectionChange?.(new Set(selectedIds));
    opts.onExitMultiSelect?.();
  };

  const selectAll = (): void => {
    if (!supportsMultiSelect()) return;
    const enabled = flattenEnabled(groups);
    selectedIds = new Set(enabled.map((it) => it.id));
    if (!rangeAnchorId && enabled[0]) rangeAnchorId = enabled[0].id;
    paint();
    opts.onSelectionChange?.(new Set(selectedIds));
  };

  const toggleMultiId = (item: ListItem<T>, shiftKey: boolean): void => {
    const enabled = flattenEnabled(groups);
    const anchor = rangeAnchorId ?? selectedId ?? enabled[0]?.id ?? null;
    if (shiftKey && anchor) {
      selectedIds = computeRangeSelection(enabled, anchor, item.id, selectedIds);
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
    if ((multiSelect || selectedIds.size > 0 || ev.ctrlKey || ev.metaKey || ev.shiftKey) && supportsMultiSelect()) {
      toggleMultiId(item, ev.shiftKey);
      return;
    }
    selectedId = item.id;
    rangeAnchorId = item.id;
    paint();
    opts.onSelect?.(item, ev);
    opts.onActivate?.(item, ev);
  };

  const handleNavKey = (item: ListItem<T>, ev: KeyboardEvent): void => {
    const enabled = flattenEnabled(groups);
    const target = computeNextItem(enabled, item.id, ev.key);
    if (!target) return;
    ev.preventDefault();
    if (ev.shiftKey && supportsMultiSelect()) {
      const anchor = rangeAnchorId ?? item.id;
      selectedIds = computeRangeSelection(enabled, anchor, target.id, selectedIds);
      rangeAnchorId = anchor;
      selectedId = target.id;
      paint();
      focusItemById(target.id);
      opts.onSelectionChange?.(new Set(selectedIds));
      return;
    }
    selectedId = target.id;
    rangeAnchorId = target.id;
    paint();
    focusItemById(target.id);
    opts.onSelect?.(target, ev);
  };

  const handleRowKeydown = (item: ListItem<T>, ev: KeyboardEvent): void => {
    if (isSelectAllKey(ev) && supportsMultiSelect()) {
      ev.preventDefault(); selectAll(); return;
    }
    if (ev.key === 'Escape' && selectedIds.size > 0) {
      ev.preventDefault(); clearSelection(); return;
    }
    if (isNavKey(ev.key)) { handleNavKey(item, ev); return; }
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault();
      if (ev.key === ' ' && supportsMultiSelect()) { toggleMultiId(item, ev.shiftKey); return; }
      selectedId = item.id;
      paint();
      opts.onSelect?.(item, ev);
      opts.onActivate?.(item, ev);
      return;
    }
    if (isContextMenuKey(ev)) openListItemMenu(item, opts, ev);
  };

  const paint = (): void => {
    const enabled = flattenEnabled(groups);
    const rowCtx: ListRowContext<T> = {
      opts,
      selectedId,
      multiSelect,
      showChecks: multiSelect || selectedIds.size > 0,
      selectedIds,
      firstEnabledId: enabled[0]?.id ?? null,
      onRowClick: handleRowClick,
      onRowKeydown: handleRowKeydown,
      onToggleMulti: toggleMultiId,
    };
    renderListHost(host, groups, opts, rowCtx, batchActions, supportsMultiSelect(), selectAll, clearSelection);
  };

  paint();

  return {
    el: host,
    setGroups(next): void { groups = next; paint(); },
    setSelected(id): void { selectedId = id; rangeAnchorId = id; paint(); },
    getSelected: () => selectedId,
    setMultiSelect(enabled): void { multiSelect = enabled; paint(); },
    setSelectedIds(ids): void { selectedIds = new Set(ids); paint(); },
    getSelectedIds: () => new Set(selectedIds),
    selectAll,
    clearSelection,
    setBatchActions(actions): void { batchActions = actions; paint(); },
    focusSelected(): void {
      const targetId = selectedId ?? flattenEnabled(groups)[0]?.id;
      if (targetId) focusItemById(targetId);
    },
    dispose(): void { render(nothing, host); host.remove(); },
  };
}

function collectDomRows(opts: DomListNavigationOptions): { readonly rows: HTMLElement[]; readonly ids: string[] } {
  const rows: HTMLElement[] = [];
  const ids: string[] = [];
  for (const el of opts.container.querySelectorAll<HTMLElement>(opts.rowSelector)) {
    const id = opts.getRowId(el);
    if (!id) continue;
    rows.push(el);
    ids.push(id);
  }
  return { rows, ids };
}

function paintDomBatchBar(
  opts: DomListNavigationOptions,
  selectedIds: ReadonlySet<string>,
  total: number,
  onSelectAll: () => void,
  onClear: () => void,
): void {
  if (!opts.batchBarHost) return;
  if (selectedIds.size === 0) {
    opts.batchBarHost.hidden = true;
    render(nothing, opts.batchBarHost);
    return;
  }
  opts.batchBarHost.hidden = false;
  const actions = opts.getBatchActions?.(new Set(selectedIds)) ?? [];
  const buttons: BatchBarButton[] = actions.map((act) => ({
    id: act.id,
    label: act.label,
    title: act.title,
    icon: act.icon,
    variant: act.variant,
    disabled: typeof act.disabled === 'function' ? act.disabled(selectedIds) : act.disabled,
    onClick: () => {
      void act.onAction(new Set(selectedIds));
    },
  }));
  render(
    renderBatchBar(selectedIds.size, total, buttons, opts.batchLabels, onSelectAll, onClear),
    opts.batchBarHost,
  );
}

function syncDomRows(
  opts: DomListNavigationOptions,
  selectedIds: Set<string>,
  onSelectAll: () => void,
  onClear: () => void,
): void {
  const { rows, ids } = collectDomRows(opts);
  const valid = new Set(ids);
  for (const id of [...selectedIds]) {
    if (!valid.has(id)) selectedIds.delete(id);
  }
  opts.container.classList.toggle('is-batch-mode', selectedIds.size > 0);
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const id = ids[i];
    if (!row || !id) continue;
    const checked = selectedIds.has(id);
    row.classList.toggle('is-batch-selected', checked);
    row.setAttribute('aria-selected', checked ? 'true' : 'false');
  }
  paintDomBatchBar(opts, selectedIds, ids.length, onSelectAll, onClear);
}

export function attachListNavigation(opts: DomListNavigationOptions): DomListNavigationController {
  const listeners = new DisposableStore();
  let selectedIds = new Set<string>();
  let focusedId: string | null = null;
  let anchorId: string | null = null;

  const isIgnored = (target: EventTarget | null): boolean =>
    Boolean(opts.ignoreSelector && target instanceof Element && target.closest(opts.ignoreSelector));

  const sync = (): void => syncDomRows(opts, selectedIds, selectAll, clearSelection);

  const notifySelection = (): void => {
    sync();
    opts.onSelectionChange?.(new Set(selectedIds));
  };

  const selectAll = (): void => {
    const { ids } = collectDomRows(opts);
    if (ids.length === 0) return;
    selectedIds = new Set(ids);
    if (!anchorId && ids[0]) anchorId = ids[0];
    notifySelection();
  };

  const clearSelection = (): void => {
    if (selectedIds.size === 0) return;
    selectedIds.clear();
    notifySelection();
  };

  const toggleId = (id: string, shiftKey: boolean): void => {
    const { ids } = collectDomRows(opts);
    const baseAnchor = anchorId ?? focusedId ?? ids[0] ?? null;
    if (shiftKey && baseAnchor) {
      selectedIds = computeRangeIds(ids, baseAnchor, id, selectedIds);
    } else if (selectedIds.has(id)) {
      selectedIds.delete(id);
    } else {
      selectedIds.add(id);
    }
    anchorId = id;
    focusedId = id;
    notifySelection();
  };

  const handleNav = (currentId: string | null, ev: KeyboardEvent): void => {
    const { rows, ids } = collectDomRows(opts);
    const nextIdx = computeNextIndex(ids, currentId ?? focusedId ?? '', ev.key);
    const nextRow = nextIdx >= 0 ? rows[nextIdx] : undefined;
    const nextId = nextIdx >= 0 ? ids[nextIdx] : undefined;
    if (!nextRow || !nextId) return;
    ev.preventDefault();
    if (ev.shiftKey) {
      const baseAnchor = anchorId ?? currentId ?? nextId;
      selectedIds = computeRangeIds(ids, baseAnchor, nextId, selectedIds);
      anchorId = baseAnchor;
      focusedId = nextId;
      notifySelection();
      focusSafely(nextRow);
      return;
    }
    focusedId = nextId;
    anchorId = nextId;
    focusSafely(nextRow);
    opts.onFocusChange?.(nextId);
  };

  listeners.add(
    addDisposableListener(opts.container, 'click', (ev) => {
      if (isIgnored(ev.target)) return;
      const row = ev.target instanceof Element ? ev.target.closest<HTMLElement>(opts.rowSelector) : null;
      const id = row ? opts.getRowId(row) : null;
      if (!row || !id) return;
      const ctrlMulti = opts.ctrlSelect !== false && (ev.ctrlKey || ev.metaKey);
      if (ev.shiftKey || ctrlMulti || selectedIds.size > 0) {
        ev.preventDefault();
        ev.stopPropagation();
        toggleId(id, ev.shiftKey);
        return;
      }
      if (ev.ctrlKey || ev.metaKey) return;
      focusedId = id;
      anchorId = id;
      opts.onActivate?.(id, row, ev);
    }),
  );

  listeners.add(
    addDisposableListener(opts.container, 'keydown', (ev) => {
      if (isIgnored(ev.target)) return;
      if (isSelectAllKey(ev)) {
        ev.preventDefault();
        selectAll();
        return;
      }
      if (ev.key === 'Escape' && selectedIds.size > 0) {
        ev.preventDefault();
        clearSelection();
        return;
      }
      const row = ev.target instanceof Element ? ev.target.closest<HTMLElement>(opts.rowSelector) : null;
      const currentId = row ? opts.getRowId(row) : null;
      if (isNavKey(ev.key)) {
        handleNav(currentId, ev);
        return;
      }
      if (!row || !currentId) return;
      if (ev.key === ' ') {
        ev.preventDefault();
        toggleId(currentId, ev.shiftKey);
      } else if (ev.key === 'Enter') {
        ev.preventDefault();
        focusedId = currentId;
        anchorId = currentId;
        opts.onActivate?.(currentId, row, ev);
      }
    }),
  );

  return {
    sync,
    getSelectedIds: () => new Set(selectedIds),
    setSelectedIds(ids): void {
      selectedIds = new Set(ids);
      sync();
    },
    selectAll,
    clearSelection,
    focusFirst(): void {
      const { rows, ids } = collectDomRows(opts);
      const targetRow = rows[focusedId ? Math.max(0, ids.indexOf(focusedId)) : 0];
      if (targetRow) focusSafely(targetRow);
    },
    isBatchMode: () => selectedIds.size > 0,
    dispose(): void {
      selectedIds.clear();
      if (opts.batchBarHost) {
        render(nothing, opts.batchBarHost);
        opts.batchBarHost.hidden = true;
      }
      listeners.dispose();
    },
  };
}
