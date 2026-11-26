import { Emitter, type Event } from '../base/event.js';
import type { Disposable } from '../base/lifecycle.js';

export interface StoreChange<S> {
  readonly prev: Readonly<S>;
  readonly next: Readonly<S>;
}

export class Store<S> implements Disposable {
  private _state: S;
  private readonly _onChange = new Emitter<StoreChange<S>>();

  readonly onChange: Event<StoreChange<S>> = this._onChange.event;

  constructor(initial: S) {
    this._state = initial;
  }

  get(): Readonly<S> {
    return this._state;
  }

  set(next: S | ((prev: Readonly<S>) => S)): void {
    const prev = this._state;
    const resolved = typeof next === 'function' ? (next as (p: Readonly<S>) => S)(prev) : next;
    if (Object.is(prev, resolved)) return;
    this._state = resolved;
    this._onChange.fire({ prev, next: resolved });
  }

  patch(partial: Partial<S>): void {
    const prev = this._state;
    if (!prev || typeof prev !== 'object') {
      throw new Error('Store.patch requires an object state');
    }
    let changed = false;
    for (const key of Object.keys(partial) as (keyof S)[]) {
      if (!Object.is(prev[key], partial[key])) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    const next = { ...prev, ...partial };
    this._state = next;
    this._onChange.fire({ prev, next });
  }

  select<T>(
    selector: (state: Readonly<S>) => T,
    listener: (value: T, prev: T) => void,
    equals: (a: T, b: T) => boolean = Object.is,
  ): Disposable {
    let current = selector(this._state);
    return this.onChange(({ next }) => {
      const selected = selector(next);
      if (equals(current, selected)) return;
      const prev = current;
      current = selected;
      listener(selected, prev);
    });
  }

  dispose(): void {
    this._onChange.dispose();
  }
}
