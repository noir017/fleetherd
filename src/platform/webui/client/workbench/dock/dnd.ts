import { addDisposableListener } from '../../base/dom.js';
import { type Disposable, DisposableStore, NOOP_DISPOSABLE } from '../../base/lifecycle.js';
import type { OverlayManager } from '../../services/overlays.js';
import type { Direction, PanelPosition, PartId } from '../contracts.js';

export interface DndPoint {
  readonly x: number;
  readonly y: number;
}

export interface DndRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface TabInsertResult {
  readonly index: number;
  readonly lineX: number;
}

export type PartDropRegion = 'header' | 'body';

export interface PartDropArea {
  readonly part: PartId;
  readonly rect: DndRect;
  readonly region?: PartDropRegion;
  readonly tabRects?: readonly DndRect[];
}

export interface PartDropMatch {
  readonly part: PartId;
  readonly region: PartDropRegion;
  readonly rect: DndRect;
  readonly index?: number;
  readonly lineX?: number;
}

export interface GroupDropArea {
  readonly group: string;
  readonly rect: DndRect;
  readonly tabBarRect?: DndRect;
  readonly tabRects?: readonly DndRect[];
}

export interface DockDropZoneSnapshot {
  readonly groups?: readonly GroupDropArea[];
  readonly parts?: readonly PartDropArea[];
}

export type OverlayZone = Direction | 'tab-insert';

export interface OverlayRectOptions {
  readonly lineX?: number;
  readonly lineWidth?: number;
}

export type DragPayloadKind = 'panel' | 'view' | 'tab';

export interface DragPayload {
  readonly kind: DragPayloadKind;
  readonly panelId: string;
  readonly title: string;
  readonly sourceGroup?: string;
  readonly sourcePart?: PartId;
}

export type DropTarget =
  | {
      readonly kind: 'group';
      readonly group: string;
      readonly direction: Direction;
      readonly rect: DndRect;
    }
  | {
      readonly kind: 'tab-bar';
      readonly group: string;
      readonly index: number;
      readonly lineX: number;
      readonly rect: DndRect;
    }
  | {
      readonly kind: 'part';
      readonly part: PartId;
      readonly region: PartDropRegion;
      readonly index?: number;
      readonly lineX?: number;
      readonly rect: DndRect;
    };

export interface DockDndControllerOptions {
  readonly doc?: Document;
  readonly host?: HTMLElement;
  readonly overlays?: OverlayManager;
  readonly enabled?: boolean;
  readonly allowSplit?: boolean;
  readonly thresholdPx?: number;
  readonly edgeRatio?: number;
  readonly getDropZones?: (payload: DragPayload) => DockDropZoneSnapshot;
  readonly resolveTarget?: (
    point: DndPoint,
    payload: DragPayload,
    allowSplit: boolean,
  ) => DropTarget | null;
  readonly onDragStart?: (payload: DragPayload) => void;
  readonly onDragOver?: (payload: DragPayload, target: DropTarget | null) => void;
  readonly onDrop?: (payload: DragPayload, target: DropTarget) => void;
  readonly onDragEnd?: (payload: DragPayload, committed: boolean) => void;
}

const DEFAULT_EDGE_RATIO = 0.25;
const DEFAULT_THRESHOLD_PX = 5;
const DEFAULT_INSERT_LINE_WIDTH = 2;
const GHOST_OFFSET_PX = 12;

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function isValidRect(rect: DndRect): boolean {
  return (
    Number.isFinite(rect.left) &&
    Number.isFinite(rect.top) &&
    Number.isFinite(rect.width) &&
    Number.isFinite(rect.height) &&
    rect.width > 0 &&
    rect.height > 0
  );
}

export function pointInRect(point: DndPoint, rect: DndRect): boolean {
  if (!isValidRect(rect) || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    return false;
  }
  return (
    point.x >= rect.left &&
    point.x <= rect.left + rect.width &&
    point.y >= rect.top &&
    point.y <= rect.top + rect.height
  );
}

