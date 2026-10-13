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

/** A cell's watchers, and whether a write is being delivered to them. */
type Watch = { fns: Set<(next: any, prev: any) => void>; delivering: boolean };

const watchers = new WeakMap<object, Watch>();

const coreRuntime: StoreRuntime = {
  // Reads and writes go through `signal()`, so a configured reactive signal
  // tracks them; a write also calls the cell's watchers, when it has any.
  // A write made while one is delivered is not delivered inside it: the
  // running delivery goes on to it after, in order, until the cell holds
  // what was delivered. Delivered inside, a later watcher saw the new value,
  // then the old one, and ended on the old one, where the Vue store's effect
  // ends on the new one. tests/store-write-during-delivery.test.ts.
  cell<T>(initial: T) {
    const inner = signal(initial);
    const cell = {
      get value(): T { return inner.value; },
      set value(next: T) {
        const prev = inner.value;
        inner.value = next;
        const w = watchers.get(cell);
        if (w === undefined || next === prev || w.delivering) return;
        w.delivering = true;
        try {
          let was = prev;
          let now = next;
          for (;;) {
            for (const fn of w.fns) fn(now, was);
            const cur = inner.value;
            if (cur === now) break;
            was = now;
            now = cur;
          }
        } finally {
          w.delivering = false;
        }
      },
    };
    return cell;
  },
  watch(cell, fn) {
    let w = watchers.get(cell);
    if (w === undefined) { w = { fns: new Set(), delivering: false }; watchers.set(cell, w); }
    w.fns.add(fn);
    const own = w.fns;
    return () => { own.delete(fn); };
  },
};

export const defineChamberStore: DefineChamberStore = createStoreDefiner(coreRuntime);
