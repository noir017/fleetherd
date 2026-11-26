import { addDisposableListener } from '../../base/dom.js';
import { DisposableStore } from '../../base/lifecycle.js';
import { t as tr } from '../../i18n/index.js';
import { text } from '../../services/api.js';
import type {
  FilterBar,
  FilterBarGroup,
  FilterBarOption,
  FilterBarOpts,
  FilterBarSortDef,
  FilterBarSortOption,
  FilterBarState,
  TopicIcons,
} from './types.js';

export interface FilterBarDeps {
  readonly icons: TopicIcons;
  readonly doc?: Document;
  readonly storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
}

function getDefaultStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

function parseSavedSelection(rawSel: unknown): Record<string, string[] | undefined> {
  const sel: Record<string, string[] | undefined> = {};
  if (!rawSel || typeof rawSel !== 'object' || Array.isArray(rawSel)) return sel;
  for (const [k, sv] of Object.entries(rawSel as Record<string, unknown>)) {
    if (!Array.isArray(sv)) continue;
    const vals = sv.filter((v): v is string => typeof v === 'string');
    if (vals.length) sel[k] = vals;
  }
  return sel;
}

function normalizeSortState(st: FilterBarState, sortDef: FilterBarSortDef | null): void {
  if (!sortDef) {
    st.sort = '';
    st.dir = '';
    return;
  }
  const offered = sortDef.options.map((o) => o.value);
  if (!offered.includes(st.sort)) {
    st.sort = sortDef.value && offered.includes(sortDef.value) ? sortDef.value : (offered[0] ?? '');
  }
  if (!st.dir) st.dir = sortDef.dir === 'desc' ? 'desc' : 'asc';
}

function loadFilterState(
  key: string,
  sortDef: FilterBarSortDef | null,
  storage: Pick<Storage, 'getItem' | 'setItem'> | null,
): FilterBarState {
  const st: FilterBarState = { q: '', sel: {}, sort: '', dir: '', open: false };
  try {
    const raw = storage ? storage.getItem(key) : null;
    const saved: unknown = raw ? JSON.parse(raw) : null;
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
      const rec = saved as Record<string, unknown>;
      if (typeof rec.q === 'string') st.q = rec.q;
      st.sel = parseSavedSelection(rec.sel);
      if (typeof rec.sort === 'string') st.sort = rec.sort;
      if (rec.dir === 'asc' || rec.dir === 'desc') st.dir = rec.dir;
      st.open = rec.open === true;
    }
  } catch {
    // Ignore corrupt or unavailable storage.
  }
  normalizeSortState(st, sortDef);
  return st;
}

function buildFilterBarHtml(opts: FilterBarOpts, icons: TopicIcons): string {
  const placeholder = opts.placeholder || tr('common.search');
  let html =
    `<div class="fb-row">` +
    `<div class="fb-search">${icons.search}` +
    `<input class="fb-q" type="text" autocomplete="off" spellcheck="false"` +
    ` placeholder="${text(placeholder)}" aria-label="${text(placeholder)}">` +
    `<button type="button" class="fb-qclear" title="${text(tr('common.clearSearch'))}" aria-label="${text(tr('common.clearSearch'))}" hidden>${icons.cross}</button>` +
    `</div>` +
    `<button type="button" class="fb-filter fb-btn" aria-expanded="false" title="${text(tr('common.filter'))}">` +
    `${icons.filter}<span>${text(tr('common.filter'))}</span><span class="fb-dot" hidden></span></button>`;
  if (opts.sort) {
    html +=
      `<span class="fb-tools"><span class="fb-sort" title="${text(tr('common.sort'))}">${icons.sort}` +
      `<select class="fb-sortsel" aria-label="${text(tr('common.sort'))}"></select></span>` +
      `<button type="button" class="fb-dir fb-btn" aria-label="${text(tr('common.ascending'))}" title="${text(tr('common.ascending'))}"></button></span>`;
  }
  html +=
    `</div>` +
    `<div class="fb-pins" hidden></div>` +
    `<div class="fb-sum" hidden><span class="fb-sumtext"></span><button type="button" class="fb-clear">${text(tr('common.clear'))}</button></div>` +
    `<div class="fb-panel" hidden></div>`;
  return html;
}

function pruneFilterSelections(st: FilterBarState, groups: readonly FilterBarGroup[]): boolean {
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
    if (kept.length) st.sel[id] = kept;
    else {
      delete st.sel[id];
      changed = true;
    }
  }
  return changed;
}

