import { icon } from '../../../icons.js';
import { addDisposableListener, focusSafely } from '../../base/dom.js';
import { html, nothing, render, type TemplateResult } from '../../base/html.js';
import { type Disposable, DisposableStore } from '../../base/lifecycle.js';
import { t as tr } from '../../i18n/index.js';
import type { OverlayManager } from '../../services/overlays.js';
import type { StorageService } from '../../services/storage.js';
import { createMenu, type MenuController, type MenuEntry } from '../menu/index.js';
import { asNode, type IconInput, renderIcon } from '../shared.js';

export type FilterBarSortDir = 'asc' | 'desc' | '';

export interface FilterBarOption {
  readonly value: string;
  readonly label: string;
  readonly short?: string;
  readonly icon?: IconInput;
  readonly count?: number;
}

export interface FilterBarGroup {
  readonly id: string;
  readonly label: string;
  readonly pinned?: boolean;
  readonly options: readonly FilterBarOption[];
}

export interface FilterBarSortOption {
  readonly value: string;
  readonly label: string;
}

export interface FilterBarSortDef {
  readonly options: readonly FilterBarSortOption[];
  readonly value?: string;
  readonly dir?: 'asc' | 'desc';
}

export interface FilterBarState {
  q: string;
  sel: Record<string, string[] | undefined>;
  sort: string;
  dir: FilterBarSortDir;
  open: boolean;
}

export interface FilterBarIcons {
  readonly search?: IconInput;
  readonly cross?: IconInput;
  readonly filter?: IconInput;
  readonly sort?: IconInput;
  readonly arrowUp?: IconInput;
  readonly arrowDown?: IconInput;
}

export interface FilterBarStorageAdapter {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface FilterBarOptions {
  readonly key: string;
  readonly placeholder?: string;
  readonly groups?: readonly FilterBarGroup[];
  readonly sort?: FilterBarSortDef | null;
  readonly icons?: FilterBarIcons;
  readonly overlays?: OverlayManager;
  readonly storage?: StorageService | FilterBarStorageAdapter | null;
  readonly onChange?: (state: FilterBarState) => void;
  readonly onPersist?: (state: FilterBarState) => void;
  readonly className?: string;
}

export interface FilterBarController extends Disposable {
  readonly el: HTMLElement;
  state(): FilterBarState;
  active(): boolean;
  setGroups(groups: readonly FilterBarGroup[] | null): void;
  setCounts(shown: number, total: number): void;
  clear(): void;
  refreshI18n(
    placeholder?: string,
    sortOptions?: readonly FilterBarSortOption[] | Readonly<Record<string, string>>,
  ): void;
}

function isStorageService(s: StorageService | FilterBarStorageAdapter): s is StorageService {
  return typeof (s as StorageService).getRaw === 'function';
}

function readPersistedRaw(
  storage: StorageService | FilterBarStorageAdapter | null | undefined,
  key: string,
): string | null {
  try {
    if (storage === null) return null;
    if (storage) {
      return isStorageService(storage) ? storage.getRaw(key) : storage.getItem(key);
    }
    return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
  } catch {
    return null;
  }
}

function writePersistedRaw(
  storage: StorageService | FilterBarStorageAdapter | null | undefined,
  key: string,
  value: string,
): void {
  try {
    if (storage === null) return;
    if (storage) {
      if (isStorageService(storage)) storage.setRaw(key, value);
      else storage.setItem(key, value);
      return;
    }
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, value);
  } catch {
    // Ignore storage quota or security errors.
  }
}

function parseSavedSel(raw: unknown): Record<string, string[] | undefined> {
  const out: Record<string, string[] | undefined> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(v)) continue;
    const strs = v.filter((x): x is string => typeof x === 'string');
    if (strs.length > 0) out[k] = strs;
  }
  return out;
}

