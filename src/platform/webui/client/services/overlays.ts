import { addDisposableListener, focusSafely } from '../base/dom.js';
import { type Disposable, DisposableStore, toDisposable } from '../base/lifecycle.js';

export interface OverlayEntry {
  readonly id?: string;
  readonly close: () => boolean | void;
  readonly restoreFocus?: HTMLElement | (() => HTMLElement | null) | null;
}

export type EscapeGuard = () => boolean;
export type EscapeFallback = () => boolean;

export class OverlayManager implements Disposable {
  private readonly _stack: OverlayEntry[] = [];
  private readonly _guards: EscapeGuard[] = [];
  private readonly _fallbacks: EscapeFallback[] = [];
  private readonly _disposables = new DisposableStore();

  get size(): number {
    return this._stack.length;
  }

  push(entry: OverlayEntry): Disposable {
    this._stack.push(entry);
    return toDisposable(() => {
      const idx = this._stack.indexOf(entry);
      if (idx >= 0) this._stack.splice(idx, 1);
    });
  }

  addGuard(guard: EscapeGuard): Disposable {
    this._guards.push(guard);
    return toDisposable(() => {
      const idx = this._guards.indexOf(guard);
      if (idx >= 0) this._guards.splice(idx, 1);
    });
  }

  registerFallback(handler: EscapeFallback): Disposable {
    this._fallbacks.push(handler);
    return toDisposable(() => {
      const idx = this._fallbacks.indexOf(handler);
      if (idx >= 0) this._fallbacks.splice(idx, 1);
    });
  }

  handleEscape(): boolean {
    for (const guard of this._guards) {
      if (guard()) return false;
    }
    if (this._stack.length > 0) {
      const top = this._stack[this._stack.length - 1];
      if (!top) return false;
      const result = top.close();
      if (result === false) return true;
      const idx = this._stack.indexOf(top);
      if (idx >= 0) this._stack.splice(idx, 1);
      const target = typeof top.restoreFocus === 'function' ? top.restoreFocus() : top.restoreFocus;
      focusSafely(target);
      return true;
    }
    for (const fallback of this._fallbacks) {
      if (fallback()) return true;
    }
    return false;
  }

  attach(target: EventTarget = document): Disposable {
    const sub = addDisposableListener(target, 'keydown', (rawEv) => {
      const ev = rawEv as KeyboardEvent;
      if (ev.key !== 'Escape') return;
      // An IME uses Escape to cancel its candidate list; do not dismiss overlays mid-composition.
      if (ev.isComposing) return;
      this.handleEscape();
    });
    return this._disposables.add(sub);
  }

  dispose(): void {
    this._stack.length = 0;
    this._guards.length = 0;
    this._fallbacks.length = 0;
    this._disposables.dispose();
  }
}
