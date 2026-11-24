import { addDisposableListener } from '../../base/dom.js';
import { Emitter, type Event } from '../../base/event.js';
import { type Disposable, DisposableStore } from '../../base/lifecycle.js';
import type { StorageService } from '../../services/storage.js';

export type SplitOrientation = 'horizontal' | 'vertical';
export type SplitPriority = 'low' | 'normal' | 'high';

export interface SplitPaneSpec {
  readonly minSize: number;
  readonly maxSize?: number;
  readonly size?: number;
  readonly defaultSize?: number;
  readonly visible?: boolean;
  readonly fixed?: boolean;
  readonly priority?: SplitPriority;
}

export interface SplitPaneInput extends SplitPaneSpec {
  readonly id: string;
  readonly element: HTMLElement;
}

export interface SplitViewOptions {
  readonly container: HTMLElement;
  readonly orientation: SplitOrientation;
  readonly panes: readonly SplitPaneInput[];
  readonly storage?: StorageService;
  readonly storageKey?: string;
}

const PRIORITY_RANK: Record<SplitPriority, number> = {
  low: 0,
  normal: 1,
  high: 2,
};

export function clampSize(size: number, minSize: number, maxSize?: number): number {
  const safeMin = Math.max(0, Number.isFinite(minSize) ? minSize : 0);
  const safeMax =
    maxSize !== undefined && Number.isFinite(maxSize) ? Math.max(safeMin, maxSize) : Number.POSITIVE_INFINITY;
  const safeSize = Number.isFinite(size) ? size : safeMin;
  return Math.min(safeMax, Math.max(safeMin, safeSize));
}

function effectiveMin(pane: SplitPaneSpec): number {
  if (pane.visible === false) return 0;
  return Math.max(0, Number.isFinite(pane.minSize) ? pane.minSize : 0);
}

function effectiveMax(pane: SplitPaneSpec): number {
  if (pane.visible === false) return 0;
  const min = effectiveMin(pane);
  if (pane.fixed) return clampSize(pane.size ?? pane.defaultSize ?? min, min, pane.maxSize);
  if (pane.maxSize === undefined || !Number.isFinite(pane.maxSize)) return Number.POSITIVE_INFINITY;
  return Math.max(min, pane.maxSize);
}

function initialPaneSize(pane: SplitPaneSpec): number {
  if (pane.visible === false) return 0;
  const raw = pane.size ?? pane.defaultSize ?? pane.minSize;
  return clampSize(raw, pane.minSize, pane.maxSize);
}

function distributeDelta(
  sizes: number[],
  panes: readonly SplitPaneSpec[],
  indices: readonly number[],
  delta: number,
): number {
  let remaining = delta;
  const candidates = indices.slice();

  while (Math.abs(remaining) > 0.01 && candidates.length > 0) {
    const active: number[] = [];
    for (const idx of candidates) {
      const pane = panes[idx]!;
      const cur = sizes[idx]!;
      if (remaining > 0 && cur < effectiveMax(pane) - 0.01) active.push(idx);
      else if (remaining < 0 && cur > effectiveMin(pane) + 0.01) active.push(idx);
    }
    if (active.length === 0) break;

    const totalWeight = active.reduce((acc, idx) => acc + Math.max(1, sizes[idx]!), 0);
    let consumed = 0;
    for (const idx of active) {
      const pane = panes[idx]!;
      const cur = sizes[idx]!;
      const share = remaining * (Math.max(1, cur) / totalWeight);
      const next = clampSize(cur + share, effectiveMin(pane), effectiveMax(pane));
      consumed += next - cur;
      sizes[idx] = next;
    }
    if (Math.abs(consumed) < 0.001) break;
    remaining -= consumed;
  }

  return remaining;
}

