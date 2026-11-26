import { addDisposableListener } from '../base/dom.js';
import { type Disposable, DisposableStore } from '../base/lifecycle.js';

const EDGE_ZONE_PX = 28;
const LOCK_PX = 10;
const SNAP_RATIO = 0.25;
const FLICK_VELOCITY = 0.35;
const MIN_FLICK_PX = 24;
const DEFAULT_DRAWER_W = 340;
const MAX_DRAWER_W = 380;

export interface MobileDrawerOptions {
  readonly doc: Document;
  readonly win: Window | null;
  readonly shellEl: HTMLElement;
  readonly activityBarEl: HTMLElement;
  readonly sidebarEl: HTMLElement;
  readonly backdropEl: HTMLElement;
  readonly isMobile: () => boolean;
  readonly isSidebarOpen: () => boolean;
  readonly isSecondaryOpen: () => boolean;
  readonly setSidebarOpen: (open: boolean) => void;
  readonly closeAllDrawers: () => void;
}

interface DrawerTrack {
  readonly kind: 'open' | 'close';
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  readonly startTime: number;
  readonly drawerW: number;
  locked: 'none' | 'horizontal' | 'vertical';
  currentDx: number;
}

function asElement(target: EventTarget | null): Element | null {
  return target && typeof (target as Element).closest === 'function' ? (target as Element) : null;
}

