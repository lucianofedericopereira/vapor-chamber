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
import { type ChamberStore, type ChamberStoreOptions as Options, type StoreReducer, type StoreRouter, type StoreRuntime, createStoreDefiner } from '../store-base';
import type { BaseBus } from '../command-bus';

export type { ChamberStore, StoreReducer, StoreRouter } from '../store-base';
/** The core store's options: `deep` is the Vue entry's (Vue's reactive view). */
export type ChamberStoreOptions<S extends object, R extends Record<string, StoreReducer<S> | null>> = Omit<Options<S, R>, 'deep'>;
export { saveTo, type PersistStorage, type SaveToOptions, type StorePersist } from '../store-persist';
export { shareTabs, type StoreShare } from '../store-share';

/** A cell's one watcher (a store starts one), and whether a write is being delivered to it. */
type Watch = { fn: (next: any, prev: any) => void; delivering: boolean };

/** A core cell: its value, and its watcher held on it (null until watched), read by every write. */
type CoreCell<T> = { value: T; w: Watch | null };

/** The core runtime over a cell maker: `signal()` for the public store, a plain cell for a form. */
const runtimeOver = (make: <T>(value: T) => { value: T }): StoreRuntime => ({
  // Reads and writes go through `make`'s cell (`signal()`: a configured
  // reactive signal tracks them); a write also calls the cell's watcher, when
  // it has one.
  // A write made while one is delivered is not delivered inside it: the
  // running delivery goes on to it after, in order, until the cell holds
  // what was delivered. Delivered inside, a later watcher saw the new value,
  // then the old one, and ended on the old one, where the Vue store's effect
  // ends on the new one. tests/store-write-during-delivery.test.ts.
  // The watcher is a field of the cell, in its literal: a write reads it with
  // no lookup (a WeakMap's get on every write of every core store, before).
  cell<T>(initial: T) {
    const inner = make(initial);
    const cell: CoreCell<T> = {
      w: null,
      get value(): T { return inner.value; },
      set value(next: T) {
        const prev = inner.value;
        inner.value = next;
        const w = cell.w;
        if (w === null || next === prev || w.delivering) return;
        w.delivering = true;
        try {
          let was = prev;
          let now = next;
          for (;;) {
            w.fn(now, was);
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
    const c = cell as CoreCell<unknown>;
    c.w = { fn, delivering: false };
    return () => { c.w = null; };
  },
});

export const defineChamberStore: <S extends object, R extends Record<string, StoreReducer<S> | null>>(
  id: string,
  options: ChamberStoreOptions<S, R>,
) => <B extends BaseBus>(bus: B, router?: StoreRouter) => ChamberStore<S, R, B> = /* @__PURE__ */ createStoreDefiner(runtimeOver(signal));

/** @internal The runtime over a plain cell: a form's store, and the library's own queues' state halves (`_stateHalf`). */
export const _plainRuntime: StoreRuntime = /* @__PURE__ */ runtimeOver(<T>(value: T) => ({ value }));

/**
 * @internal The core store over a plain cell: nothing reads its state
 * reactively, its readers take field cells (`_fieldCell`). A form's store.
 */
export const _definePlainStore: typeof defineChamberStore = /* @__PURE__ */ createStoreDefiner(_plainRuntime);