export function layoutSplitSizes(panes: readonly SplitPaneSpec[], totalSize: number): number[] {
  if (panes.length === 0) return [];
  const target = Math.max(0, Number.isFinite(totalSize) ? totalSize : 0);
  if (target === 0) return panes.map(() => 0);

  const sizes = panes.map(initialPaneSize);
  const sum = sizes.reduce((acc, v) => acc + v, 0);
  let delta = target - sum;

  if (Math.abs(delta) > 0.01) {
    const flexible = panes
      .map((p, i) => ({ p, i }))
      .filter(({ p }) => p.visible !== false && !p.fixed);

    if (delta > 0) {
      const byGrowOrder = [...flexible].sort(
        (a, b) => PRIORITY_RANK[b.p.priority ?? 'normal'] - PRIORITY_RANK[a.p.priority ?? 'normal'],
      );
      for (const tier of [2, 1, 0]) {
        const tierIds = byGrowOrder
          .filter(({ p }) => PRIORITY_RANK[p.priority ?? 'normal'] === tier)
          .map(({ i }) => i);
        if (tierIds.length > 0 && delta > 0.01) {
          delta = distributeDelta(sizes, panes, tierIds, delta);
        }
      }
    } else {
      const byShrinkOrder = [...flexible].sort(
        (a, b) => PRIORITY_RANK[a.p.priority ?? 'normal'] - PRIORITY_RANK[b.p.priority ?? 'normal'],
      );
      for (const tier of [0, 1, 2]) {
        const tierIds = byShrinkOrder
          .filter(({ p }) => PRIORITY_RANK[p.priority ?? 'normal'] === tier)
          .map(({ i }) => i);
        if (tierIds.length > 0 && delta < -0.01) {
          delta = distributeDelta(sizes, panes, tierIds, delta);
        }
      }
    }
  }

  return roundSizes(sizes, panes, target);
}

function roundSizes(sizes: number[], panes: readonly SplitPaneSpec[], target: number): number[] {
  const rounded = sizes.map((v, i) => (panes[i]?.visible === false ? 0 : Math.round(v)));
  const roundedSum = rounded.reduce((acc, v) => acc + v, 0);
  const diff = Math.round(target) - roundedSum;
  if (diff === 0) return rounded;

  const adjustable = panes
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => p.visible !== false && !p.fixed)
    .sort((a, b) => (rounded[b.i] ?? 0) - (rounded[a.i] ?? 0));

  for (const { p, i } of adjustable) {
    const cur = rounded[i]!;
    const next = clampSize(cur + diff, effectiveMin(p), effectiveMax(p));
    if (next === cur + diff) {
      rounded[i] = next;
      break;
    }
  }
  return rounded;
}

function collectResizableIndices(
  panes: readonly SplitPaneSpec[],
  start: number,
  step: -1 | 1,
): number[] {
  const out: number[] = [];
  for (let i = start; i >= 0 && i < panes.length; i += step) {
    const p = panes[i]!;
    if (p.visible !== false && !p.fixed) out.push(i);
  }
  return out;
}

function maxShift(
  panes: readonly SplitPaneSpec[],
  sizes: readonly number[],
  growIndices: readonly number[],
  shrinkIndices: readonly number[],
): number {
  let maxGrow = 0;
  for (const idx of growIndices) {
    const cap = effectiveMax(panes[idx]!);
    if (!Number.isFinite(cap)) {
      maxGrow = Number.POSITIVE_INFINITY;
      break;
    }
    maxGrow += Math.max(0, cap - sizes[idx]!);
  }
  let maxShrink = 0;
  for (const idx of shrinkIndices) {
    maxShrink += Math.max(0, sizes[idx]! - effectiveMin(panes[idx]!));
  }
  return Math.min(maxGrow, maxShrink);
}

export function resizeSplitAt(
  panes: readonly SplitPaneSpec[],
  currentSizes: readonly number[],
  sashIndex: number,
  delta: number,
): number[] {
  const next = currentSizes.slice();
  if (!Number.isFinite(delta) || delta === 0) return next;
  if (sashIndex < 0 || sashIndex >= panes.length - 1) return next;

  const leftIndices = collectResizableIndices(panes, sashIndex, -1);
  const rightIndices = collectResizableIndices(panes, sashIndex + 1, 1);
  if (leftIndices.length === 0 || rightIndices.length === 0) return next;

  const growing = delta > 0 ? leftIndices : rightIndices;
  const shrinking = delta > 0 ? rightIndices : leftIndices;
  const applied = Math.min(Math.abs(delta), maxShift(panes, next, growing, shrinking));
  if (applied <= 0) return next;

  let toGrow = applied;
  for (const idx of growing) {
    if (toGrow <= 0) break;
    const cap = effectiveMax(panes[idx]!);
    const room = Number.isFinite(cap) ? Math.max(0, cap - next[idx]!) : toGrow;
    const step = Math.min(toGrow, room);
    next[idx] = next[idx]! + step;
    toGrow -= step;
  }

  let toShrink = applied - toGrow;
  for (const idx of shrinking) {
    if (toShrink <= 0) break;
    const room = Math.max(0, next[idx]! - effectiveMin(panes[idx]!));
    const step = Math.min(toShrink, room);
    next[idx] = next[idx]! - step;
    toShrink -= step;
  }

  return next.map((v, i) => (panes[i]?.visible === false ? 0 : Math.round(v)));
}