function loadState(
  key: string,
  sortDef: FilterBarSortDef | null,
  storage: StorageService | FilterBarStorageAdapter | null | undefined,
): FilterBarState {
  const st: FilterBarState = { q: '', sel: {}, sort: '', dir: '', open: false };
  try {
    const raw = readPersistedRaw(storage, key);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const rec = parsed as Record<string, unknown>;
      if (typeof rec.q === 'string') st.q = rec.q;
      st.sel = parseSavedSel(rec.sel);
      if (typeof rec.sort === 'string') st.sort = rec.sort;
      if (rec.dir === 'asc' || rec.dir === 'desc') st.dir = rec.dir;
      st.open = rec.open === true;
    }
  } catch {
    // Ignore malformed JSON.
  }
  if (sortDef) {
    const offered = sortDef.options.map((o) => o.value);
    if (!offered.includes(st.sort)) {
      st.sort = sortDef.value && offered.includes(sortDef.value) ? sortDef.value : (offered[0] ?? '');
    }
    if (!st.dir) st.dir = sortDef.dir === 'desc' ? 'desc' : 'asc';
  }
  return st;
}

function pruneSelections(st: FilterBarState, groups: readonly FilterBarGroup[]): boolean {
  let changed = false;
  for (const id of Object.keys(st.sel)) {
    const group = groups.find((g) => g.id === id);
    if (!group) {
      delete st.sel[id];
      changed = true;
      continue;
    }
    const vals = st.sel[id] ?? [];
    const kept = vals.filter((v) => group.options.some((o) => o.value === v));
    if (kept.length !== vals.length) changed = true;
    if (kept.length > 0) st.sel[id] = kept;
    else {
      delete st.sel[id];
      changed = true;
    }
  }
  return changed;
}

function renderChip(
  group: FilterBarGroup,
  opt: FilterBarOption,
  selected: boolean,
  onToggle: (groupId: string, value: string) => void,
): TemplateResult {
  const cls = `fh-fb-chip${group.pinned ? ' is-pinned' : ''}${selected ? ' is-active' : ''}`;
  const ariaLabel = group.pinned
    ? `${opt.label}${typeof opt.count === 'number' ? ` ${opt.count}` : ''}`
    : undefined;
  return html`<button
    type="button"
    class=${cls}
    data-fb-group=${group.id}
    data-fb-value=${opt.value}
    aria-pressed=${selected ? 'true' : 'false'}
    title=${opt.label}
    aria-label=${ariaLabel ?? nothing}
    @click=${() => onToggle(group.id, opt.value)}
  >
    ${renderIcon(opt.icon, 'fh-fb-chip-icon')}
    <span class="fh-fb-chip-label">${group.pinned ? (opt.short || opt.label) : opt.label}</span>
    ${typeof opt.count === 'number' ? html`<span class="fh-fb-count">${opt.count}</span>` : nothing}
  </button>`;
}

interface FilterBarViewModel {
  readonly st: FilterBarState;
  readonly placeholder: string;
  readonly icons: FilterBarIcons;
  readonly pinnedGroups: readonly FilterBarGroup[];
  readonly panelGroups: readonly FilterBarGroup[];
  readonly panelActive: boolean;
  readonly sortDef: FilterBarSortDef | null;
  readonly sortOptions: readonly FilterBarSortOption[];
  readonly sortMenuOpen: boolean;
  readonly counts: { shown: number; total: number } | null;
  readonly showSummary: boolean;
  readonly onQueryInput: (val: string) => void;
  readonly onQueryClear: () => void;
  readonly onTogglePanel: () => void;
  readonly onToggleSort: (anchor: HTMLElement) => void;
  readonly onToggleChip: (groupId: string, value: string) => void;
  readonly onClearAll: () => void;
}

function formatSortButtonTitle(
  st: FilterBarState,
  sortOptions: readonly FilterBarSortOption[],
): string {
  const current = sortOptions.find((o) => o.value === st.sort)?.label;
  const dirLabel = st.dir === 'desc' ? tr('common.descending') : tr('common.ascending');
  return current ? `${tr('common.sort')}: ${current} (${dirLabel})` : `${tr('common.sort')} (${dirLabel})`;
}

