import { addDisposableListener } from '../../base/dom.js';
import { type Disposable, DisposableStore } from '../../base/lifecycle.js';

export const SWIPE_ACTION_WIDTH = 222;
const SWIPE_LOCK_PX = 10;
const SWIPE_SNAP_PX = 60;
const LONG_PRESS_MS = 500;
const LONG_PRESS_MOVE_PX = 10;

export interface TopicGesturesOptions {
  readonly container: HTMLElement;
  readonly doc?: Document;
  readonly win?: Window;
  readonly isMobile: () => boolean;
  readonly onLongPress: (topicId: string) => void;
}

export interface TopicGesturesController extends Disposable {
  closeAll(): void;
  getOpenId(): string | null;
  consumeSuppressedClick(): boolean;
}

interface ActiveTrack {
  readonly pointerId: number;
  readonly topicId: string;
  readonly wrap: HTMLElement;
  readonly row: HTMLElement;
  readonly startX: number;
  readonly startY: number;
  readonly baseOffset: number;
  locked: 'none' | 'horizontal' | 'vertical';
  currentOffset: number;
  longPressed: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

function asElement(target: EventTarget | null): Element | null {
  return target && typeof (target as Element).closest === 'function' ? (target as Element) : null;
}

function clampSwipeOffset(value: number): number {
  return Math.max(-SWIPE_ACTION_WIDTH, Math.min(0, value));
}

function clearTrackTimer(track: ActiveTrack): void {
  if (track.timer !== null) {
    clearTimeout(track.timer);
    track.timer = null;
  }
}

export function createTopicGestures(opts: TopicGesturesOptions): TopicGesturesController {
  const doc = opts.doc ?? document;
  const listeners = new DisposableStore();
  let openId: string | null = null;
  let openWrap: HTMLElement | null = null;
  let openRow: HTMLElement | null = null;
  let active: ActiveTrack | null = null;
  let suppressClickUntil = 0;

  const setRowOffset = (row: HTMLElement, wrap: HTMLElement, offset: number, animate: boolean): void => {
    row.style.transition = animate ? 'transform .18s ease-out' : 'none';
    row.style.transform = offset === 0 ? '' : `translateX(${offset}px)`;
    wrap.classList.toggle('is-swiped', offset < 0);
  };

  const closeAll = (): void => {
    if (openWrap && openRow) {
      setRowOffset(openRow, openWrap, 0, true);
    }
    openId = null;
    openWrap = null;
    openRow = null;
  };

  const suppressNextClick = (): void => {
    suppressClickUntil = Date.now() + 400;
  };

  const finishTrack = (cancelled: boolean): void => {
    if (!active) return;
    const track = active;
    active = null;
    clearTrackTimer(track);
    if (track.longPressed) {
      suppressNextClick();
      return;
    }
    if (track.locked !== 'horizontal') return;
    suppressNextClick();
    if (!cancelled && track.currentOffset <= -SWIPE_SNAP_PX) {
      setRowOffset(track.row, track.wrap, -SWIPE_ACTION_WIDTH, true);
      openId = track.topicId;
      openWrap = track.wrap;
      openRow = track.row;
    } else {
      setRowOffset(track.row, track.wrap, 0, true);
      if (openId === track.topicId) {
        openId = null;
        openWrap = null;
        openRow = null;
      }
    }
  };

  const onPointerDown = (e: PointerEvent): void => {
    if (!opts.isMobile()) return;
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    const el = asElement(e.target);
    if (!el || el.closest('[data-swipe-act],[data-fold],[data-rm],[data-filter-clear]')) return;
    const row = el.closest<HTMLElement>('[data-topic]');
    const wrap = row?.closest<HTMLElement>('.wb-topic-swipe-wrap');
    if (!row || !wrap) {
      closeAll();
      return;
    }
    const topicId = row.getAttribute('data-topic');
    if (!topicId) return;
    if (openId && openId !== topicId) closeAll();

    const baseOffset = openId === topicId ? -SWIPE_ACTION_WIDTH : 0;
    const track: ActiveTrack = {
      pointerId: e.pointerId,
      topicId,
      wrap,
      row,
      startX: e.clientX,
      startY: e.clientY,
      baseOffset,
      locked: 'none',
      currentOffset: baseOffset,
      longPressed: false,
      timer: null,
    };
    track.timer = setTimeout(() => {
      if (active !== track || track.locked !== 'none') return;
      track.longPressed = true;
      track.timer = null;
      closeAll();
      suppressNextClick();
      opts.onLongPress(track.topicId);
    }, LONG_PRESS_MS);
    active = track;
  };

  const onPointerMove = (e: PointerEvent): void => {
    if (!active || e.pointerId !== active.pointerId || active.longPressed) return;
    const dx = e.clientX - active.startX;
    const dy = e.clientY - active.startY;
    if (Math.hypot(dx, dy) > LONG_PRESS_MOVE_PX) clearTrackTimer(active);

    if (active.locked === 'none') {
      if (Math.abs(dy) > SWIPE_LOCK_PX && Math.abs(dy) >= Math.abs(dx)) {
        active.locked = 'vertical';
        return;
      }
      if (Math.abs(dx) > SWIPE_LOCK_PX) {
        active.locked = 'horizontal';
      } else {
        return;
      }
    }
    if (active.locked !== 'horizontal') return;
    const next = clampSwipeOffset(active.baseOffset + dx);
    active.currentOffset = next;
    setRowOffset(active.row, active.wrap, next, false);
  };

  const onPointerEnd = (e: PointerEvent): void => {
    if (!active || e.pointerId !== active.pointerId) return;
    finishTrack(e.type === 'pointercancel');
  };

  listeners.add(addDisposableListener(opts.container, 'pointerdown', onPointerDown));
  listeners.add(addDisposableListener(doc, 'pointermove', onPointerMove));
  listeners.add(addDisposableListener(doc, 'pointerup', onPointerEnd));
  listeners.add(addDisposableListener(doc, 'pointercancel', onPointerEnd));
  listeners.add(
    addDisposableListener(opts.container, 'scroll', () => {
      if (openId) closeAll();
    }),
  );

  return {
    closeAll,
    getOpenId: () => openId,
    consumeSuppressedClick: () => {
      if (Date.now() <= suppressClickUntil) {
        suppressClickUntil = 0;
        return true;
      }
      return false;
    },
    dispose(): void {
      if (active) clearTrackTimer(active);
      active = null;
      closeAll();
      listeners.dispose();
    },
  };
}
