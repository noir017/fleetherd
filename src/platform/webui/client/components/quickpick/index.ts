import { addDisposableListener, focusSafely } from '../../base/dom.js';
import { html, nothing, render, type TemplateResult } from '../../base/html.js';
import { type Disposable, DisposableStore } from '../../base/lifecycle.js';
import { t as tr } from '../../i18n/index.js';
import type { OverlayManager } from '../../services/overlays.js';
import { type IconInput, renderIcon } from '../shared.js';

export interface QuickPickItem<T = unknown> {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly detail?: string;
  readonly group?: string;
  readonly keywords?: readonly string[];
  readonly icon?: IconInput;
  readonly shortcut?: string;
  readonly disabled?: boolean;
  readonly data?: T;
}

export interface FuzzyMatch {
  readonly score: number;
  readonly indices: readonly number[];
}

export interface QuickPickOptions<T = unknown> {
  readonly items: readonly QuickPickItem<T>[];
  readonly placeholder?: string;
  readonly initialQuery?: string;
  readonly emptyText?: string;
  readonly searchIcon?: IconInput;
  readonly overlays?: OverlayManager;
  readonly container?: HTMLElement;
  readonly doc?: Document;
  readonly className?: string;
  readonly onSelect?: (item: QuickPickItem<T>) => void;
  readonly onCancel?: () => void;
}

export interface QuickPickController<T = unknown> extends Disposable {
  readonly el: HTMLElement;
  readonly promise: Promise<QuickPickItem<T> | undefined>;
  isOpen(): boolean;
  setItems(items: readonly QuickPickItem<T>[]): void;
  setQuery(query: string): void;
  close(): void;
}

const WORD_BOUNDARY_RE = /[\s/_.:-]/;

export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  const q = query.trim().toLowerCase();
  if (!q) return { score: 0, indices: [] };
  const hay = text.toLowerCase();
  const indices: number[] = [];
  let qi = 0;
  let score = 0;
  let consecutive = 0;

  for (let ti = 0; ti < hay.length && qi < q.length; ti++) {
    if (hay[ti] === q[qi]) {
      indices.push(ti);
      consecutive += 1;
      score += 10 + consecutive * 5;
      if (ti === 0 || WORD_BOUNDARY_RE.test(hay[ti - 1] ?? '')) {
        score += 12;
      }
      qi += 1;
    } else {
      consecutive = 0;
    }
  }
  if (qi < q.length) return null;
  if (hay.includes(q)) score += 25;
  score -= hay.length * 0.1;
  return { score, indices };
}

function renderHighlighted(text: string, indices: readonly number[]): TemplateResult | string {
  if (indices.length === 0) return text;
  const set = new Set(indices);
  const parts: Array<string | TemplateResult> = [];
  let buf = '';
  let inMark = false;
  for (let i = 0; i < text.length; i++) {
    const hit = set.has(i);
    if (hit !== inMark) {
      if (buf) parts.push(inMark ? html`<mark class="fh-qp-mark">${buf}</mark>` : buf);
      buf = '';
      inMark = hit;
    }
    buf += text[i] ?? '';
  }
  if (buf) parts.push(inMark ? html`<mark class="fh-qp-mark">${buf}</mark>` : buf);
  return html`${parts}`;
}

interface MatchedItem<T> {
  readonly item: QuickPickItem<T>;
  readonly labelIndices: readonly number[];
  readonly score: number;
  readonly order: number;
}

function filterItems<T>(items: readonly QuickPickItem<T>[], query: string): MatchedItem<T>[] {
  const q = query.trim();
  if (!q) {
    return items.map((item, order) => ({ item, labelIndices: [], score: 0, order }));
  }
  const matched: MatchedItem<T>[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item) continue;
    const labelHit = fuzzyMatch(q, item.label);
    if (labelHit) {
      matched.push({ item, labelIndices: labelHit.indices, score: labelHit.score + 20, order: i });
      continue;
    }
    const extra = [item.description, item.detail, item.group, ...(item.keywords ?? [])]
      .filter((s): s is string => Boolean(s))
      .join(' ');
    const extraHit = extra ? fuzzyMatch(q, extra) : null;
    if (extraHit) {
      matched.push({ item, labelIndices: [], score: extraHit.score, order: i });
    }
  }
  matched.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.order - b.order));
  return matched;
}