function buildSortMenuEntries(
  st: FilterBarState,
  sortOptions: readonly FilterBarSortOption[],
  onPickSort: (value: string) => void,
  onPickDir: (dir: 'asc' | 'desc') => void,
): MenuEntry[] {
  const entries: MenuEntry[] = sortOptions.map((so) => ({
    id: `sort:${so.value}`,
    label: so.label,
    checked: so.value === st.sort,
    onSelect: () => onPickSort(so.value),
  }));
  entries.push(
    { kind: 'separator' },
    {
      id: 'dir:asc',
      label: tr('common.ascending'),
      checked: st.dir !== 'desc',
      onSelect: () => onPickDir('asc'),
    },
    {
      id: 'dir:desc',
      label: tr('common.descending'),
      checked: st.dir === 'desc',
      onSelect: () => onPickDir('desc'),
    },
  );
  return entries;
}

function renderFilterBarSort(vm: FilterBarViewModel): TemplateResult | typeof nothing {
  if (!vm.sortDef) return nothing;
  const sortTitle = formatSortButtonTitle(vm.st, vm.sortOptions);
  const sortIcon = vm.icons.sort ? renderIcon(vm.icons.sort, 'fh-icon') : renderIcon(icon('sort'), 'fh-icon');
  return html`<button
    type="button"
    class="fh-fb-sort-btn fh-btn fh-btn--secondary fh-btn--icon"
    aria-haspopup="menu"
    aria-expanded=${vm.sortMenuOpen ? 'true' : 'false'}
    title=${sortTitle}
    aria-label=${sortTitle}
    @click=${(ev: MouseEvent) => vm.onToggleSort(ev.currentTarget as HTMLElement)}
  >${sortIcon}</button>`;
}

function renderFilterBarTemplate(vm: FilterBarViewModel): TemplateResult {
  return html`<div class="fh-fb-row">
    <div class="fh-fb-search">
      ${renderIcon(vm.icons.search, 'fh-fb-search-icon')}
      <input
        class="fh-fb-q"
        type="text"
        autocomplete="off"
        spellcheck="false"
        .value=${vm.st.q}
        placeholder=${vm.placeholder}
        aria-label=${vm.placeholder}
        @input=${(ev: Event) => vm.onQueryInput((ev.currentTarget as HTMLInputElement).value)}
      />
      <button
        type="button"
        class="fh-fb-qclear"
        title=${tr('common.clearSearch')}
        aria-label=${tr('common.clearSearch')}
        ?hidden=${!vm.st.q}
        @click=${vm.onQueryClear}
      >${vm.icons.cross ? renderIcon(vm.icons.cross, 'fh-icon') : html`<span aria-hidden="true">×</span>`}</button>
    </div>
    ${vm.panelGroups.length > 0
      ? html`<button
          type="button"
          class=${`fh-fb-filter fh-btn fh-btn--secondary${vm.panelActive ? ' is-active' : ''}`}
          aria-expanded=${vm.st.open ? 'true' : 'false'}
          title=${tr('common.filter')}
          @click=${vm.onTogglePanel}
        >
          ${renderIcon(vm.icons.filter, 'fh-icon')}
          <span>${tr('common.filter')}</span>
          <span class="fh-fb-dot" ?hidden=${!vm.panelActive}></span>
        </button>`
      : nothing}
    ${renderFilterBarSort(vm)}
  </div>
  <div class="fh-fb-pins" ?hidden=${vm.pinnedGroups.length === 0}>
    ${vm.pinnedGroups.map(
      (g) => html`<div class="fh-fb-chips" role="group" aria-label=${g.label}>
        ${g.options.map((o) => renderChip(g, o, (vm.st.sel[g.id] ?? []).includes(o.value), vm.onToggleChip))}
      </div>`,
    )}
  </div>
  <div class="fh-fb-sum" ?hidden=${!vm.showSummary}>
    <span class="fh-fb-sumtext">${vm.counts ? tr('common.showingOf', { shown: vm.counts.shown, total: vm.counts.total }) : ''}</span>
    <button type="button" class="fh-fb-clear" @click=${vm.onClearAll}>${tr('common.clear')}</button>
  </div>
  <div class="fh-fb-panel" ?hidden=${!vm.st.open || vm.panelGroups.length === 0}>
    ${vm.panelGroups.map(
      (g) => html`<div class="fh-fb-group">
        <div class="fh-fb-label">${g.label}</div>
        <div class="fh-fb-chips">
          ${g.options.map((o) => renderChip(g, o, (vm.st.sel[g.id] ?? []).includes(o.value), vm.onToggleChip))}
        </div>
      </div>`,
    )}
  </div>`;
}

