/**
 * vapor-chamber - I/O plugins (async/storage/network)
 *
 * persist, createChannel. Retry is the async bus's own (createAsyncCommandBus's
 * `retry` option).
 */

import type { ActionFilter } from './action-filter';
import type { ActionScope, Command, Plugin } from './command-bus';
import { isThenable, onSettled } from './settled';
import { DEV } from './dev';

// ---------------------------------------------------------------------------
// Persistence plugin
// ---------------------------------------------------------------------------

/**
 * What persist reads and writes: `localStorage`'s three methods. Each may
 * answer a promise, as `indexedDbStorage()` does: then read with `hydrate()`,
 * and a rejection warns as a throw does.
 */
export type PersistStorage = {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): void | Promise<void>;
  removeItem(key: string): void | Promise<void>;
};

export type PersistOptions<T = any> = {
  /**
   * Storage key. Use a unique prefix per feature to avoid collisions.
   * @example 'vc:cart', 'vc:user-prefs'
   */
  key: string;
  /** Function that returns the current state to be saved after each command. */
  getState: () => T;
  /** Serializer. Default: JSON.stringify */
  serialize?: (state: T) => string;
  /**
   * Deserializer. Return null/undefined to skip rehydration.
   * Default: JSON.parse
   */
  deserialize?: (raw: string) => T | null;
  /**
   * Validate deserialized state before returning from load().
   * Return true to accept, false to reject (load() returns null).
   * Use this to reject stale or structurally invalid persisted state
   * after deploys that change the shape of persisted data.
   *
   * @example
   * persist({
   *   key: 'vc:cart',
   *   getState: () => cart.value,
   *   validate: (state) => Array.isArray(state.items) && typeof state.total === 'number',
   * })
   */
  validate?: (state: T) => boolean;
  /** Which actions trigger a save. Default: all successful dispatches. */
  filter?: (cmd: Command) => boolean;
  /** The only actions the bus runs persist on: an {@link ActionScope}, `'cart*'` covers `cart$reset` and `cartAdd$undo`. Default: every action. tests/persist-actions.test.ts. */
  actions?: ActionScope;
  /** Selects actions by name, ANDed with `actions`: an {@link ActionFilter} (`createActionFilter`). */
  actionFilter?: ActionFilter;
  /**
   * Storage backend. Default: globalThis.localStorage
   * Pass `sessionStorage` for session-scoped persistence, or
   * `indexedDbStorage()` for IndexedDB (read it with `hydrate()`).
   */
  storage?: PersistStorage;
  /**
   * When true, collapse back-to-back saves within the same microtask into one.
   * Trades 1 microtask of latency for one `getState()` + `JSON.stringify()` +
   * `setItem()` cycle per burst, regardless of how many dispatches triggered it.
   *
   * Use when the same state is touched by many rapid commands (form input,
   * scroll tracking, batched cart updates). Default: false (every successful
   * dispatch saves immediately).
   *
   * @example
   * persist({ key: 'vc:cart', getState: () => cart.value, coalesce: true })
   */
  coalesce?: boolean;
};

/**
 * persist - auto-save state to localStorage (or custom storage) after each command.
 *
 * `load()` reads a synchronous storage. `hydrate()` reads either kind, and
 * is the one for an async storage such as `indexedDbStorage()`: call it
 * before the first dispatch, or a save may land before the read.
 *
 * @example
 * const cartPersist = persist({ key: 'vc:cart', getState: () => cartState.value })
 * bus.use(cartPersist)
 * const saved = cartPersist.load()
 */