export function exceedsDragThreshold(
  start: DndPoint,
  current: DndPoint,
  thresholdPx: number = DEFAULT_THRESHOLD_PX,
): boolean {
  const safeThreshold = Math.max(0, Number.isFinite(thresholdPx) ? thresholdPx : DEFAULT_THRESHOLD_PX);
  const dx = current.x - start.x;
  const dy = current.y - start.y;
  return Math.hypot(dx, dy) >= safeThreshold;
}

export function computeGroupDropZone(
  point: DndPoint,
  rect: DndRect,
  allowSplit: boolean = true,
  edgeRatio: number = DEFAULT_EDGE_RATIO,
): Direction {
  if (!allowSplit || !isValidRect(rect)) return 'within';
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return 'within';

  const ratio = clamp(edgeRatio, 0, 0.5);
  if (ratio <= 0) return 'within';

  const rx = clamp((point.x - rect.left) / rect.width, 0, 1);
  const ry = clamp((point.y - rect.top) / rect.height, 0, 1);

  const candidates: ReadonlyArray<{ readonly dir: Direction; readonly dist: number }> = [
    { dir: 'left', dist: rx },
    { dir: 'right', dist: 1 - rx },
    { dir: 'above', dist: ry },
    { dir: 'below', dist: 1 - ry },
  ];

  let bestDir: Direction = 'within';
  let bestDist = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    if (candidate.dist <= ratio && candidate.dist < bestDist) {
      bestDist = candidate.dist;
      bestDir = candidate.dir;
    }
  }
  return bestDir;
}

export function computeTabInsertIndex(
  pointX: number,
  tabRects: readonly DndRect[],
  fallbackLineX?: number,
): TabInsertResult {
  const safeX = Number.isFinite(pointX) ? pointX : 0;
  if (tabRects.length === 0) {
    const lineX =
      fallbackLineX !== undefined && Number.isFinite(fallbackLineX) ? fallbackLineX : safeX;
    return { index: 0, lineX };
  }

  for (let i = 0; i < tabRects.length; i++) {
    const rect = tabRects[i];
    if (!rect) continue;
    const midX = rect.left + rect.width / 2;
    if (safeX < midX) {
      return { index: i, lineX: rect.left };
    }
  }

  const last = tabRects[tabRects.length - 1];
  const endX = last ? last.left + last.width : safeX;
  return { index: tabRects.length, lineX: endX };
}

export function computePartDropTarget(
  point: DndPoint,
  partRects: readonly PartDropArea[],
): PartDropMatch | null {
  let matched: PartDropArea | null = null;
  for (const area of partRects) {
    if (!pointInRect(point, area.rect)) continue;
    const region = area.region ?? 'body';
    if (!matched || (region === 'header' && (matched.region ?? 'body') !== 'header')) {
      matched = area;
    }
  }
  if (!matched) return null;

  const region = matched.region ?? 'body';
  if (region === 'header' && matched.tabRects !== undefined) {
    const insert = computeTabInsertIndex(point.x, matched.tabRects, matched.rect.left);
    return {
      part: matched.part,
      region,
      rect: matched.rect,
      index: insert.index,
      lineX: insert.lineX,
    };
  }

  return {
    part: matched.part,
    region,
    rect: matched.rect,
  };
}

export function computeOverlayRect(
  zone: OverlayZone,
  targetRect: DndRect,
  options?: OverlayRectOptions,
): DndRect {
  const left = Number.isFinite(targetRect.left) ? targetRect.left : 0;
  const top = Number.isFinite(targetRect.top) ? targetRect.top : 0;
  const width = Math.max(0, Number.isFinite(targetRect.width) ? targetRect.width : 0);
  const height = Math.max(0, Number.isFinite(targetRect.height) ? targetRect.height : 0);

  switch (zone) {
    case 'left':
      return { left, top, width: width / 2, height };
    case 'right':
      return { left: left + width / 2, top, width: width / 2, height };
    case 'above':
      return { left, top, width, height: height / 2 };
    case 'below':
      return { left, top: top + height / 2, width, height: height / 2 };
    case 'within':
      return { left, top, width, height };
    case 'tab-insert': {
      const lineWidth = Math.max(
        1,
        Number.isFinite(options?.lineWidth) ? (options?.lineWidth ?? DEFAULT_INSERT_LINE_WIDTH) : DEFAULT_INSERT_LINE_WIDTH,
      );
      const rawX = options?.lineX ?? left;
      const clampedX = clamp(rawX, left, left + width);
      return {
        left: clampedX - lineWidth / 2,
        top,
        width: lineWidth,
        height,
      };
    }
  }
}