function applySortOptionsUpdate(
  current: readonly FilterBarSortOption[],
  next: readonly FilterBarSortOption[] | Readonly<Record<string, string>>,
): readonly FilterBarSortOption[] {
  if (Array.isArray(next)) return [...next];
  const map = next as Readonly<Record<string, string>>;
  return current.map((o) => ({ value: o.value, label: map[o.value] ?? o.label }));
}

function snapshotFilterState(st: FilterBarState, groups: readonly FilterBarGroup[]): FilterBarState {
  const sel: Record<string, string[] | undefined> = {};
  for (const g of groups) {
    const vals = st.sel[g.id];
    if (vals && vals.length > 0) sel[g.id] = vals.slice();
  }
  return { q: st.q, sel, sort: st.sort, dir: st.dir, open: st.open };
}

function toggleFilterSelection(st: FilterBarState, groupId: string, value: string): void {
  const arr = st.sel[groupId] ?? (st.sel[groupId] = []);
  const idx = arr.indexOf(value);
  if (idx >= 0) arr.splice(idx, 1);
  else arr.push(value);
  if (arr.length === 0) delete st.sel[groupId];
}

function handleFilterBarKeydown(
  ev: KeyboardEvent,
  root: HTMLElement,
  st: FilterBarState,
  onClearQuery: () => void,
  onClosePanel: () => void,
): void {
  if (ev.isComposing || ev.key !== 'Escape') return;
  const input = root.querySelector<HTMLInputElement>('.fh-fb-q');
  if (st.q && ev.target === input) {
    onClearQuery();
    ev.preventDefault();
    ev.stopPropagation();
    return;
  }
  if (!st.open) return;
  onClosePanel();
  const targetNode = asNode(ev.target);
  const panel = root.querySelector('.fh-fb-panel');
  if (targetNode && panel?.contains(targetNode)) {
    focusSafely(root.querySelector<HTMLElement>('.fh-fb-filter'));
  }
  ev.preventDefault();
  ev.stopPropagation();
}

function handleFilterBarOutsideClick(
  ev: MouseEvent,
  root: HTMLElement,
  st: FilterBarState,
  onClosePanel: () => void,
): void {
  if (!st.open) return;
  const path = ev.composedPath ? ev.composedPath() : [];
  const targetNode = asNode(ev.target);
  if (path.includes(root) || (targetNode && root.contains(targetNode))) return;
  onClosePanel();
}

function createSortMenu(
  opts: FilterBarOptions,
  doc: Document,
  onClose: () => void,
): MenuController | null {
  if (!opts.sort) return null;
  return createMenu({
    overlays: opts.overlays,
    doc,
    win: doc.defaultView ?? window,
    align: 'end',
    className: 'fh-fb-sort-menu',
    onClose,
  });
}