export function persist<T>(options: PersistOptions<T>): Plugin & {
  /** The saved state, or null. Throws a TypeError on a storage that answers a promise: use `hydrate()`. */
  load(): T | null;
  /** The saved state, or null, from a sync or an async storage. Never rejects. */
  hydrate(): Promise<T | null>;
  save(): void;
  clear(): void;
} {
  const {
    key,
    getState,
    serialize = (v) => JSON.stringify(v),
    deserialize = (s) => { try { return JSON.parse(s) as T; } catch { return null; } },
    validate,
    filter,
    coalesce = false,
  } = options;
  // A configuration mistake throws at setup: without it, every save() would
  // fail and nothing would ever be stored.
  if (typeof getState !== 'function') {
    throw new TypeError(
      DEV ? `[vapor-chamber] persist({ key: "${key}" }) needs getState: a function returning the state to save after each command.` : 'persist: getState',
    );
  }

  function getStorage(): PersistStorage | null {
    if (options.storage) return options.storage;
    if (typeof (globalThis as any).localStorage !== 'undefined') {
      return (globalThis as any).localStorage as Storage;
    }
    return null;
  }

  const saveFailed = (e: unknown): void => { console.warn(`[vapor-chamber] persist: failed to save key "${key}":`, e); };
  const loadFailed = (e: unknown): null => { console.warn(`[vapor-chamber] persist: failed to load key "${key}":`, e); return null; };
  const clearFailed = (e: unknown): void => { console.warn(`[vapor-chamber] persist: failed to clear key "${key}":`, e); };

  // The lookup sits inside each `try`: with site data blocked, reading
  // `localStorage` throws, and `typeof` does not guard a getter that throws
  // (tests/storage-lookup-parity.test.ts). A sync storage answers undefined,
  // an async one a promise, whose rejection warns as a throw does.
  function save(): void {
    try {
      const done = getStorage()?.setItem(key, serialize(getState()));
      if (done) done.then(undefined, saveFailed);
    } catch (e) { saveFailed(e); }
  }

  /** What load() and hydrate() share once the raw value is in hand. */
  function read(raw: string | null): T | null {
    if (raw === null) return null;
    const state = deserialize(raw);
    if (state == null) return null;
    if (validate && !validate(state)) {
      console.warn(`[vapor-chamber] persist: validation failed for key "${key}" - returning null.${DEV ? ' Persisted state may be stale after a deploy.' : ''}`);
      return null;
    }
    return state;
  }

  function load(): T | null {
    let pending: PromiseLike<unknown>;
    try {
      const store = getStorage();
      if (!store) return null;
      const raw = store.getItem(key);
      if (!isThenable(raw)) return read(raw);
      pending = raw;
    } catch (e) {
      return loadFailed(e);
    }
    // A null here would read as "nothing saved", and the next save would
    // overwrite what was saved. The read itself is dropped, not left to reject.
    pending.then(undefined, () => {});
    throw new TypeError(
      DEV ? `[vapor-chamber] persist({ key: "${key}" }): this storage answers a promise, so load() cannot return the state. Use \`await hydrate()\`.` : 'persist: hydrate',
    );
  }

  async function hydrate(): Promise<T | null> {
    try {
      const store = getStorage();
      return store ? read(await store.getItem(key)) : null;
    } catch (e) {
      return loadFailed(e);
    }
  }

  function clear(): void {
    try {
      const done = getStorage()?.removeItem(key);
      if (done) done.then(undefined, clearFailed);
    } catch (e) { clearFailed(e); }
  }

  // Coalesced save scheduling - flushes one save per microtask burst.
  let _saveScheduled = false;
  function scheduleSave(): void {
    if (_saveScheduled) return;
    _saveScheduled = true;
    queueMicrotask(() => { _saveScheduled = false; save(); });
  }

  const plugin: Plugin = coalesce
    ? (cmd, next) => onSettled(next(), (result) => {
        if (result.ok && (!filter || filter(cmd))) scheduleSave();
        return result;
      })
    : (cmd, next) => onSettled(next(), (result) => {
        if (result.ok && (!filter || filter(cmd))) save();
        return result;
      });

  return Object.assign(plugin, { id: 'persist', actions: options.actions, actionFilter: options.actionFilter, load, hydrate, save, clear });
}

// ---------------------------------------------------------------------------
// createChannel (BroadcastChannel over an event channel)
// ---------------------------------------------------------------------------

/**
 * The event channel `createChannel` reads. Structural on purpose: this module imports
 * nothing from `./fast-lane`, so a consumer who never syncs pays no bytes for
 * it, and anything with the same two methods can be bridged.
 */
export type ChannelLane = {
  on(event: string, listener: (data: any) => void): () => void;
  emit(event: string, data: any): void;
};

export type ChannelOptions = {
  /**
   * BroadcastChannel name. All tabs using the same name receive each other's facts.
   * @example 'vapor-chamber:app'
   */
  channel: string;
  /** The event channel to bridge - `createFastLane()`, or anything of that shape. */
  lane: ChannelLane;
  /**
   * Which events cross to the other tabs. Named rather than inferred: the fast
   * lane has no wildcard subscription by design, and naming them is the point
   * - the wire contract is declared, not guessed at from an action prefix.
   */
  events: string[];
  /**
   * Called when a fact arrives from another tab, before it is re-emitted
   * locally. Return false to drop it.
   */
  onReceive?: (event: string, data: unknown) => boolean | void;
};

type ChannelMessage = { __vc: true; event: string; data: any };