interface MutablePane extends SplitPaneInput {
  minSize: number;
  maxSize?: number;
  size: number;
  defaultSize: number;
  visible: boolean;
  fixed: boolean;
  priority: SplitPriority;
}

export class SplitView implements Disposable {
  private readonly _container: HTMLElement;
  private readonly _orientation: SplitOrientation;
  private readonly _panes: MutablePane[];
  private readonly _sashes: HTMLDivElement[] = [];
  private readonly _storage?: StorageService;
  private readonly _storageKey?: string;
  private readonly _disposables = new DisposableStore();
  private readonly _onDidChange = new Emitter<readonly number[]>();
  private _totalSize = 0;

  readonly onDidChange: Event<readonly number[]> = this._onDidChange.event;

  constructor(options: SplitViewOptions) {
    this._container = options.container;
    this._orientation = options.orientation;
    this._storage = options.storage;
    this._storageKey = options.storageKey;

    const persisted = this._loadPersisted();
    this._panes = options.panes.map((p) => {
      const def = p.defaultSize ?? p.size ?? p.minSize;
      const saved = persisted?.[p.id];
      const init = saved !== undefined ? clampSize(saved, p.minSize, p.maxSize) : clampSize(p.size ?? def, p.minSize, p.maxSize);
      return {
        ...p,
        minSize: p.minSize,
        maxSize: p.maxSize,
        size: init,
        defaultSize: def,
        visible: p.visible ?? true,
        fixed: p.fixed ?? false,
        priority: p.priority ?? 'normal',
      };
    });

    this._disposables.add(this._onDidChange);
    this._mountDom();
  }

