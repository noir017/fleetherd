import { addDisposableListener } from '../../base/dom.js';
import { type Disposable, DisposableStore } from '../../base/lifecycle.js';

export type SplitterOrientation = 'horizontal' | 'vertical';

export interface SplitterOptions {
  readonly orientation?: SplitterOrientation;
  readonly ariaLabel?: string;
  readonly title?: string;
  readonly step?: number;
  readonly largeStep?: number;
  readonly valueNow?: number;
  readonly valueMin?: number;
  readonly valueMax?: number;
  readonly className?: string;
  readonly onDragStart?: () => void;
  readonly onDrag?: (deltaPx: number, totalDeltaPx: number) => void;
  readonly onDragEnd?: (totalDeltaPx: number) => void;
  readonly onStep?: (deltaPx: number) => void;
  readonly onReset?: () => void;
}

export interface SplitterController extends Disposable {
  readonly el: HTMLElement;
  setAriaValue(now: number, min?: number, max?: number): void;
}

function resolveKeyDelta(
  key: string,
  orientation: SplitterOrientation,
  step: number,
): number | null {
  if (orientation === 'horizontal') {
    if (key === 'ArrowLeft') return -step;
    if (key === 'ArrowRight') return step;
    return null;
  }
  if (key === 'ArrowUp') return -step;
  if (key === 'ArrowDown') return step;
  return null;
}

export function createSplitter(
  opts: SplitterOptions = {},
  doc: Document = document,
): SplitterController {
  const orientation: SplitterOrientation = opts.orientation ?? 'horizontal';
  const step = opts.step ?? 10;
  const largeStep = opts.largeStep ?? 40;
  const listeners = new DisposableStore();

  const el = doc.createElement('div');
  el.className = `fh-splitter fh-splitter--${orientation}${opts.className ? ` ${opts.className}` : ''}`;
  el.setAttribute('role', 'separator');
  el.setAttribute('tabindex', '0');
  el.setAttribute('aria-orientation', orientation === 'horizontal' ? 'vertical' : 'horizontal');
  if (opts.ariaLabel) el.setAttribute('aria-label', opts.ariaLabel);
  if (opts.title) el.title = opts.title;

  const setAriaValue = (now: number, min?: number, max?: number): void => {
    el.setAttribute('aria-valuenow', String(Math.round(now)));
    if (min !== undefined) el.setAttribute('aria-valuemin', String(Math.round(min)));
    if (max !== undefined) el.setAttribute('aria-valuemax', String(Math.round(max)));
  };

  if (opts.valueNow !== undefined) setAriaValue(opts.valueNow, opts.valueMin, opts.valueMax);

  let activePointerId: number | null = null;
  let startPos = 0;
  let lastPos = 0;

  const finishDrag = (ev?: PointerEvent): void => {
    if (activePointerId === null) return;
    if (ev && ev.pointerId !== activePointerId) return;
    const total = lastPos - startPos;
    const pid = activePointerId;
    activePointerId = null;
    el.classList.remove('is-dragging');
    if (typeof el.releasePointerCapture === 'function') {
      try {
        el.releasePointerCapture(pid);
      } catch {
        // Ignore if capture was already released.
      }
    }
    opts.onDragEnd?.(total);
  };

  listeners.add(
    addDisposableListener(el, 'pointerdown', (ev: PointerEvent) => {
      if (ev.button !== 0 && ev.pointerType === 'mouse') return;
      ev.preventDefault();
      activePointerId = ev.pointerId;
      startPos = orientation === 'horizontal' ? ev.clientX : ev.clientY;
      lastPos = startPos;
      el.classList.add('is-dragging');
      if (typeof el.setPointerCapture === 'function') {
        try {
          el.setPointerCapture(ev.pointerId);
        } catch {
          // Synthetic events in jsdom may not register a pointer id.
        }
      }
      opts.onDragStart?.();
    }),
  );

  listeners.add(
    addDisposableListener(doc, 'pointermove', (ev: PointerEvent) => {
      if (activePointerId === null || ev.pointerId !== activePointerId) return;
      const current = orientation === 'horizontal' ? ev.clientX : ev.clientY;
      const delta = current - lastPos;
      if (delta === 0) return;
      lastPos = current;
      opts.onDrag?.(delta, current - startPos);
    }),
  );

  listeners.add(addDisposableListener(doc, 'pointerup', (ev: PointerEvent) => finishDrag(ev)));
  listeners.add(addDisposableListener(doc, 'pointercancel', (ev: PointerEvent) => finishDrag(ev)));

  listeners.add(
    addDisposableListener(el, 'dblclick', () => {
      opts.onReset?.();
    }),
  );

  listeners.add(
    addDisposableListener(el, 'keydown', (ev: KeyboardEvent) => {
      if (ev.key === 'Enter' || ev.key === '0') {
        if (opts.onReset) {
          ev.preventDefault();
          opts.onReset();
        }
        return;
      }
      const delta = resolveKeyDelta(ev.key, orientation, ev.shiftKey ? largeStep : step);
      if (delta === null) return;
      ev.preventDefault();
      if (opts.onStep) opts.onStep(delta);
      else opts.onDrag?.(delta, delta);
    }),
  );

  return {
    el,
    setAriaValue,
    dispose(): void {
      finishDrag();
      listeners.dispose();
      el.remove();
    },
  };
}