export function resolveDropTarget(
  point: DndPoint,
  snapshot: DockDropZoneSnapshot,
  allowSplit: boolean = true,
  edgeRatio: number = DEFAULT_EDGE_RATIO,
): DropTarget | null {
  const groups = snapshot.groups ?? [];
  for (const group of groups) {
    if (group.tabBarRect && pointInRect(point, group.tabBarRect)) {
      const insert = computeTabInsertIndex(point.x, group.tabRects ?? [], group.tabBarRect.left);
      return {
        kind: 'tab-bar',
        group: group.group,
        index: insert.index,
        lineX: insert.lineX,
        rect: group.tabBarRect,
      };
    }
  }

  const parts = snapshot.parts ?? [];
  if (parts.length > 0) {
    const partMatch = computePartDropTarget(point, parts);
    if (partMatch) {
      return {
        kind: 'part',
        part: partMatch.part,
        region: partMatch.region,
        rect: partMatch.rect,
        ...(partMatch.index !== undefined ? { index: partMatch.index } : {}),
        ...(partMatch.lineX !== undefined ? { lineX: partMatch.lineX } : {}),
      };
    }
  }

  for (const group of groups) {
    if (!pointInRect(point, group.rect)) continue;
    const direction = computeGroupDropZone(point, group.rect, allowSplit, edgeRatio);
    return {
      kind: 'group',
      group: group.group,
      direction,
      rect: group.rect,
    };
  }

  return null;
}

export function dropTargetToPanelPosition(target: DropTarget): PanelPosition {
  switch (target.kind) {
    case 'group':
      return { group: target.group, direction: target.direction };
    case 'tab-bar':
      return { group: target.group, direction: 'within', index: target.index };
    case 'part':
      return target.index !== undefined
        ? { part: target.part, index: target.index }
        : { part: target.part };
  }
}

interface ActiveDragSession {
  readonly pointerId: number;
  readonly sourceEl: HTMLElement;
  readonly payload: DragPayload;
  readonly startPoint: DndPoint;
  dragging: boolean;
  target: DropTarget | null;
}

function getOverlayZoneForTarget(target: DropTarget): {
  readonly zone: OverlayZone;
  readonly lineX?: number;
} {
  if (target.kind === 'group') return { zone: target.direction };
  if (target.kind === 'tab-bar') return { zone: 'tab-insert', lineX: target.lineX };
  if (target.region === 'header' && target.lineX !== undefined) {
    return { zone: 'tab-insert', lineX: target.lineX };
  }
  return { zone: 'within' };
}

function applyRectStyle(el: HTMLElement, rect: DndRect): void {
  el.style.left = `${rect.left}px`;
  el.style.top = `${rect.top}px`;
  el.style.width = `${rect.width}px`;
  el.style.height = `${rect.height}px`;
}

function shouldIgnoreTarget(target: EventTarget | null): boolean {
  if (!target || typeof target !== 'object') return false;
  const el = target as { closest?: (selector: string) => Element | null };
  return typeof el.closest === 'function' && el.closest('[data-dnd-ignore]') !== null;
}

export class DockDndController implements Disposable {
  private readonly _doc: Document | undefined;
  private readonly _host: HTMLElement | undefined;
  private readonly _overlays: OverlayManager | undefined;
  private readonly _thresholdPx: number;
  private readonly _edgeRatio: number;
  private readonly _options: DockDndControllerOptions;
  private readonly _disposables = new DisposableStore();
  private readonly _sessionDisposables = new DisposableStore();

  private _enabled: boolean;
  private _allowSplit: boolean;
  private _session: ActiveDragSession | null = null;
  private _ghostEl: HTMLDivElement | null = null;
  private _overlayEl: HTMLDivElement | null = null;
  private _disposed = false;

