/**
 * vapor-chamber/store/core - the store with no Vue.
 *
 * The same store as `vapor-chamber/store` (one implementation, src/store-base.ts)
 * over the library's `signal()`: a plain `{ value }` cell, or a reactive one
 * once `configureAlienSignals()` (or `configureSignal()`) has run. Without Vue
 * there is no component scope, so every caller owns `$dispose()`; and no
 * `fieldRef`, which is a Vue ref - `$onField` gives the same per-field events.
 * docs/store.md, "Without Vue"; log s35.130.
 *
 *   import { defineChamberStore } from 'vapor-chamber/store/core';
 */
import { signal } from '../signal';
import { type DefineChamberStore, type StoreRuntime, createStoreDefiner } from '../store-base';

export type { ChamberStore, ChamberStoreOptions, StoreReducer, StoreRouter } from '../store-base';

const watchers = new WeakMap<object, Set<(next: any, prev: any) => void>>();

const coreRuntime: StoreRuntime = {
  // Reads and writes go through `signal()`, so a configured reactive signal
  // tracks them; a write also calls the cell's watchers, when it has any.
  cell<T>(initial: T) {
    const inner = signal(initial);
    const cell = {
      get value(): T { return inner.value; },
      set value(next: T) {
        const prev = inner.value;
        inner.value = next;
        const fns = watchers.get(cell);
        if (fns !== undefined && next !== prev) for (const fn of fns) fn(next, prev);
      },
    };
    return cell;
  },
  watch(cell, fn) {
    let fns = watchers.get(cell);
    if (fns === undefined) { fns = new Set(); watchers.set(cell, fns); }
    fns.add(fn);
    const own = fns;
    return () => { own.delete(fn); };
  },
};

export const defineChamberStore: DefineChamberStore = createStoreDefiner(coreRuntime);