function findNextEnabled<T>(list: readonly MatchedItem<T>[], fromIdx: number, step: 1 | -1): number {
  const len = list.length;
  if (len === 0) return -1;
  for (let offset = 1; offset <= len; offset++) {
    const idx = (fromIdx + step * offset + len) % len;
    if (!list[idx]?.item.disabled) return idx;
  }
  return -1;
}

function findEdgeEnabled<T>(list: readonly MatchedItem<T>[], fromEnd: boolean): number {
  if (fromEnd) {
    for (let i = list.length - 1; i >= 0; i--) {
      if (!list[i]?.item.disabled) return i;
    }
    return -1;
  }
  for (let i = 0; i < list.length; i++) {
    if (!list[i]?.item.disabled) return i;
  }
  return -1;
}

interface QuickPickViewModel<T> {
  readonly opts: QuickPickOptions<T>;
  readonly query: string;
  readonly filtered: readonly MatchedItem<T>[];
  readonly activeIdx: number;
  readonly onInput: (val: string) => void;
  readonly onKeydown: (ev: KeyboardEvent) => void;
  readonly onHover: (idx: number) => void;
  readonly onPick: (item: QuickPickItem<T>) => void;
}

function renderQuickPickTemplate<T>(vm: QuickPickViewModel<T>): TemplateResult {
  const ph = vm.opts.placeholder ?? tr('common.search');
  const emptyText = vm.opts.emptyText ?? 'No matching results';
  const activeId = vm.activeIdx >= 0 ? `fh-qp-opt-${vm.activeIdx}` : undefined;
  let lastGroup: string | undefined;

  return html`<div class="fh-qp" role="dialog" aria-modal="true" aria-label=${ph}>
    <div class="fh-qp-input-wrap">
      ${renderIcon(vm.opts.searchIcon, 'fh-qp-search-icon')}
      <input
        type="text"
        class="fh-qp-input"
        role="combobox"
        aria-expanded="true"
        aria-autocomplete="list"
        aria-controls="fh-qp-list"
        aria-activedescendant=${activeId ?? nothing}
        autocomplete="off"
        spellcheck="false"
        .value=${vm.query}
        placeholder=${ph}
        aria-label=${ph}
        @input=${(ev: Event) => vm.onInput((ev.currentTarget as HTMLInputElement).value)}
        @keydown=${vm.onKeydown}
      />
    </div>
    <div class="fh-qp-list" id="fh-qp-list" role="listbox">
      ${vm.filtered.length === 0
        ? html`<div class="fh-qp-empty">${emptyText}</div>`
        : vm.filtered.map((entry, idx) => {
            const showGroup = Boolean(entry.item.group && entry.item.group !== lastGroup);
            if (entry.item.group) lastGroup = entry.item.group;
            const isActive = idx === vm.activeIdx;
            const rowCls =
              `fh-qp-row${isActive ? ' is-selected' : ''}` +
              `${entry.item.disabled ? ' is-disabled' : ''}`;
            return html`
              ${showGroup ? html`<div class="fh-qp-group">${entry.item.group}</div>` : nothing}
              <div
                id=${`fh-qp-opt-${idx}`}
                class=${rowCls}
                role="option"
                data-qp-id=${entry.item.id}
                aria-selected=${isActive ? 'true' : 'false'}
                aria-disabled=${entry.item.disabled ? 'true' : nothing}
                @mouseenter=${() => { if (!entry.item.disabled) vm.onHover(idx); }}
                @click=${() => { if (!entry.item.disabled) vm.onPick(entry.item); }}
              >
                ${renderIcon(entry.item.icon, 'fh-qp-icon')}
                <span class="fh-qp-main">
                  <span class="fh-qp-label">${renderHighlighted(entry.item.label, entry.labelIndices)}</span>
                  ${entry.item.description ? html`<span class="fh-qp-desc">${entry.item.description}</span>` : nothing}
                  ${entry.item.detail ? html`<span class="fh-qp-detail">${entry.item.detail}</span>` : nothing}
                </span>
                ${entry.item.shortcut ? html`<kbd class="fh-qp-kbd">${entry.item.shortcut}</kbd>` : nothing}
              </div>
            `;
          })}
    </div>
  </div>`;
}