export function createFilterBar(
  opts: FilterBarOptions,
  doc: Document = document,
): FilterBarController {
  const root = doc.createElement('div');
  root.className = `fh-filterbar${opts.className ? ` ${opts.className}` : ''}`;

  const icons = opts.icons ?? {};
  const listeners = new DisposableStore();
  let placeholder = opts.placeholder;
  let groups: readonly FilterBarGroup[] = opts.groups ? [...opts.groups] : [];
  let sortOptions: readonly FilterBarSortOption[] = opts.sort ? [...opts.sort.options] : [];
  const sortDef = opts.sort ?? null;
  let counts: { shown: number; total: number } | null = null;
  let disposed = false;
  const st = loadState(opts.key, sortDef, opts.storage);

  const snapshot = (): FilterBarState => snapshotFilterState(st, groups);
  const hasSel = (): boolean => groups.some((g) => Boolean(st.sel[g.id]?.length));
  const panelHasSel = (): boolean => groups.some((g) => !g.pinned && Boolean(st.sel[g.id]?.length));
  const isActive = (): boolean => st.q.trim() !== '' || hasSel();

  const persist = (): void => {
    writePersistedRaw(opts.storage, opts.key, JSON.stringify(st));
    opts.onPersist?.(snapshot());
  };

  const emit = (): void => {
    persist();
    paint();
    opts.onChange?.(snapshot());
  };

  const closePanel = (): void => {
    st.open = false;
    persist();
    paint();
  };

  const sortMenu = createSortMenu(opts, doc, () => { if (!disposed) paint(); });
  if (sortMenu) listeners.add(sortMenu);

  const togglePanel = (): void => {
    if (sortMenu?.isOpen()) sortMenu.close(false);
    st.open = !st.open;
    persist();
    paint();
  };

  const toggleSort = (anchor: HTMLElement): void => {
    if (!sortMenu) return;
    if (sortMenu.isOpen()) {
      sortMenu.close(true);
      return;
    }
    if (st.open) {
      st.open = false;
      persist();
    }
    sortMenu.open(
      anchor,
      buildSortMenuEntries(
        st,
        sortOptions,
        (val) => { st.sort = val; emit(); },
        (dir) => { st.dir = dir; emit(); },
      ),
    );
    paint();
  };

  const toggleChip = (groupId: string, value: string): void => {
    toggleFilterSelection(st, groupId, value);
    emit();
  };

  const clear = (): void => {
    st.q = '';
    st.sel = {};
    emit();
  };

  listeners.add(
    addDisposableListener(root, 'keydown', (ev: KeyboardEvent) =>
      handleFilterBarKeydown(ev, root, st, () => { st.q = ''; emit(); }, closePanel),
    ),
  );
  listeners.add(
    addDisposableListener(doc, 'click', (ev: MouseEvent) => handleFilterBarOutsideClick(ev, root, st, closePanel)),
  );

  const paint = (): void => {
    render(
      renderFilterBarTemplate({
        st,
        placeholder: placeholder || tr('common.search'),
        icons,
        pinnedGroups: groups.filter((g) => g.pinned),
        panelGroups: groups.filter((g) => !g.pinned),
        panelActive: panelHasSel(),
        sortDef,
        sortOptions,
        sortMenuOpen: sortMenu?.isOpen() ?? false,
        counts,
        showSummary: isActive() && counts !== null,
        onQueryInput: (val) => { st.q = val; emit(); },
        onQueryClear: () => { st.q = ''; emit(); focusSafely(root.querySelector<HTMLElement>('.fh-fb-q')); },
        onTogglePanel: togglePanel,
        onToggleSort: toggleSort,
        onToggleChip: toggleChip,
        onClearAll: clear,
      }),
      root,
    );
  };

  paint();

  return {
    el: root,
    state: snapshot,
    active: isActive,
    setGroups(next): void {
      if (next == null) return;
      groups = [...next];
      if (pruneSelections(st, groups)) persist();
      paint();
    },
    setCounts(shown, total): void {
      counts = { shown: Math.max(0, shown | 0), total: Math.max(0, total | 0) };
      paint();
    },
    clear,
    refreshI18n(nextPlaceholder, nextSortOptions): void {
      if (nextPlaceholder !== undefined) placeholder = nextPlaceholder;
      if (nextSortOptions) sortOptions = applySortOptionsUpdate(sortOptions, nextSortOptions);
      paint();
    },
    dispose(): void {
      disposed = true;
      listeners.dispose();
      render(nothing, root);
      root.remove();
    },
  };
}