  private _loadPersisted(): Record<string, number> | undefined {
    if (!this._storage || !this._storageKey) return undefined;
    const raw = this._storage.getJson<Record<string, unknown>>(this._storageKey);
    if (!raw || typeof raw !== 'object') return undefined;
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[k] = v;
    }
    return out;
  }

  private _savePersisted(): void {
    if (!this._storage || !this._storageKey) return;
    const out: Record<string, number> = {};
    for (const p of this._panes) {
      if (!p.fixed) out[p.id] = p.size;
    }
    this._storage.setJson(this._storageKey, out);
  }

  private _mountDom(): void {
    this._container.classList.add('wb-splitview');
    this._container.dataset.orientation = this._orientation;
    this._container.replaceChildren();

    for (let i = 0; i < this._panes.length; i++) {
      const pane = this._panes[i]!;
      pane.element.classList.add('wb-split-pane');
      pane.element.dataset.paneId = pane.id;
      this._container.appendChild(pane.element);

      if (i < this._panes.length - 1) {
        const sash = this._createSash(i);
        this._sashes.push(sash);
        this._container.appendChild(sash);
      }
    }
    this._syncVisibility();
  }

  private _createSash(index: number): HTMLDivElement {
    const doc = this._container.ownerDocument;
    const sash = doc.createElement('div');
    sash.className = `wb-sash wb-sash-${this._orientation === 'horizontal' ? 'vertical' : 'horizontal'}`;
    sash.setAttribute('role', 'separator');
    sash.setAttribute('aria-orientation', this._orientation === 'horizontal' ? 'vertical' : 'horizontal');
    sash.dataset.sashIndex = String(index);

    this._disposables.add(addDisposableListener(sash, 'pointerdown', (ev) => this._startDrag(index, sash, ev)));
    this._disposables.add(
      addDisposableListener(sash, 'dblclick', () => {
        this._resetSash(index);
      }),
    );
    return sash;
  }

  private _startDrag(index: number, sash: HTMLDivElement, ev: PointerEvent): void {
    if (ev.button !== 0 && ev.pointerType === 'mouse') return;
    ev.preventDefault();

    const startPos = this._orientation === 'horizontal' ? ev.clientX : ev.clientY;
    const startSizes = this._panes.map((p) => (p.visible ? p.size : 0));
    const win = this._container.ownerDocument.defaultView;
    if (!win) return;

    sash.classList.add('is-dragging');
    this._container.classList.add('is-resizing');
    try {
      sash.setPointerCapture?.(ev.pointerId);
    } catch {
      // jsdom or synthetic pointer events may not support capture.
    }

    const dragDisposables = new DisposableStore();
    const onMove = (moveEv: PointerEvent): void => {
      const cur = this._orientation === 'horizontal' ? moveEv.clientX : moveEv.clientY;
      const delta = cur - startPos;
      const next = resizeSplitAt(this._panes, startSizes, index, delta);
      this._applySizes(next);
      this._onDidChange.fire(next);
    };
    const onEnd = (): void => {
      sash.classList.remove('is-dragging');
      this._container.classList.remove('is-resizing');
      this._savePersisted();
      dragDisposables.dispose();
    };

    dragDisposables.add(addDisposableListener(win, 'pointermove', onMove));
    dragDisposables.add(addDisposableListener(win, 'pointerup', onEnd));
    dragDisposables.add(addDisposableListener(win, 'pointercancel', onEnd));
  }

  private _resetSash(index: number): void {
    const left = this._panes[index];
    const right = this._panes[index + 1];
    if (left && left.visible && !left.fixed && left.priority !== 'high') {
      left.size = left.defaultSize;
    } else if (right && right.visible && !right.fixed && right.priority !== 'high') {
      right.size = right.defaultSize;
    } else {
      if (left && !left.fixed) left.size = left.defaultSize;
      if (right && !right.fixed) right.size = right.defaultSize;
    }
    this.layout(this._totalSize || this._measureContainer());
    this._savePersisted();
  }

  private _measureContainer(): number {
    return this._orientation === 'horizontal'
      ? this._container.clientWidth
      : this._container.clientHeight;
  }

  private _syncVisibility(): void {
    for (const pane of this._panes) {
      pane.element.hidden = !pane.visible;
    }
    for (let i = 0; i < this._sashes.length; i++) {
      const leftResizable = collectResizableIndices(this._panes, i, -1).length > 0;
      const rightResizable = collectResizableIndices(this._panes, i + 1, 1).length > 0;
      const sash = this._sashes[i]!;
      sash.hidden = !(leftResizable && rightResizable);
    }
  }

  private _applySizes(sizes: readonly number[]): void {
    for (let i = 0; i < this._panes.length; i++) {
      const pane = this._panes[i]!;
      const sz = sizes[i] ?? 0;
      if (pane.visible) pane.size = sz;
      if (this._orientation === 'horizontal') {
        pane.element.style.width = pane.visible ? `${sz}px` : '0px';
      } else {
        pane.element.style.height = pane.visible ? `${sz}px` : '0px';
      }
    }
  }

  layout(totalSize?: number): readonly number[] {
    const target = totalSize !== undefined ? totalSize : this._measureContainer();
    this._totalSize = Math.max(0, target);
    this._syncVisibility();
    const next = layoutSplitSizes(this._panes, this._totalSize);
    this._applySizes(next);
    this._onDidChange.fire(next);
    return next;
  }

  setPaneVisible(id: string, visible: boolean): void {
    const pane = this._panes.find((p) => p.id === id);
    if (!pane || pane.visible === visible) return;
    pane.visible = visible;
    this._syncVisibility();
    if (this._totalSize > 0) this.layout(this._totalSize);
    else this._onDidChange.fire(this.getSizes());
  }

  setPaneSize(id: string, size: number, persist = false): void {
    const pane = this._panes.find((p) => p.id === id);
    if (!pane) return;
    pane.size = clampSize(size, pane.minSize, pane.maxSize);
    if (this._totalSize > 0) this.layout(this._totalSize);
    else this._applySizes(this._panes.map((p) => (p.visible ? p.size : 0)));
    if (persist) this._savePersisted();
  }

  getPaneSize(id: string): number {
    const pane = this._panes.find((p) => p.id === id);
    if (!pane) return 0;
    return pane.visible ? pane.size : 0;
  }

  getPreferredPaneSize(id: string): number {
    const pane = this._panes.find((p) => p.id === id);
    return pane ? pane.size : 0;
  }

  getSizes(): readonly number[] {
    return this._panes.map((p) => (p.visible ? p.size : 0));
  }

  resetSizes(): void {
    for (const pane of this._panes) {
      pane.size = pane.defaultSize;
    }
    this._storage?.remove(this._storageKey ?? '');
    if (this._totalSize > 0) this.layout(this._totalSize);
  }

  dispose(): void {
    this._disposables.dispose();
  }
}