function groupsShapeSig(groups: readonly FilterBarGroup[]): string {
  const shape = groups.map((g) => [
    g.id,
    g.label,
    g.pinned ? 1 : 0,
    ...g.options.map((o) => [o.value, o.label, o.short || '', o.icon || '', typeof o.count === 'number' ? 1 : 0]),
  ]);
  return JSON.stringify(shape);
}

function renderChipHtml(group: FilterBarGroup, opt: FilterBarOption, icons: TopicIcons): string {
  const iconSvg = opt.icon && icons[opt.icon] ? icons[opt.icon] : '';
  const pinnedAria = group.pinned
    ? ` aria-label="${text(`${opt.label}${typeof opt.count === 'number' ? ` ${opt.count}` : ''}`)}"`
    : '';
  const countHtml = typeof opt.count === 'number' ? `<span class="fb-count">${opt.count}</span>` : '';
  return (
    `<button type="button" class="fb-chip${group.pinned ? ' fb-pin' : ''}"` +
    ` data-fb-group="${text(group.id)}" data-fb-value="${text(opt.value)}"` +
    ` aria-pressed="false" title="${text(opt.label)}"${pinnedAria}>` +
    `${iconSvg}<span class="fb-chip-label">${text(group.pinned ? opt.short || opt.label : opt.label)}</span>` +
    `${countHtml}</button>`
  );
}

function buildPanelMarkup(groups: readonly FilterBarGroup[], icons: TopicIcons): { pinsHtml: string; panelHtml: string } {
  let pinsHtml = '';
  let panelHtml = '';
  for (const g of groups) {
    const chips = g.options.map((o) => renderChipHtml(g, o, icons)).join('');
    if (g.pinned) {
      pinsHtml += `<div class="fb-chips fb-pin-row" role="group" aria-label="${text(g.label)}">${chips}</div>`;
    } else {
      panelHtml += `<div class="fb-group"><div class="fb-label">${text(g.label)}</div><div class="fb-chips">${chips}</div></div>`;
    }
  }
  return { pinsHtml, panelHtml };
}

function updateChipCounts(root: HTMLElement, groups: readonly FilterBarGroup[]): void {
  const chips = root.querySelectorAll<HTMLElement>('[data-fb-value]');
  for (const c of chips) {
    const id = c.getAttribute('data-fb-group');
    const v = c.getAttribute('data-fb-value');
    const group = groups.find((g) => g.id === id);
    const opt = group?.options.find((o) => o.value === v);
    if (!opt) continue;
    const n = c.querySelector('.fb-count');
    if (n && typeof opt.count === 'number') n.textContent = String(opt.count);
    if (c.hasAttribute('aria-label')) {
      c.setAttribute('aria-label', `${opt.label}${typeof opt.count === 'number' ? ` ${opt.count}` : ''}`);
    }
  }
}

function applySortOptionsHtml(
  sortSel: HTMLSelectElement,
  sortOptions: readonly FilterBarSortOption[] | Readonly<Record<string, string>>,
  currentSort: string,
): void {
  if (Array.isArray(sortOptions)) {
    sortSel.innerHTML = sortOptions
      .map((so) => `<option value="${text(so.value)}">${text(so.label)}</option>`)
      .join('');
    sortSel.value = currentSort;
    return;
  }
  const map = sortOptions as Readonly<Record<string, string>>;
  for (const opt of Array.from(sortSel.options)) {
    const label = map[opt.value];
    if (label) opt.textContent = label;
  }
  sortSel.value = currentSort;
}

interface FilterBarDom {
  readonly root: HTMLElement;
  readonly q: HTMLInputElement;
  readonly qClear: HTMLButtonElement;
  readonly fBtn: HTMLButtonElement;
  readonly dot: HTMLElement;
  readonly pins: HTMLElement;
  readonly panel: HTMLElement;
  readonly sum: HTMLElement;
  readonly sumText: HTMLElement;
  readonly clearBtn: HTMLButtonElement;
  readonly sortSel: HTMLSelectElement | null;
  readonly dirBtn: HTMLButtonElement | null;
}

function queryFilterBarDom(root: HTMLElement): FilterBarDom {
  return {
    root,
    q: root.querySelector<HTMLInputElement>('.fb-q')!,
    qClear: root.querySelector<HTMLButtonElement>('.fb-qclear')!,
    fBtn: root.querySelector<HTMLButtonElement>('.fb-filter')!,
    dot: root.querySelector<HTMLElement>('.fb-dot')!,
    pins: root.querySelector<HTMLElement>('.fb-pins')!,
    panel: root.querySelector<HTMLElement>('.fb-panel')!,
    sum: root.querySelector<HTMLElement>('.fb-sum')!,
    sumText: root.querySelector<HTMLElement>('.fb-sumtext')!,
    clearBtn: root.querySelector<HTMLButtonElement>('.fb-clear')!,
    sortSel: root.querySelector<HTMLSelectElement>('.fb-sortsel'),
    dirBtn: root.querySelector<HTMLButtonElement>('.fb-dir'),
  };
}