function isBlockedOpenTarget(el: Element): boolean {
  return Boolean(
    el.closest('.fh-dialog, .fh-sheet, .fh-menu, .fh-qp, .cm-scroller, .tbl, input, textarea, select'),
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function isDrawerHistoryState(state: unknown): boolean {
  return Boolean(state && typeof state === 'object' && (state as { readonly wbDrawer?: unknown }).wbDrawer === true);
}

export class MobileDrawerController implements Disposable {
  private readonly _opts: MobileDrawerOptions;
  private readonly _disposables = new DisposableStore();
  private _track: DrawerTrack | null = null;
  private _historyPushed = false;
  private _ignoringPopstate = false;

  constructor(opts: MobileDrawerOptions) {
    this._opts = opts;
    this._wireEvents();
  }

  syncDrawerHistory(anyOpen: boolean): void {
    const win = this._opts.win;
    if (!win?.history) return;
    if (this._opts.isMobile() && anyOpen) {
      if (!this._historyPushed) {
        const cur = win.history.state && typeof win.history.state === 'object' ? win.history.state : {};
        win.history.pushState({ ...(cur as Record<string, unknown>), wbDrawer: true }, '');
        this._historyPushed = true;
      }
      return;
    }
    if (!anyOpen && this._historyPushed) {
      this._historyPushed = false;
      if (isDrawerHistoryState(win.history.state)) {
        this._ignoringPopstate = true;
        win.history.back();
      }
    }
  }

  dispose(): void {
    this._clearDragVisuals();
    this._track = null;
    this._disposables.dispose();
  }

  private _measureDrawerWidth(): number {
    const vw = this._opts.win?.innerWidth || 390;
    const measured = this._opts.activityBarEl.offsetWidth + this._opts.sidebarEl.offsetWidth;
    if (measured > 100) return measured;
    return Math.min(Math.round(vw * 0.88), MAX_DRAWER_W) || DEFAULT_DRAWER_W;
  }

  private _wireEvents(): void {
    const { doc, win, shellEl } = this._opts;

    this._disposables.add(
      addDisposableListener(shellEl, 'pointerdown', (ev) => this._onPointerDown(ev)),
    );
    this._disposables.add(
      addDisposableListener(doc, 'pointermove', (ev) => this._onPointerMove(ev)),
    );
    this._disposables.add(
      addDisposableListener(doc, 'pointerup', (ev) => this._onPointerEnd(ev, false)),
    );
    this._disposables.add(
      addDisposableListener(doc, 'pointercancel', (ev) => this._onPointerEnd(ev, true)),
    );

    if (win) {
      this._disposables.add(
        addDisposableListener(win, 'popstate', () => {
          if (this._ignoringPopstate) {
            this._ignoringPopstate = false;
            return;
          }
          if (!this._opts.isMobile()) return;
          if (this._opts.isSidebarOpen() || this._opts.isSecondaryOpen()) {
            this._historyPushed = false;
            this._opts.closeAllDrawers();
          }
        }),
      );
    }
  }

  private _onPointerDown(ev: PointerEvent): void {
    if (!this._opts.isMobile()) return;
    if (!ev.isPrimary) return;
    if (ev.pointerType === 'mouse' && ev.button !== 0) return;

    const el = asElement(ev.target);
    if (!el) return;

    const sidebarOpen = this._opts.isSidebarOpen();
    const secondaryOpen = this._opts.isSecondaryOpen();

    if (!sidebarOpen && !secondaryOpen && ev.clientX <= EDGE_ZONE_PX) {
      if (isBlockedOpenTarget(el)) return;
      this._track = {
        kind: 'open',
        pointerId: ev.pointerId,
        startX: ev.clientX,
        startY: ev.clientY,
        startTime: Date.now(),
        drawerW: this._measureDrawerWidth(),
        locked: 'none',
        currentDx: 0,
      };
      return;
    }

    if (sidebarOpen) {
      const inDrawer =
        this._opts.backdropEl.contains(el) ||
        this._opts.activityBarEl.contains(el) ||
        this._opts.sidebarEl.contains(el);
      if (!inDrawer) return;
      // Preserve topic row left-swipe actions inside the Topics list.
      if (el.closest('.wb-topic-swipe-wrap')) return;
      this._track = {
        kind: 'close',
        pointerId: ev.pointerId,
        startX: ev.clientX,
        startY: ev.clientY,
        startTime: Date.now(),
        drawerW: this._measureDrawerWidth(),
        locked: 'none',
        currentDx: 0,
      };
    }
  }

  private _onPointerMove(ev: PointerEvent): void {
    const track = this._track;
    if (!track || ev.pointerId !== track.pointerId) return;

    const dx = ev.clientX - track.startX;
    const dy = ev.clientY - track.startY;

    if (track.locked === 'none') {
      if (Math.abs(dy) > LOCK_PX && Math.abs(dy) >= Math.abs(dx)) {
        track.locked = 'vertical';
        return;
      }
      if (Math.abs(dx) > LOCK_PX) {
        if ((track.kind === 'open' && dx > 0) || (track.kind === 'close' && dx < 0)) {
          track.locked = 'horizontal';
        } else {
          track.locked = 'vertical';
          return;
        }
      } else {
        return;
      }
    }

    if (track.locked !== 'horizontal') return;

    track.currentDx = dx;
    const tx =
      track.kind === 'open'
        ? clamp(-track.drawerW + dx, -track.drawerW, 0)
        : clamp(dx, -track.drawerW, 0);
    const progress = clamp((track.drawerW + tx) / Math.max(1, track.drawerW), 0, 1);

    this._opts.shellEl.classList.add('is-drawer-dragging');
    this._opts.shellEl.style.setProperty('--wb-drawer-tx', `${Math.round(tx)}px`);
    this._opts.backdropEl.hidden = false;
    this._opts.backdropEl.style.opacity = String(progress);
  }

  private _onPointerEnd(ev: PointerEvent, cancelled: boolean): void {
    const track = this._track;
    if (!track || ev.pointerId !== track.pointerId) return;
    this._track = null;
    this._clearDragVisuals();

    if (track.locked !== 'horizontal' || cancelled) {
      if (track.kind === 'open' && !this._opts.isSidebarOpen() && !this._opts.isSecondaryOpen()) {
        this._opts.backdropEl.hidden = true;
      }
      return;
    }

    const elapsed = Math.max(1, Date.now() - track.startTime);
    const dist = track.kind === 'open' ? track.currentDx : -track.currentDx;
    const velocity = dist / elapsed;
    const commit = dist >= track.drawerW * SNAP_RATIO || (velocity >= FLICK_VELOCITY && dist >= MIN_FLICK_PX);

    if (track.kind === 'open') {
      if (commit) this._opts.setSidebarOpen(true);
      else this._opts.backdropEl.hidden = true;
    } else if (commit) {
      this._opts.setSidebarOpen(false);
    }
  }

  private _clearDragVisuals(): void {
    this._opts.shellEl.classList.remove('is-drawer-dragging');
    this._opts.shellEl.style.removeProperty('--wb-drawer-tx');
    this._opts.backdropEl.style.removeProperty('opacity');
  }
}
