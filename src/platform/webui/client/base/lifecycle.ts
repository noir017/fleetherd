export interface Disposable {
  dispose(): void;
}

export const NOOP_DISPOSABLE: Disposable = Object.freeze({
  dispose(): void {
    // intentionally empty
  },
});

export function toDisposable(fn: () => void): Disposable {
  let disposed = false;
  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      fn();
    },
  };
}

export function disposeAll(items: readonly Disposable[]): void {
  const errors: unknown[] = [];
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (!item) continue;
    try {
      item.dispose();
    } catch (err) {
      errors.push(err);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'Multiple errors during dispose');
}

export function combineDisposables(...items: readonly Disposable[]): Disposable {
  return toDisposable(() => disposeAll(items));
}

export class DisposableStore implements Disposable {
  private readonly _items: Disposable[] = [];
  private _disposed = false;

  get isDisposed(): boolean {
    return this._disposed;
  }

  get size(): number {
    return this._items.length;
  }

  add<T extends Disposable>(item: T): T {
    if ((item as Disposable) === this) {
      throw new Error('Cannot add a DisposableStore to itself');
    }
    if (this._disposed) {
      item.dispose();
      return item;
    }
    this._items.push(item);
    return item;
  }

  delete(item: Disposable): boolean {
    const idx = this._items.indexOf(item);
    if (idx < 0) return false;
    this._items.splice(idx, 1);
    return true;
  }

  clear(): void {
    if (this._items.length === 0) return;
    const snapshot = this._items.splice(0, this._items.length);
    disposeAll(snapshot);
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this.clear();
  }
}

export class MutableDisposable<T extends Disposable = Disposable> implements Disposable {
  private _value: T | undefined;
  private _disposed = false;

  get value(): T | undefined {
    return this._disposed ? undefined : this._value;
  }

  set value(next: T | undefined) {
    if (this._disposed) {
      next?.dispose();
      return;
    }
    if (next === this._value) return;
    const prev = this._value;
    this._value = next;
    prev?.dispose();
  }

  clear(): void {
    this.value = undefined;
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    const prev = this._value;
    this._value = undefined;
    prev?.dispose();
  }
}