/**
 * createChannel - mirror emitted FACTS to every other same-origin context
 * over a BroadcastChannel.
 *
 * WHAT CROSSES THE WIRE IS A FACT, NOT A COMMAND, and that is the whole design.
 * Re-dispatching each command in the receiving tab replicates INTENT: each tab
 * re-runs the handler and re-derives the outcome. Three things fall out of
 * that, measured:
 *
 *   - A handler that is not deterministic does not mirror. Two tabs running
 *     the same `cartAdd` minted `A-line-1-936891` and `B-line-1-675288` and
 *     stayed different forever.
 *   - A tab seeded differently stays different: A ended at 1, B at 6.
 *   - A handler that dispatches a nested command applied that derivation
 *     TWICE per tab, because each tab derived its own and then received the
 *     peer's. Suppressing the receive side alone did not fix it (6 runs became
 *     5, not 4): the ORIGINATING tab was still broadcasting its derivations.
 *     Fixing that by inference needs the core to distinguish a root dispatch
 *     from a derived one, which it does not, and adding a counter to do so
 *     would tax every dispatch on the bus.
 *
 * Emitting the fact removes the question instead of answering it. The app says
 * what crosses by emitting it; a derivation is not a fact unless the app says
 * so, so there is nothing to infer and no counter to pay for. The receiving tab
 * APPLIES the values the sender computed rather than recomputing them, which is
 * the ordinary CQRS split - a command is intent, an event is something that
 * already happened - and it is what makes a non-deterministic handler a
 * non-issue.
 *
 * IT ALSO LEAVES THE DISPATCH CHAIN. As a plugin this cost more than half the
 * bus's dispatch throughput, on every dispatch of every action, whether or not
 * it synced. Measured over 11 shuffled rounds of 200,000 dispatches with
 * `gc()` per round, against a byte-identical self-control arm: bare bus 1.000,
 * as a plugin 0.459 (control 0.454), as an `onAfter` listener 0.538, and on the
 * fast lane 0.867. The correctness fix and the performance fix are the same
 * change.
 *
 * WHAT IT STILL DOES NOT DO. Facts mirror, seeds do not: a tab that starts from
 * different state stays different unless the facts are absolute ("the count is
 * 2") rather than relative ("add one"). And a payload crosses through the
 * structured clone algorithm, so it cannot carry functions - see the DEV
 * warning below.
 *
 * @example
 * const lane = createFastLane()
 * lane.on('cartAdded', (fact) => applyToCart(fact))   // local AND remote land here
 *
 * bus.register('cartAdd', (cmd) => {
 *   const fact = computeAdd(cmd.target)
 *   applyToCart(fact)
 *   lane.emit('cartAdded', fact)                      // this is what crosses tabs
 * })
 *
 * const tabSync = createChannel({ channel: 'vapor-chamber:app', lane, events: ['cartAdded'] })
 * tabSync.dispose() // on unmount
 */
export function createChannel(options: ChannelOptions): {
  /** Stops mirroring and closes the BroadcastChannel; `isOpen()` is then false. */
  dispose(): void;
  isOpen(): boolean;
} {
  const { channel, lane, events, onReceive } = options;

  let bc: BroadcastChannel | null = null;

  // Echo suppression is a plain boolean, and it is airtight: a lane `emit` is
  // a tight indexed loop over the subscriber list with no promise, no plugin
  // chain and no envelope, so it completes inside the `try`. (A flag around a
  // bus dispatch would not be: on the async bus the chain runs a microtask
  // after the `finally` has lowered it.)
  let applying = false;

  function open(): void {
    if (typeof BroadcastChannel === 'undefined') return;
    bc = new BroadcastChannel(channel);

    bc.onmessage = (event: MessageEvent<ChannelMessage>) => {
      const msg = event.data;
      if (!msg?.__vc) return;
      if (onReceive && onReceive(msg.event, msg.data) === false) return;
      applying = true;
      try { lane.emit(msg.event, msg.data); }
      finally { applying = false; }
    };
  }

  open();

  const offs: Array<() => void> = [];
  for (const name of events) {
    offs.push(lane.on(name, (data: unknown) => {
      if (applying) return;
      try {
        bc?.postMessage({ __vc: true, event: name, data } satisfies ChannelMessage);
      } catch (e) {
        // A payload that cannot be structured-cloned (a function, a class
        // instance with methods, a DOM node) throws DataCloneError here. The
        // local tab has already applied its own fact by now, so this is a
        // remote-only failure and must not take the local emit down with it -
        // a listener that throws would stop the rest of the lane's fan-out.
        // DEV-gated like the call-site warnings above and unlike persist's
        // storage warnings: a non-cloneable payload is an authoring mistake
        // fixed at build time, not a condition a deployed app runs into.
        if (DEV) {
          console.warn(`[vapor-chamber] createChannel: "${name}" did not cross - its payload is not structured-cloneable (no functions, class instances or DOM nodes):`, e);
        }
      }
    }));
  }

  return {
    dispose(): void {
      for (const off of offs) off();
      offs.length = 0;
      bc?.close();
      bc = null;
    },
    isOpen(): boolean { return bc !== null; },
  };
}
