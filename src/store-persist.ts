/**
 * vapor-chamber - a store's saved state: `saveTo`, the value of its `persist`.
 *
 * `defineChamberStore(id, { ..., persist: saveTo({ key }) })`. The store reads
 * its saved state when it is created and saves after each of its writes, once
 * per microtask. Everything that does it lives here, behind the value the app
 * imports, so a store without `persist` carries none of it. The store hands
 * over its cell and its write (src/store-base.ts, `opened`).
 * docs/store.md, Saved state; tests/store-persist.test.ts.
 */
import { DEV } from './dev';
import { _report } from './report';
import { isThenable } from './settled';
import type { StoreReducer } from './store-base';

/**
 * What a store's `persist` reads and writes: `localStorage`'s two methods. Each
 * may answer a promise, as `indexedDbStorage()` does: the store then reads the
 * saved state when it lands, and a rejection warns as a throw does.
 */
export type PersistStorage = {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): void | Promise<void>;
};

/** What `saveTo` takes. */
export type SaveToOptions<S> = {
  /** Storage key. Use a unique prefix per feature: `'vc:cart'`. */
  key: string;
  /** Default: `globalThis.localStorage`, looked up at each read and save. `indexedDbStorage()` for IndexedDB. */
  storage?: PersistStorage;
  /** Default: `JSON.stringify`. */
  serialize?: (state: S) => string;
  /** Default: `JSON.parse`, a parse failure read as nothing saved. Return null to start from `state()`. */
  deserialize?: (raw: string) => S | null;
  /** Accept a read state, or false to start from `state()` with a warning: a check of its shape. */
  validate?: (state: S) => boolean;
};

/** @internal A store's write: its reducer applied, as a ring step when the store keeps undo. */
export type StoreWrite<S> = (cmd: { target: any; payload?: any }, f: StoreReducer<S>) => S;

/** @internal What the store does with one opened persistence. */
export type PersistHooks<S> = {
  /** On the store's watcher: schedules the save. */
  save: () => void;
  /** While an async read is pending: a handler that keeps its write for the replay. Null otherwise. */
  keep: ((f: StoreReducer<S>) => (cmd: { target: any; payload?: any }) => S) | null;
  /** While an async read is pending: keeps a server's state for the replay. Null otherwise. */
  held: ((cmd: object, next: S) => void) | null;
  /** Resolves once an async read has landed and its replay written. Null for a sync read. */
  ready: Promise<void> | null;
};

/** The value of a store's `persist`, made by `saveTo`. */
export type StorePersist<S> = (init: () => S) => {
  /** The store's first state: the saved one, or `init()`. */
  first: S;
  /** Wires the store's cell, its lifetime and its write. */
  attach(cell: { value: S }, live: () => boolean, write: StoreWrite<S>): PersistHooks<S>;
};

/**
 * saveTo - a store's saved state, the value of its `persist` option: read when
 * the store is created, saved once per microtask after any of its writes,
 * whatever wrote it. An async storage is read when it answers; the writes made
 * before then are replayed on the saved state by the undo ring's rule (a
 * reducer runs again, a state set whatever came before is kept), and nothing is
 * saved before it lands. A missing `key` throws here.
 *
 * @example
 * defineChamberStore('cart', { state, reducers, persist: saveTo({ key: 'vc:cart' }) });
 */
export function saveTo<S>(options: SaveToOptions<S>): StorePersist<S> {
  const {
    key,
    serialize = (v: S) => JSON.stringify(v),
    deserialize = (s: string) => { try { return JSON.parse(s) as S; } catch { return null; } },
    validate,
  } = options;
  if (typeof key !== 'string' || key === '') {
    throw new TypeError(DEV ? '[vapor-chamber] saveTo needs key: the storage key the store saves under.' : 'persist: key');
  }

  function getStorage(): PersistStorage | null {
    if (options.storage) return options.storage;
    if (typeof (globalThis as any).localStorage !== 'undefined') return (globalThis as any).localStorage as Storage;
    return null;
  }

  const saveFailed = (e: unknown): void => { _report('warn', 'persist:failed:save', `failed to save key "${key}"`, e, { key }); };
  const loadFailed = (e: unknown): null => { _report('warn', 'persist:failed:load', `failed to load key "${key}"`, e, { key }); return null; };

  /** From the raw value to a state, through `validate`. A throw reaches the load warning. */
  function decode(raw: string | null): S | null {
    if (raw === null) return null;
    const state = deserialize(raw);
    if (state == null) return null;
    if (validate && !validate(state)) {
      _report('warn', 'persist:invalid:state', `validation failed for key "${key}", so the store starts fresh`, undefined, { key });
      return null;
    }
    return state;
  }

  // The lookup sits inside each `try`: with site data blocked, reading
  // `localStorage` throws, and `typeof` does not guard a getter that throws
  // (tests/storage-lookup-parity.test.ts).
  function read(): S | null | Promise<S | null> {
    let raw: string | null | Promise<string | null>;
    try {
      const store = getStorage();
      if (!store) return null;
      raw = store.getItem(key);
      if (!isThenable(raw)) return decode(raw as string | null);
    } catch (e) {
      return loadFailed(e);
    }
    return (raw as Promise<string | null>).then((r) => {
      try { return decode(r); } catch (e) { return loadFailed(e); }
    }, loadFailed);
  }

  function store(state: S): void {
    try {
      const done = getStorage()?.setItem(key, serialize(state));
      if (done) done.then(undefined, saveFailed);
    } catch (e) { saveFailed(e); }
  }

  return (init) => {
    const got = read();
    const loading = got !== null && isThenable(got) ? (got as Promise<S | null>) : null;
    const first = got === null || loading !== null ? init() : (got as S);
    return {
      first,
      attach(cell, live, write) {
        // Saved once per microtask, after any write: a microtask runs before
        // the next task, so an unload never falls between a write and its save
        // (HTML Standard, perform a microtask checkpoint). A state the store
        // already read or saved is not saved again, and nothing is saved
        // before an async read lands: that save would overwrite what was saved.
        let last: unknown = first;
        let due = false;
        // The writes made before an async read landed, [cmd, reducer] pairs.
        let early: unknown[] | null = loading !== null ? [] : null;
        const flush = (): void => {
          due = false;
          const s = cell.value;
          if (early !== null || s === last) return;
          last = s;
          store(s);
        };
        const save = (): void => {
          if (!due) { due = true; queueMicrotask(flush); }
        };
        let ready: Promise<void> | null = null;
        if (loading !== null) {
          ready = loading.then((saved) => {
            const writes = early as unknown[];
            early = null;
            if (!live()) return;
            if (saved === null) {
              if (writes.length !== 0) save();
              return;
            }
            let s: S = saved;
            try {
              for (let i = 0; i < writes.length; i += 2) {
                const c = writes[i] as { target: any; payload?: any };
                s = (writes[i + 1] as StoreReducer<S>)(s, c.target, c.payload);
              }
            } catch (e) {
              _report('warn', 'persist:failed:replay', `replaying the writes made before key "${key}" was read threw; the store keeps its state`, e, { key });
              save();
              return;
            }
            if (writes.length === 0) last = s;
            cell.value = s;
          });
        }
        return {
          save,
          keep: early === null ? null : (f) => (cmd) => {
            if (early !== null) early.push(cmd, f);
            return write(cmd, f);
          },
          held: early === null ? null : (cmd, next) => {
            if (early !== null) early.push(cmd, () => next);
          },
          ready,
        };
      },
    };
  };
}