function asElement(target: EventTarget | null): Element | null {
  return target && typeof (target as Element).closest === 'function' ? (target as Element) : null;
}

function asNode(target: EventTarget | null): Node | null {
  return target && typeof (target as Node).nodeType === 'number' ? (target as Node) : null;
}

function bindFilterBarEvents(
  dom: FilterBarDom,
  doc: Document,
  st: FilterBarState,
  listeners: DisposableStore,
  actions: {
    emit(): void;
    clear(): void;
    save(): void;
    paintChrome(): void;
    paintDir(): void;
  },
): void {
  const { root, q, qClear, fBtn, panel, clearBtn, sortSel, dirBtn } = dom;
  listeners.add(addDisposableListener(q, 'input', () => { st.q = q.value; actions.emit(); }));
  listeners.add(addDisposableListener(qClear, 'click', () => { q.value = ''; st.q = ''; actions.emit(); q.focus(); }));
  listeners.add(
    addDisposableListener(root, 'keydown', (e) => {
      if (e.isComposing || e.key !== 'Escape') return;
      if (st.q && e.target === q) {
        q.value = '';
        st.q = '';
        actions.emit();
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (st.open) {
        st.open = false;
        actions.save();
        actions.paintChrome();
        const targetNode = asNode(e.target);
        if (targetNode && panel.contains(targetNode)) fBtn.focus();
        e.preventDefault();
        e.stopPropagation();
      } else if (asElement(e.target)?.closest('[data-fb-value]')) {
        e.stopPropagation();
      }
    }),
  );
  listeners.add(addDisposableListener(fBtn, 'click', () => { st.open = !st.open; actions.save(); actions.paintChrome(); }));
  listeners.add(addDisposableListener(clearBtn, 'click', actions.clear));
  if (sortSel) {
    listeners.add(addDisposableListener(sortSel, 'change', () => { st.sort = sortSel.value; actions.emit(); }));
  }
  if (dirBtn) {
    listeners.add(
      addDisposableListener(dirBtn, 'click', () => {
        st.dir = st.dir === 'desc' ? 'asc' : 'desc';
        actions.paintDir();
        actions.emit();
      }),
    );
  }
  listeners.add(
    addDisposableListener(root, 'click', (e) => {
      const el = asElement(e.target);
      const chip = el?.closest('[data-fb-value]');
      if (!chip) return;
      const id = chip.getAttribute('data-fb-group');
      const val = chip.getAttribute('data-fb-value');
      if (!id || !val) return;
      const arr = st.sel[id] ?? (st.sel[id] = []);
      const at = arr.indexOf(val);
      if (at >= 0) arr.splice(at, 1);
      else arr.push(val);
      if (!arr.length) delete st.sel[id];
      actions.emit();
    }),
  );
  listeners.add(
    addDisposableListener(doc, 'click', (e) => {
      if (!st.open) return;
      const path = e.composedPath ? e.composedPath() : [];
      const targetNode = asNode(e.target);
      const inside = path.includes(root) || Boolean(targetNode && root.contains(targetNode));
      if (inside) return;
      st.open = false;
      actions.save();
      actions.paintChrome();
    }),
  );
}

function refreshFilterBarI18n(
  dom: FilterBarDom,
  st: FilterBarState,
  paintDir: () => void,
  paintSummary: () => void,
  placeholder?: string,
  sortOptions?: readonly FilterBarSortOption[] | Readonly<Record<string, string>>,
): void {
  const { q, qClear, fBtn, clearBtn, sortSel } = dom;
  const ph = placeholder || tr('common.search');
  q.placeholder = ph;
  q.setAttribute('aria-label', ph);
  const cs = tr('common.clearSearch');
  qClear.title = cs;
  qClear.setAttribute('aria-label', cs);
  const fl = tr('common.filter');
  fBtn.title = fl;
  const fSpan = fBtn.querySelector('span');
  if (fSpan) fSpan.textContent = fl;
  clearBtn.textContent = tr('common.clear');
  if (sortSel) {
    const sortLabel = tr('common.sort');
    if (sortSel.parentElement) sortSel.parentElement.title = sortLabel;
    sortSel.setAttribute('aria-label', sortLabel);
    if (sortOptions) applySortOptionsHtml(sortSel, sortOptions, st.sort);
    paintDir();
  }
  paintSummary();
}

export function makeFilterBar(opts: FilterBarOpts, deps: FilterBarDeps): FilterBar {
  const doc = deps.doc ?? document;
  const storage = deps.storage !== undefined ? deps.storage : getDefaultStorage();
  const icons = deps.icons;
  const key = opts.key;
  let groups: FilterBarGroup[] = opts.groups ? [...opts.groups] : [];
  const sortDef = opts.sort || null;
  let counts: { shown: number; total: number } | null = null;
  const st = loadFilterState(key, sortDef, storage);
  const listeners = new DisposableStore();

  const root = doc.createElement('div');
  root.className = 'filterbar';
  root.innerHTML = buildFilterBarHtml(opts, icons);
  const dom = queryFilterBarDom(root);
  const { q, qClear, fBtn, dot, pins, panel, sum, sumText, sortSel, dirBtn } = dom;

  let panelSig = '';

  const hasSel = (): boolean => groups.some((g) => Boolean(st.sel[g.id]?.length));
  const panelHasSel = (): boolean => groups.some((g) => !g.pinned && Boolean(st.sel[g.id]?.length));
  const active = (): boolean => st.q.trim() !== '' || hasSel();
  const save = (): void => {
    try {
      storage?.setItem(key, JSON.stringify(st));
    } catch {
      // Ignore storage quota errors.
    }
  };

  function state(): FilterBarState {
    const sel: Record<string, string[] | undefined> = {};
    for (const g of groups) {
      const v = st.sel[g.id];
      if (v && v.length) sel[g.id] = v.slice();
    }
    return { q: st.q, sel, sort: st.sort, dir: st.dir, open: st.open };
  }

  function paintChips(): void {
    const chips = root.querySelectorAll<HTMLElement>('[data-fb-value]');
    for (const c of chips) {
      const id = c.getAttribute('data-fb-group') ?? '';
      const v = c.getAttribute('data-fb-value') ?? '';
      const on = (st.sel[id] ?? []).includes(v);
      c.classList.toggle('on', on);
      c.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }

  function paintPanel(): void {
    const sig = groupsShapeSig(groups);
    if (sig === panelSig) {
      updateChipCounts(root, groups);
      paintChips();
      return;
    }
    panelSig = sig;
    const { pinsHtml, panelHtml } = buildPanelMarkup(groups, icons);
    pins.innerHTML = pinsHtml;
    pins.hidden = !pinsHtml;
    panel.innerHTML = panelHtml;
    paintChips();
  }

  function paintSummary(): void {
    if (!active() || !counts) {
      sum.hidden = true;
      return;
    }
    sum.hidden = false;
    sumText.textContent = tr('common.showingOf', { shown: counts.shown, total: counts.total });
  }

  function paintChrome(): void {
    qClear.hidden = !st.q;
    const panelActive = panelHasSel();
    dot.hidden = !panelActive;
    fBtn.classList.toggle('on', panelActive);
    fBtn.setAttribute('aria-expanded', st.open ? 'true' : 'false');
    panel.hidden = !st.open;
    if (st.q && q.value !== st.q) q.value = st.q;
    paintSummary();
  }

  function paintDir(): void {
    if (!dirBtn) return;
    const up = st.dir !== 'desc';
    dirBtn.innerHTML = up ? icons.arrowUp : icons.arrowDown;
    dirBtn.title = up ? tr('common.ascending') : tr('common.descending');
    dirBtn.setAttribute('aria-label', dirBtn.title);
  }

  function emit(): void {
    save();
    paintChrome();
    paintChips();
    opts.onChange?.(state());
  }

  function clear(): void {
    st.q = '';
    st.sel = {};
    q.value = '';
    emit();
  }

  bindFilterBarEvents(dom, doc, st, listeners, { emit, clear, save, paintChrome, paintDir });

  function setGroups(next: FilterBarGroup[] | null): void {
    if (next == null) return;
    groups = next;
    if (pruneFilterSelections(st, groups)) save();
    paintPanel();
    paintChrome();
  }

  function setCounts(shown: number, total: number): void {
    counts = { shown: Math.max(0, shown | 0), total: Math.max(0, total | 0) };
    paintSummary();
  }

  function destroy(): void {
    listeners.dispose();
    if (root.parentNode) root.parentNode.removeChild(root);
  }

  function refreshI18n(
    placeholder?: string,
    sortOptions?: readonly FilterBarSortOption[] | Readonly<Record<string, string>>,
  ): void {
    refreshFilterBarI18n(dom, st, paintDir, paintSummary, placeholder, sortOptions);
  }

  paintPanel();
  paintChrome();
  if (sortDef && sortSel) {
    applySortOptionsHtml(sortSel, sortDef.options, st.sort);
    paintDir();
  }

  return { el: root, state, active, setGroups, setCounts, clear, destroy, refreshI18n };
}
