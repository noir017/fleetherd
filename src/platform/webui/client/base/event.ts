import { type Disposable, NOOP_DISPOSABLE, toDisposable } from './lifecycle.js';

export type Listener<T> = (event: T) => void;

export interface Event<T> {
  (listener: Listener<T>): Disposable;
}

export class Emitter<T> implements Disposable {
  private _listeners = new Set<Listener<T>>();
  private _disposed = false;

  readonly event: Event<T> = (listener: Listener<T>): Disposable => {
    if (this._disposed) return NOOP_DISPOSABLE;
    this._listeners.add(listener);
    return toDisposable(() => {
      this._listeners.delete(listener);
    });
  };

  get isDisposed(): boolean {
    return this._disposed;
  }

  hasListeners(): boolean {
    return this._listeners.size > 0;
  }

  fire(data: T): void {
    if (this._disposed || this._listeners.size === 0) return;
    // Snapshot so listeners adding/removing subscriptions mid-dispatch do not skew iteration.
    for (const listener of [...this._listeners]) {
      if (this._disposed) break;
      listener(data);
    }
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this._listeners.clear();
  }
}

export function once<T>(event: Event<T>, listener: Listener<T>): Disposable {
  let fired = false;
  const sub = event((data) => {
    if (fired) return;
    fired = true;
    sub.dispose();
    listener(data);
  });
  return sub;
}

export function mapEvent<I, O>(event: Event<I>, map: (input: I) => O): Event<O> {
  return (listener: Listener<O>): Disposable => event((input) => listener(map(input)));
}