  constructor(options: DockDndControllerOptions = {}) {
    this._options = options;
    this._doc = options.doc ?? (typeof document !== 'undefined' ? document : undefined);
    this._host = options.host ?? this._doc?.body;
    this._overlays = options.overlays;
    this._enabled = options.enabled ?? true;
    this._allowSplit = options.allowSplit ?? true;
    this._thresholdPx = Math.max(
      0,
      Number.isFinite(options.thresholdPx) ? (options.thresholdPx ?? DEFAULT_THRESHOLD_PX) : DEFAULT_THRESHOLD_PX,
    );
    this._edgeRatio = options.edgeRatio ?? DEFAULT_EDGE_RATIO;
  }

  get enabled(): boolean {
    return this._enabled;
  }

  get allowSplit(): boolean {
    return this._allowSplit;
  }

  get isDragging(): boolean {
    return this._session?.dragging === true;
  }

  get activePayload(): DragPayload | null {
    return this._session?.dragging ? this._session.payload : null;
  }

  setEnabled(enabled: boolean): void {
    this._enabled = enabled;
    if (!enabled) this.cancel();
  }

  setAllowSplit(allowSplit: boolean): void {
    this._allowSplit = allowSplit;
  }

  attachSource(
    element: HTMLElement,
    payloadOrGetter: DragPayload | (() => DragPayload | null),
  ): Disposable {
    if (this._disposed || !this._enabled) return NOOP_DISPOSABLE;

    const sub = addDisposableListener(element, 'pointerdown', (ev) => {
      this._onPointerDown(element, payloadOrGetter, ev);
    });
    return this._disposables.add(sub);
  }

  cancel(): void {
    const session = this._session;
    if (!session) return;
    const wasDragging = session.dragging;
    const payload = session.payload;
    this._cleanupSession();
    if (wasDragging) {
      this._options.onDragEnd?.(payload, false);
    }
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this.cancel();
    this._disposables.dispose();
  }

  private _onPointerDown(
    sourceEl: HTMLElement,
    payloadOrGetter: DragPayload | (() => DragPayload | null),
    ev: PointerEvent,
  ): void {
    if (this._disposed || !this._enabled || this._session) return;
    if (ev.pointerType === 'mouse' && ev.button !== 0) return;
    if (shouldIgnoreTarget(ev.target)) return;

    const payload = typeof payloadOrGetter === 'function' ? payloadOrGetter() : payloadOrGetter;
    if (!payload) return;

    const doc = this._doc ?? sourceEl.ownerDocument;
    const win = doc.defaultView;
    if (!win) return;

    const session: ActiveDragSession = {
      pointerId: ev.pointerId,
      sourceEl,
      payload,
      startPoint: { x: ev.clientX, y: ev.clientY },
      dragging: false,
      target: null,
    };
    this._session = session;

    try {
      sourceEl.setPointerCapture?.(ev.pointerId);
    } catch {
      // jsdom or synthetic pointer events may not support capture.
    }

    this._bindSessionListeners(doc, win);
  }

  private _bindSessionListeners(doc: Document, win: Window): void {
    this._sessionDisposables.clear();
    this._sessionDisposables.add(
      addDisposableListener(win, 'pointermove', (ev) => this._onPointerMove(ev)),
    );
    this._sessionDisposables.add(
      addDisposableListener(win, 'pointerup', (ev) => this._onPointerUp(ev)),
    );
    this._sessionDisposables.add(
      addDisposableListener(win, 'pointercancel', (ev) => this._onPointerCancel(ev)),
    );
    this._sessionDisposables.add(addDisposableListener(win, 'blur', () => this.cancel()));
    this._sessionDisposables.add(
      addDisposableListener(doc, 'visibilitychange', () => {
        if (doc.hidden) this.cancel();
      }),
    );
    this._sessionDisposables.add(
      addDisposableListener(
        doc,
        'keydown',
        (ev) => {
          if (ev.key !== 'Escape' || ev.isComposing) return;
          ev.preventDefault();
          ev.stopPropagation();
          this.cancel();
        },
        { capture: true },
      ),
    );
  }

  private _onPointerMove(ev: PointerEvent): void {
    const session = this._session;
    if (!session || ev.pointerId !== session.pointerId) return;

    const point: DndPoint = { x: ev.clientX, y: ev.clientY };
    if (!session.dragging) {
      if (!exceedsDragThreshold(session.startPoint, point, this._thresholdPx)) return;
      this._activateDrag(session, point);
    }

    ev.preventDefault();
    this._positionGhost(point);
    const target = this._evaluateTarget(point, session.payload);
    session.target = target;
    this._renderOverlay(target);
    this._options.onDragOver?.(session.payload, target);
  }