export function openQuickPick<T = unknown>(
  opts: QuickPickOptions<T>,
): QuickPickController<T> {
  const doc = opts.doc ?? document;
  const listeners = new DisposableStore();
  const prevFocus = doc.activeElement instanceof HTMLElement ? doc.activeElement : null;

  let resolvePromise: (val: QuickPickItem<T> | undefined) => void = () => {};
  const promise = new Promise<QuickPickItem<T> | undefined>((resolve) => {
    resolvePromise = resolve;
  });

  const backdrop = doc.createElement('div');
  backdrop.className = `fh-qp-backdrop${opts.className ? ` ${opts.className}` : ''}`;
  (opts.container ?? doc.body).appendChild(backdrop);

  let closed = false;
  let items: readonly QuickPickItem<T>[] = opts.items;
  let query = opts.initialQuery ?? '';
  let filtered: MatchedItem<T>[] = filterItems(items, query);
  let activeIdx = findEdgeEnabled(filtered, false);

  const finish = (selected: QuickPickItem<T> | undefined): void => {
    if (closed) return;
    closed = true;
    listeners.dispose();
    render(nothing, backdrop);
    backdrop.remove();
    if (selected) opts.onSelect?.(selected);
    else opts.onCancel?.();
    resolvePromise(selected);
    if (!opts.overlays) focusSafely(prevFocus);
  };

  const recompute = (): void => {
    filtered = filterItems(items, query);
    activeIdx = findEdgeEnabled(filtered, false);
    paint();
  };

  const handleInputKeydown = (ev: KeyboardEvent): void => {
    if (ev.isComposing) return;
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      activeIdx = findNextEnabled(filtered, activeIdx < 0 ? -1 : activeIdx, 1);
      paint();
      return;
    }
    if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      activeIdx = findNextEnabled(filtered, activeIdx < 0 ? 0 : activeIdx, -1);
      paint();
      return;
    }
    if (ev.key === 'Home') {
      ev.preventDefault();
      activeIdx = findEdgeEnabled(filtered, false);
      paint();
      return;
    }
    if (ev.key === 'End') {
      ev.preventDefault();
      activeIdx = findEdgeEnabled(filtered, true);
      paint();
      return;
    }
    if (ev.key === 'Enter') {
      ev.preventDefault();
      const chosen = activeIdx >= 0 ? filtered[activeIdx]?.item : undefined;
      if (chosen && !chosen.disabled) finish(chosen);
      return;
    }
    if (ev.key === 'Escape' && !opts.overlays) {
      ev.preventDefault();
      ev.stopPropagation();
      finish(undefined);
    }
  };

  const paint = (): void => {
    if (closed) return;
    render(
      renderQuickPickTemplate({
        opts,
        query,
        filtered,
        activeIdx,
        onInput: (val) => { query = val; recompute(); },
        onKeydown: handleInputKeydown,
        onHover: (idx) => { if (activeIdx !== idx) { activeIdx = idx; paint(); } },
        onPick: (item) => finish(item),
      }),
      backdrop,
    );
  };

  paint();

  listeners.add(
    addDisposableListener(backdrop, 'click', (ev: MouseEvent) => {
      if (ev.target === backdrop) finish(undefined);
    }),
  );

  if (opts.overlays) {
    listeners.add(
      opts.overlays.push({
        id: 'fh-quickpick',
        close: () => {
          finish(undefined);
        },
        restoreFocus: prevFocus,
      }),
    );
  }

  focusSafely(backdrop.querySelector<HTMLElement>('.fh-qp-input'));

  return {
    el: backdrop,
    promise,
    isOpen: () => !closed,
    setItems(next): void {
      items = next;
      recompute();
    },
    setQuery(next): void {
      query = next;
      recompute();
    },
    close(): void {
      finish(undefined);
    },
    dispose(): void {
      finish(undefined);
    },
  };
}