  private _onPointerUp(ev: PointerEvent): void {
    const session = this._session;
    if (!session || ev.pointerId !== session.pointerId) return;

    if (!session.dragging) {
      this._cleanupSession();
      return;
    }

    const point: DndPoint = { x: ev.clientX, y: ev.clientY };
    const finalTarget = this._evaluateTarget(point, session.payload) ?? session.target;
    const payload = session.payload;

    this._cleanupSession();

    if (finalTarget) {
      this._options.onDrop?.(payload, finalTarget);
      this._options.onDragEnd?.(payload, true);
    } else {
      this._options.onDragEnd?.(payload, false);
    }
  }

  private _onPointerCancel(ev: PointerEvent): void {
    const session = this._session;
    if (!session || ev.pointerId !== session.pointerId) return;
    this.cancel();
  }

  private _activateDrag(session: ActiveDragSession, point: DndPoint): void {
    session.dragging = true;
    const doc = this._doc ?? session.sourceEl.ownerDocument;
    const host = this._host ?? doc.body;

    if (this._overlays) {
      this._sessionDisposables.add(
        this._overlays.push({
          id: 'dock-dnd',
          close: () => {
            this.cancel();
            return true;
          },
        }),
      );
    }

    const ghost = doc.createElement('div');
    ghost.className = 'wb-dnd-ghost';
    ghost.setAttribute('aria-hidden', 'true');
    ghost.textContent = session.payload.title;
    ghost.style.position = 'fixed';
    ghost.style.pointerEvents = 'none';
    host.appendChild(ghost);
    this._ghostEl = ghost;

    const overlay = doc.createElement('div');
    overlay.className = 'wb-dnd-overlay';
    overlay.setAttribute('aria-hidden', 'true');
    overlay.style.position = 'fixed';
    overlay.style.pointerEvents = 'none';
    overlay.hidden = true;
    host.appendChild(overlay);
    this._overlayEl = overlay;

    host.classList.add('wb-is-dragging');
    this._positionGhost(point);
    this._options.onDragStart?.(session.payload);
  }

  private _positionGhost(point: DndPoint): void {
    if (!this._ghostEl) return;
    this._ghostEl.style.left = `${point.x + GHOST_OFFSET_PX}px`;
    this._ghostEl.style.top = `${point.y + GHOST_OFFSET_PX}px`;
  }

  private _evaluateTarget(point: DndPoint, payload: DragPayload): DropTarget | null {
    if (this._options.resolveTarget) {
      return this._options.resolveTarget(point, payload, this._allowSplit);
    }
    if (!this._options.getDropZones) return null;
    const snapshot = this._options.getDropZones(payload);
    return resolveDropTarget(point, snapshot, this._allowSplit, this._edgeRatio);
  }

  private _renderOverlay(target: DropTarget | null): void {
    const overlay = this._overlayEl;
    if (!overlay) return;
    if (!target) {
      overlay.hidden = true;
      overlay.removeAttribute('data-dnd-zone');
      overlay.classList.remove('is-line');
      return;
    }

    const { zone, lineX } = getOverlayZoneForTarget(target);
    const rect = computeOverlayRect(
      zone,
      target.rect,
      lineX !== undefined ? { lineX } : undefined,
    );
    applyRectStyle(overlay, rect);
    overlay.setAttribute('data-dnd-zone', zone);
    overlay.classList.toggle('is-line', zone === 'tab-insert');
    overlay.hidden = false;
  }

  private _cleanupSession(): void {
    const session = this._session;
    this._session = null;
    this._sessionDisposables.clear();

    if (session) {
      try {
        session.sourceEl.releasePointerCapture?.(session.pointerId);
      } catch {
        // Ignore release errors when pointer capture was not active.
      }
      const host = this._host ?? session.sourceEl.ownerDocument.body;
      host.classList.remove('wb-is-dragging');
    }

    this._ghostEl?.remove();
    this._ghostEl = null;
    this._overlayEl?.remove();
    this._overlayEl = null;
  }
}
