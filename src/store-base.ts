/**
 * vapor-chamber - the store, once, for both entries.
 *
 * `vapor-chamber/store` (Vue) and `vapor-chamber/store/core` (no Vue) are this
 * implementation over a different runtime (`StoreRuntime`): the rules - actions
 * as commands, the registry per bus, takeover, undo, field events, sharing,
 * the coded refusals - exist once. The design notes on the store
 * are in src/store.ts and docs/store.md.
 */

import type { BaseBus, Command, CommandMeta, RegisterOptions } from './command-bus';
import type { ResultOn } from './shared-bus';
import { _failures } from './failure';
import { _isLibraryAction, _registerAsLibrary } from './library-names';
import { _appliedRemotely, _hearers, _hotUpdate, _registryEntry, _sendsOn, _storesOf, type RegistryEntry, type StoreFact, type TabHearer } from './applied-remotely';
import { DEV } from './dev';
import { _report } from './report';
import { type FastLane, createFastLane } from './fast-lane';
import type { PersistHooks, StorePersist, StoreWrite } from './store-persist';
import type { StateShare, StoreShare, TabSend, WireCommand } from './store-share';

// Coded like every library failure (owner:condition:subject); the owner is the
// feature name. The core's shape: the message states the fact, every value in
// it is also in `context`, and the advice is DEV only (docs/contract.md rule 5,
// 4.5). tests/store-review.test.ts.
const storeFail = _failures('store');

/** A reducer: current state plus the dispatched target, returning the NEXT state. */
export type StoreReducer<S> = (state: S, target: any, payload?: any) => S;

/** What defineChamberStore takes. */
export type ChamberStoreOptions<S extends object, R extends Record<string, StoreReducer<S> | null>> = {
  /**
   * The store's reducers: each key names an action (`add` on store `cart`
   * dispatches `cartAdd`, and becomes the method `cart.add`), each value
   * returns the next state from the current one and the call's target and
   * payload. `actions` elsewhere in the library is an ActionScope (names),
   * so the map has its own word. `null` is an action a
   * transport sends with no local change: its state comes from `answer` or
   * the server's `stores`. A function for a sent action is refused unless the
   * store is `optimistic` (`core:invalid:handler`).
   * tests/register-shadow-check.test.ts.
   */
  reducers: R;
  /**
   * A FACTORY, never a literal. Two stores of the same shape must not share a
   * nested reference, and `$reset` must not hand back the object a previous
   * reset already mutated - both are the same bug, and a factory makes it
   * unrepresentable.
   */
  state: () => S;
  /**
   * URL-worthy fields (pattern 4B): `storeField -> query key`. The store does
   * NOT own a signal for these - reads and writes both go through the router,
   * so the URL stays the single writer and a shared link reproduces the view.
   *
   * The router arrives as an ARGUMENT rather than an import: a store with no
   * URL fields never pulls the router into its graph, which the boundary test
   * pins.
   */
  url?: Record<string, string>;
  /** Make actions and `$reset` undoable through `history` (docs/store.md, Undo). Off by default. */
  undo?: boolean;
  /**
   * Write the state once per microtask: each write of the store's own
   * commands chains on the pending state, and an action's result is that
   * state. For a list a burst of dispatches fills. A state from outside (a
   * tab's, a server's, a seed) is written at once, after the pending one.
   * Refused with `undo`. tests/store-coalesce.test.ts,
   * tests/store-facts-lane.test.ts.
   */
  coalesce?: boolean;
  /**
   * The Vue entry only: `state.value` is Vue's reactive view of the state, so
   * a nested field mutated in place (a `v-model`) is tracked by Vue readers.
   * The store keeps the raw state, and follows writes by identity: a
   * mutation in place is not a write. tests/store-deep.test.ts.
   */
  deep?: boolean;
  /**
   * `saveTo({ key })`: save the store's state under `key` and read it back
   * when the store is created. The saved state is its first state, `$reset`
   * still gives `state()`. Saved once per microtask after any write of the
   * store (docs/store.md, Saved state). Imported, so a store without it
   * carries none of it. tests/store-persist.test.ts.
   */
  persist?: StorePersist<S>;
  /**
   * `shareTabs()`: the store across the tabs of one origin. Each write
   * crosses as its command and each tab applies it, an undo crosses as the
   * id of the command it reverses, and a tab opened later asks for the state
   * (docs/store.md, Across tabs). Imported, so a store without it carries
   * none of it. tests/store-propagate-undo.test.ts.
   */
  share?: StoreShare<S>;
  /**
   * The next state from a transport's answer to one of the store's actions:
   * a transport sends the action, the reducer does not run, and the store
   * takes `answer(state, value, cmd)`, the value being the answer's `state`.
   * `(_, value) => value` when the server answers the store's whole state.
   * Without it, a sent action leaves the state as it is (docs/store.md,
   * A store behind a transport). tests/store-bridged-answer.test.ts.
   */
  answer?: (state: S, value: unknown, cmd: { action: string; target: any; payload?: any }) => S;
  /**
   * The server's version of a state, a number that grows with every write it
   * applies: an answer is written only when its version is higher than the
   * one the store holds, so an older answer arriving last never replaces a
   * newer one. A version that is not a finite number falls back to arrival
   * order. Without it, the last answer to arrive wins.
   * tests/store-answer-version.test.ts.
   */
  version?: (state: S) => number;
  /**
   * An action a transport sends applies its reducer at once, before the
   * server answers: a failure rolls it back (the later steps rebased), the
   * answer replaces it, and a plugin's refusal never shows it. The dispatch
   * answers an `Accepted` (`RegisterOptions.optimistic`). History undoes it
   * only with `undo`. Refused with `coalesce`. tests/store-optimistic.test.ts.
   */
  optimistic?: boolean;
  /**
   * The store's sent actions go one at a time, in order, so the server
   * applies and answers them in the order they were sent, reads included
   * (`RegisterOptions.exclusive`, one key: the store's id). An action no
   * transport sends runs at once. tests/store-optimistic.test.ts.
   */
  exclusive?: boolean;
};

/** The router surface pattern 4B needs, named structurally so this module
 *  imports nothing from `src/router`. */
export type StoreRouter = {
  currentRoute: { value: { location: { query: Record<string, string | string[]> } } };
  setQuery: (patch: Record<string, unknown>, opts?: { history?: 'push' | 'replace' }) => void;
};

/** A store on bus `B`: its actions and `$reset` return what `B`'s dispatch
 *  returns (`ResultOn`). tests/store-result-types.test.ts. */
export type ChamberStore<S extends object, R extends Record<string, StoreReducer<S> | null>, B extends BaseBus = BaseBus> = {
  readonly $id: string;
  /** Read-only by construction: there is no setter, so a direct write throws in
   *  strict mode. The bus is the only mutation channel. */
  readonly state: { readonly value: S };
  /** URL-backed fields (4B), absent when no `url` map was declared. */
  readonly url: Record<string, { readonly value: string | undefined; set: (next: unknown) => void }>;
  /** Dispatches `<id>$reset`, which sets `state()` afresh: a command like any
   *  action, so plugins, listeners and history see it. Returns the dispatch
   *  result, on an async bus its promise. */
  $reset: () => ResultOn<B>;
  /** Call `fn` with a field's new value each time a write changes it (by
   *  identity), the store's own keyed event; returns the unsubscribe. A store
   *  with no subscriber writes as it would without. docs/store.md. */
  $onField: <K extends keyof S & string>(key: K, fn: (value: S[K]) => void) => () => void;
  /** Resolves once the store holds the state it starts from: its saved state
   *  read (`persist` on an async storage), its tabs' state taken (`share`), or
   *  both. At once for a store with neither. Never waits on a field event, and
   *  a failed read or a store disposed early resolves too.
   *  tests/store-ready.test.ts. */
  readonly $ready: Promise<void>;
  $dispose: () => void;
} & { [K in keyof R]: (target?: any, payload?: any) => ResultOn<B> };

/**
 * A store plus the bookkeeping its LIFETIME needs.
 *
 * `holders` is the count of live component scopes using this store, and it is
 * the whole reason this is an entry rather than the store alone. A store is
 * shared by construction - the registry hands the same object to every caller
 * of `useCart(bus)` - so disposal cannot be wired to whichever scope happened
 * to create it FIRST, or:
 *
 *   component A mounts   -> creates the store, registers the bus handlers
 *   component B mounts   -> gets the same store back
 *   component A unmounts -> $dispose(): handlers unregistered, registry cleared
 *   component B, still on screen, calls cart.add(2)
 *
 * B holds a live object whose every action returns `ok: false` and whose state
 * never changes again - silently. tests/store-form-sharing.test.ts pins all
 * three paths: first holder out, last holder out, and no scope
 * at all. Two components sharing a store is not an edge case, it is what a
 * store IS.
 */
type StoreEntry = RegistryEntry;

/**
 * DEV: each store's definition `state()`, by its entry, so a hot update tells
 * a key the edit removed from one the app added. Apart from the entry, so a
 * build keeps the entry as it is.
 */
const declaredOf = /* @__PURE__ */ new WeakMap<StoreEntry, () => unknown>();

/** The command a seeded state is written under: a `$` name no reducer has. */
const SEEDED = { action: '$seeded', target: undefined };

/** A write `coalesce` does not hold: nothing to land. */
const landed = (): void => {};

/** `$ready` of a store whose state is final at creation: one promise for them all. */
const DONE: Promise<void> = /* @__PURE__ */ Promise.resolve();

/**
 * Join the running scope to a store's holder count, and leave when the scope
 * ends. The LAST holder out disposes, not the first one in. A caller outside
 * any scope has no lifetime to hook: it PINS the store and owns `$dispose()`
 * (docs/store.md), so scoped holders leaving do not dispose it under that
 * owner, the contract every composable here has.
 * tests/store-unscoped-holder.test.ts.
 */
function join(scope: StoreRuntime['scope'], entry: StoreEntry): void {
  if (!scope?.active()) {
    entry.pinned = true;
    return;
  }
  entry.holders++;
  scope.onDispose(() => {
    entry.holders--;
    if (entry.holders <= 0 && !entry.pinned) (entry.store as { $dispose(): void }).$dispose();
  });
}

/** The store's own members: an action key equal to one would replace it. */
const MEMBERS = new Set(['$id', 'state', 'url', '$reset', '$dispose', '$onField', '$ready']);

/** How many steps a store with `undo: true` keeps (a power of two); history's default is 50. */
const UNDO_RING = 256;

/** Marks an undone step in the ring: no command equals it, and a replay skips it. */
const UNDONE = {};

/** The ring's command for a state another tab sent: no action replays it, so a rebase keeps it. Its fact skips a server's checks. */
const RECEIVED = { action: '', target: undefined };

/**
 * DEV, the double reducer run: true only when `a` and `b` give the same JSON,
 * without building either string where it can. Two identical references are
 * equal with no look inside, so a reducer in the immutable style is walked
 * only where it rebuilt. Plain arrays compare slot by slot, plain objects key
 * by key in order, by JSON's rules (a slot's `undefined`, function or symbol
 * is `null`, a property holding one is left out). Any other pair is its two
 * strings. False is not proof of a difference: the caller then compares the
 * two whole states as strings. tests/store-reducer-twice.test.ts.
 */
const dropped = (v: unknown): boolean => v === undefined || typeof v === 'function' || typeof v === 'symbol';
function sameJson(a: any, b: any): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (typeof a.toJSON === 'function' || typeof b.toJSON === 'function') return JSON.stringify(a) === JSON.stringify(b);
  const arr = Array.isArray(a);
  if (arr !== Array.isArray(b)) return false;
  if (arr) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!sameJson(dropped(a[i]) ? null : a[i], dropped(b[i]) ? null : b[i])) return false;
    }
    return true;
  }
  const pa = Object.getPrototypeOf(a);
  const pb = Object.getPrototypeOf(b);
  if ((pa !== Object.prototype && pa !== null) || (pb !== Object.prototype && pb !== null)) return JSON.stringify(a) === JSON.stringify(b);
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  for (let i = 0, j = 0; ; i++, j++) {
    while (i < ka.length && dropped(a[ka[i]])) i++;
    while (j < kb.length && dropped(b[kb[j]])) j++;
    if (i === ka.length || j === kb.length) return i === ka.length && j === kb.length;
    if (ka[i] !== kb[j] || !sameJson(a[ka[i]], b[kb[j]])) return false;
  }
}

/** DEV: a store a hot update replaces: its state, and its definition's `state()`. */
type Hot = { state: unknown; declared: (() => unknown) | undefined };

/**
 * DEV: the stores a hot update replaces, on one bus, by id; undefined
 * outside an update. The plugin is serve-only, so a build never has the mark.
 */
function hotStates(bus: BaseBus): Map<string, Hot> | undefined {
  const hot = _hotUpdate() as WeakMap<BaseBus, Map<string, Hot>> | undefined;
  if (hot === undefined) return undefined;
  let states = hot.get(bus);
  if (states === undefined) hot.set(bus, (states = new Map()));
  return states;
}

/**
 * DEV: a store's first state inside a hot update. The store it takes over
 * (one created at module load) or the one disposed in the update (one a
 * component held) carries its state. tests/store-hot-update.test.ts.
 */
function hotFirst<S extends object>(bus: BaseBus, id: string, taken: StoreEntry | undefined, first: S): S {
  const hot = hotStates(bus);
  if (hot === undefined) return first;
  const old = taken !== undefined && taken.cell !== null ? { state: taken.cell.value, declared: declaredOf.get(taken) } : hot.get(id);
  return old !== undefined && old.state !== undefined ? carry(first, old.state, old.declared?.()) as S : first;
}

/** A plain object: its keys are a state's shape, matched by a hot update. */
const plain = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

/**
 * The state carried into an edited store, matched to its new `state()` by
 * key at every level of plain objects, as Pinia 4.1's hot update does. A key
 * both have keeps the old value. A key the edit adds gets its declared value.
 * A key the old `state()` declared and the edit removed goes. A key the app
 * added at runtime stays, so a dictionary declared `{}` keeps its entries.
 * Anything else (an array, a class instance, a reducer's non-object) carries
 * as it is.
 */
function carry(fresh: unknown, old: unknown, declared: unknown): unknown {
  if (!plain(old) || !plain(fresh)) return old;
  const was = plain(declared) ? declared : undefined;
  const next: Record<string, unknown> = {};
  for (const k of Object.keys(old)) {
    if (Object.hasOwn(fresh, k)) next[k] = carry(fresh[k], old[k], was?.[k]);
    else if (was === undefined || !Object.hasOwn(was, k)) next[k] = old[k];
  }
  for (const k of Object.keys(fresh)) if (!Object.hasOwn(old, k)) next[k] = fresh[k];
  return next;
}

/** A store's field events: each field a write changed, by identity, to its subscribers. */
function notifyFields(lane: FastLane, next: object, prev: object): void {
  for (const k in next) {
    const v = (next as Record<string, unknown>)[k];
    if (v !== (prev as Record<string, unknown>)[k]) lane.emit(k, v);
  }
}

const fieldCells = /* @__PURE__ */ new WeakMap<object, Map<string, { value: unknown }>>();

/**
 * @internal A field of a store as its own cell, over the store's `$onField`
 * events: a reader of one field re-runs when that field changes, not on every
 * write of the store. One cell per store and field, for the store's life,
 * made by `make` (Vue's `shallowRef` for `fieldRef`, the library's `signal()`
 * for a form). Against a computed per field, it pays off from a few readers
 * (docs/store.md).
 */
export function _fieldCell<S extends object, K extends keyof S & string>(
  store: { readonly state: { readonly value: S }; $onField: (key: K, fn: (value: S[K]) => void) => () => void },
  key: K,
  make: <V>(value: V) => { value: V },
): { readonly value: S[K] } {
  let cells = fieldCells.get(store);
  if (cells === undefined) { cells = new Map(); fieldCells.set(store, cells); }
  let cell = cells.get(key);
  if (cell === undefined) {
    const made = make<unknown>(store.state.value[key]);
    store.$onField(key, (value) => { made.value = value; });
    cells.set(key, made);
    cell = made;
  }
  return cell as { readonly value: S[K] };
}

/** A command as it crosses to another tab (src/store-share.ts): what applies it, and its id. */
function wireOf(cmd: Command): WireCommand {
  const m = cmd.meta as CommandMeta;
  return { action: cmd.action, target: cmd.target, payload: cmd.payload, id: m.id, causationId: m.causationId, ts: m.ts };
}

/**
 * Another tab's command, in the bus's own command literal and stampMeta's
 * field order, so history and the store read one hidden class
 * (docs/V8-RULES.md rule 1, tests/v8-shapes.test.ts).
 */
function received(w: WireCommand): Command {
  return {
    action: w.action, target: w.target, payload: w.payload,
    meta: { ts: w.ts, id: w.id, correlationId: w.causationId, causationId: w.causationId, origin: undefined, idempotencyKey: undefined, response: undefined, request: undefined },
    signal: undefined,
  };
}

/** `cart` + `add` -> `cartAdd`, the house convention `useCommandGroup` uses. */
function actionName(id: string, key: string): string {
  return id + key.charAt(0).toUpperCase() + key.slice(1);
}

/**
 * What a store entry gives the one implementation below: the state cell, a
 * way to watch it, and the holder lifetime when there is one. The Vue entry
 * passes `shallowRef`, an `effect` and Vue's scopes; the Vue-less entry
 * (`vapor-chamber/store/core`) a cell over `signal()` and no scope.
 */
export type StoreRuntime = {
  cell<T>(initial: T): { value: T };
  /** `deep`: the view a reader gets of the state (Vue's `reactive`). The core entry has none. */
  view?<T>(value: T): T;
  /** Call `fn(next, prev)` after each write that changes the cell; returns the
   *  stop. A store starts one watch on its cell and stops it before another
   *  (tests/store-one-watcher.test.ts). A write made during a call is delivered
   *  after it, in order, and the last call is with the cell's value
   *  (tests/store-write-during-delivery.test.ts). */
  watch<T>(cell: { value: T }, fn: (next: T, prev: T) => void): () => void;
  scope?: { active(): boolean; onDispose(fn: () => void): void };
};

/** @internal What a state half's owner gives it, read when a write runs. */
export type HalfOwner<S> = {
  /** The owner's write of a reducer, which persist replays on a state read late. */
  write: StoreWrite<S>;
  /** Lands a write the owner holds, before another tab's state is written. Read only with `share`. */
  land?: () => void;
  /** Writes another tab's state, merged by its owner (the outbox). Read only with `share`. */
  put?: (next: S) => void;
};

/** @internal A state half: a cell, its one watcher, and what the watcher feeds. */
export type StateHalf<S> = {
  readonly cell: { value: S };
  /** Persist's hooks, while an async read is pending (`keep`, `held`); null without `persist`. */
  readonly hooks: PersistHooks<S> | null;
  /** Resolves when an async read of the saved state has landed; null when there was none to wait for. */
  readonly ready: Promise<void> | null;
  /** The field events (`$onField`). */
  onField(key: string, fn: (value: unknown) => void): () => void;
  /** Stops the watcher, closes the share, marks every field subscriber off. */
  dispose(): void;
};

/**
 * @internal The state half: a cell, its one watcher,
 * and what that watcher feeds, in this order: persist's save, share's send,
 * the field events. A store builds its command half on it (reducers, the
 * ring, `coalesce`, facts). The library's own queues (the outbox, history,
 * the buffer) use it alone: no registration, no command on the user's bus,
 * no entry in the bus's stores, so `storeStates` and `liveStores` never see
 * them. Built once per owner. `first` maps the first state (DEV, a hot
 * update's carry). `owner` is read by persist and share only, so a half with
 * neither (history, the buffer) passes null.
 * tests/store-one-watcher.test.ts, tests/state-half.test.ts.
 */
export function _stateHalf<S>(
  rt: StoreRuntime,
  options: { id: string; state: () => S; persist?: StorePersist<S>; share?: StateShare<S>; first?: (first: S) => S },
  owner: HalfOwner<S> | null,
): StateHalf<S> {
  const id = options.id;
  // `persist`: the saved state is the first state. tests/store-persist.test.ts.
  const opened = options.persist ? options.persist(options.state) : null;
  const initial = opened !== null ? opened.first : options.state();
  const cell = rt.cell(options.first ? options.first(initial) : initial);
  let live = true;

  // One watcher feeds everything that follows the writes: the save, the tab
  // send, then the field events. Started by the first of them, stopped by
  // `dispose`; a half with none starts none. The handlers never change: any
  // check in them would cost every store's writes, and one watcher replaces
  // an effect each per write.
  // tests/store-one-watcher.test.ts.
  let save: (() => void) | null = null;
  let send: ((next: S) => void) | null = null;
  let fields: FastLane | null = null;
  let stopWatch: (() => void) | null = null;
  // Its handler is built with it: a half nothing watches builds neither.
  const watch = (): void => {
    if (stopWatch === null) {
      stopWatch = rt.watch(cell, (next: S, prev: S): void => {
        if (save !== null) save();
        if (send !== null) send(next);
        if (fields !== null) notifyFields(fields, next as object, prev as object);
      });
    }
  };

  // `persist` (`saveTo`, src/store-persist.ts) gets the cell, the lifetime
  // and the owner's write; it gives back its save, and, while an async read
  // is pending, a handler and a server-state hook that keep each write for
  // the replay.
  const hooks: PersistHooks<S> | null = opened === null ? null : opened.attach(cell, () => live, owner!.write);
  if (hooks !== null) {
    save = hooks.save;
    watch();
  }

  // `share` (`shareTabs`, src/store-share.ts) gets the id, the cell, the
  // owner's `land` and `put`. It gives back its send, on the one watcher, or
  // null where there are no tabs (a server): nothing is watched.
  const sharing = options.share ? options.share({ id, cell, land: owner!.land!, put: owner!.put! }) : null;
  if (sharing !== null) {
    send = sharing.send;
    watch();
  }

  return {
    cell,
    hooks,
    ready: hooks !== null ? hooks.ready : null,
    // Keyed field events on a lane in its live mode, the rule a
    // bus listener follows: one unsubscribed during a write is not called,
    // one added during a write is called from the next
    // (tests/store-field-unsubscribe-during-write.test.ts). A subscriber's
    // throw is logged and the fan-out goes on: thrown out of the write, it
    // failed a dispatch whose state had changed and starved the later
    // subscribers (tests/store-field-subscriber-throw.test.ts). The lane and
    // its log line are built by the first subscriber.
    onField(key, fn) {
      if (fields === null) {
        fields = createFastLane({
          onError: (e, k) => { _report('error', 'store:failed:subscriber', `Store "${id}": the $onField subscriber for "${k}" threw`, e, { store: id, field: k }); },
        });
        watch();
      }
      return fields.on(key, fn);
    },
    dispose() {
      live = false;
      sharing?.dispose();
      stopWatch?.();
      stopWatch = null;
      send = null;
      // Every subscriber marked off, so an unsubscribe kept after this does nothing.
      fields?.clear();
      fields = null;
    },
  };
}

export type DefineChamberStore =<S extends object, R extends Record<string, StoreReducer<S> | null>>(
  id: string,
  options: ChamberStoreOptions<S, R>,
) => <B extends BaseBus>(bus: B, router?: StoreRouter) => ChamberStore<S, R, B>;

/** @internal The store, over a runtime. */
export function createStoreDefiner(rt: StoreRuntime): DefineChamberStore {
  return function defineChamberStore<S extends object, R extends Record<string, StoreReducer<S> | null>>(
  id: string,
  options: ChamberStoreOptions<S, R>,
): <B extends BaseBus>(bus: B, router?: StoreRouter) => ChamberStore<S, R, B> {
  const reducers = options.reducers;
  // An action is a method on the store, so a key named like a member would
  // replace it: `reducers: { state }` left `store.state` a function. Refused
  // here, where the options are first known. tests/store-review.test.ts.
  // A `$` name is the library's (`<id>$reset`, `<action>$undo`): an id or an
  // action key carrying one would read as the library's command.
  if (_isLibraryAction(id)) {
    throw storeFail('invalid:name', `Store "${id}": a name with "$" is the library's.${DEV ? ' Rename the store.' : ''}`, { context: { id } });
  }
  for (const key of Object.keys(reducers)) {
    if (MEMBERS.has(key)) {
      throw storeFail('already:member', `Store "${id}": the action "${key}" would replace the store's own "${key}".${DEV ? ' Rename the action.' : ''}`, { context: { id, key } });
    }
    if (_isLibraryAction(key)) {
      throw storeFail('invalid:name', `Store "${id}": the action "${key}" has a "$", which names the library's commands.${DEV ? ' Rename the action.' : ''}`, { context: { id, key } });
    }
  }
  if (options.coalesce && (options.undo || options.optimistic)) {
    throw storeFail('invalid:coalesce', `Store "${id}": coalesce and ${options.undo ? 'undo' : 'optimistic'} do not go together.${DEV ? ' The ring records each write as it lands, and a coalesced write lands a microtask later. Drop one.' : ''}`, { context: { id } });
  }
  // The definition's names, once: every instance registers and dispatches
  // them, so none builds a string per creation or per call.
  const keys = Object.keys(reducers);
  const names = keys.map((key) => actionName(id, key));
  const resetAction = id + '$reset';
  return function useStore<B extends BaseBus>(bus: B, router?: StoreRouter): ChamberStore<S, R, B> {
    // JS callers get no type error, and the failure without this guard is a
    // `WeakMap.set` TypeError naming neither the store nor the argument. The
    // house rule is that an error says what to do next.
    if (!bus) {
      throw storeFail(
        'missing:bus',
        `Store "${id}" was given no bus.${DEV ? " Call useStore(bus): stores are keyed per bus, so each request's bus gets its own, and never fall back to the shared bus." : ''}`,
        { context: { id } },
      );
    }
    // One registry per bus, so a per-request bus gets a per-request store
    // set - the SSR isolation the shared-bus module global cannot give. Weak,
    // so a disposed bus takes its stores with it. A store is entered once,
    // and its facts reach it on the bus's stores' lane (`_storesOf`).
    const stores = _storesOf(bus);
    const registry = stores.entries;

    // `Object.hasOwn` semantics via Map: the id is an external string and a
    // plain object would answer for `constructor`. See `./dict` for the rule
    // and the six sites that learned it.
    // The same definition joins its store. Another definition of the id takes
    // over, as register() does for a handler (last wins, with ownership): it
    // builds below and registers over the old actions - register() warns per
    // action in DEV, outside a hot update - and the old store's $dispose
    // removes only what it still owns. tests/store-redefine.test.ts,
    // tests/vapor/store-hmr.test.ts, tests/register-hot-update.test.ts.
    const existing = registry.get(id);
    if (existing?.def === useStore) {
      join(rt.scope, existing);
      return existing.store as ChamberStore<S, R, B>;
    }

    // Before anything is registered: thrown after, it left the handlers on the
    // bus with nothing able to unregister them. tests/store-review.test.ts.
    if (options.url && !router) {
      const fields = Object.keys(options.url);
      throw storeFail(
        'missing:router',
        `Store "${id}" declares url fields (${fields.join(', ')}) and was given no router.${DEV ? ' Call useStore(bus, router): the router is an argument, so a store without url fields never imports it.' : ''}`,
        { context: { id, fields } },
      );
    }

    // The state half (`_stateHalf`): the cell, its one watcher, persist and
    // the field events. The store's write and `land` are read when a write
    // runs, after they are set below. DEV, inside a hot update the Vite plugin
    // marks: the first state carries the state of the store this one
    // replaces. A build folds `first` away.
    const lane = stores.lane;
    const half: StateHalf<S> = _stateHalf<S>(rt, {
      id, state: options.state, persist: options.persist,
      first: DEV ? (f) => hotFirst(bus, id, existing?.store === null ? undefined : existing, f) : undefined,
    }, {
      write: (cmd, f) => (step ? step(cmd, state.value, f) : pend ? pend(cmd, f) : (state.value = f(state.value, cmd.target, cmd.payload))),
    });
    const state: { value: S } = half.cell;
    const hooks: PersistHooks<S> | null = half.hooks;
    const offs: Array<() => void> = [half.dispose];
    // `share` (`shareTabs`, src/store-share.ts): each write's command goes to
    // the other tabs through `out`, the send while another tab is there, else
    // null. A store without `share` registers its handlers as they are.
    const shared = options.share !== undefined;
    let out: TabSend<S> | null = null;

    // `undo: true`: every write is a step in a ring of UNDO_RING entries
    // (actions, `$reset`, a tab's state), not in weak maps keyed by every
    // command (5x the action's cost). The inverse runs inside the
    // bus's `<action>$undo` command and rebases (Memento for owned state, as
    // Replicache and Apollo's optimistic layers rebase): from the undone step's
    // "before" it re-applies every later step, calling the reducer directly, so
    // plugins and bridges never see those steps again. canUndo holds while the
    // state is the one that command produced; a redo's write is credited to the
    // last command undone, and when the state is still the one that undo
    // restored, a redo writes the state the step recorded instead of running
    // the reducer again: same object, same ids. tests/store-undo.test.ts,
    // tests/store-rollback-rebase.test.ts, tests/store-redo-recorded.test.ts.
    let step: ((cmd: any, prev: S, f: StoreReducer<S>) => S) | undefined;
    let inverse: { undo: (cmd: any) => unknown; canUndo: (cmd: any) => boolean } | undefined;
    // `share`, across tabs: the command a step was credited to (a redo's is
    // the command it redoes), the step holding a command by id, and the undone
    // step of an id, taken out for another tab's redo. Set with the ring.
    let credited: (() => Command) | undefined;
    let stepOf: (id: string) => Command | undefined = () => undefined;
    let takeUndone: (id: string) => Command | undefined = () => undefined;
    if (options.undo || options.optimistic) {
      // One flat array, three slots a step: [cmd, before, after].
      const ring: unknown[] = new Array(UNDO_RING * 3).fill(undefined);
      let next = 0;
      // Undone steps, three slots each: [cmd, before, after].
      const undone: unknown[] = [];
      // The reducer that re-applies an action's step, by action name.
      const replay = new Map<string, StoreReducer<S>>();
      for (let i = 0; i < keys.length; i++) {
        const f = reducers[keys[i] as string];
        if (f !== null) replay.set(names[i] as string, f as StoreReducer<S>);
      }
      // DEV: a rollback replays reducers, so one that mints a value (an id, a
      // time) rebases to a different state. Run it twice, as React's
      // StrictMode does, and warn once per action when the two differ as JSON
      // (`sameJson`, then the two strings). A state JSON cannot hold is not
      // compared. `$reset` and a tab's state are not replayed by a rollback,
      // so they are not checked.
      const noticed = new Set<string>();
      const twice = (f: StoreReducer<S>, prev: S, cmd: { action: string; target: any; payload?: any }): S => {
        const s = f(prev, cmd.target, cmd.payload);
        // The state it was given came back: nothing minted to compare. A
        // reducer that changed it in place would change it again, so
        // development held [1,1,2,2] where production held [1,2].
        if (s === prev) return s;
        if (replay.get(cmd.action) === f && !noticed.has(cmd.action)) {
          let same = true;
          try {
            const again = f(prev, cmd.target, cmd.payload);
            same = sameJson(again, s) || JSON.stringify(again) === JSON.stringify(s);
          } catch { /* not JSON: not compared */ }
          if (!same) {
            noticed.add(cmd.action);
            _report('warn', 'store:unexpected:reducer', `Store "${id}": the reducer for "${cmd.action}" gave two different states for the same input. A rollback of an earlier step replays it and gets a different state. Mint ids and times in the call, not in the reducer.`, undefined, { store: id, action: cmd.action });
          }
        }
        return s;
      };
      // The newest step holding `cmd` (its first slot), or -1.
      const find = (cmd: unknown): number => {
        for (let k = 1; k <= UNDO_RING; k++) {
          const i = ((next - k) & (UNDO_RING - 1)) * 3;
          if (ring[i] === cmd) return i;
        }
        return -1;
      };
      // Across tabs, read on another tab's message only: the steps scanned by id.
      credited = () => ring[((next - 1) & (UNDO_RING - 1)) * 3] as Command;
      stepOf = (cmdId) => {
        for (let k = 1; k <= UNDO_RING; k++) {
          const c = ring[((next - k) & (UNDO_RING - 1)) * 3] as Command | undefined;
          if (c?.meta?.id === cmdId) return c;
        }
        return undefined;
      };
      takeUndone = (cmdId) => {
        for (let k = undone.length - 3; k >= 0; k -= 3) {
          const c = undone[k] as Command;
          if (c.meta?.id === cmdId) {
            undone.splice(k, 3);
            return c;
          }
        }
        return undefined;
      };
      // `undone.length` first: an action with nothing undone never reads
      // its origin. The reducer runs before anything moves, so a throw leaves
      // the ring and the undone steps as they were.
      step = (cmd, prev, f) => {
        const n = undone.length;
        const redo = n !== 0 && cmd.meta?.origin === 'redo';
        const s = redo && undone[n - 2] === prev && (undone[n - 3] as { action: string }).action === cmd.action
          ? (undone[n - 1] as S)
          : DEV ? twice(f, prev, cmd) : f(prev, cmd.target, cmd.payload);
        const i = next * 3;
        ring[i] = redo ? undone[n - 3] : cmd;
        if (redo) undone.length = n - 3;
        ring[i + 1] = prev;
        ring[i + 2] = s;
        next = (next + 1) & (UNDO_RING - 1);
        return (state.value = s);
      };
      inverse = {
        undo: (cmd) => {
          const i = find(cmd);
          // A step the ring does not hold, or one already undone, changed
          // nothing to take back: the identity, never slot 0.
          if (i === -1) return state.value;
          // Each later step as [slot, before, after], computed first and written
          // after, so a reducer that throws leaves the ring and the state as
          // they were. A reducer runs again; `$reset`, a tab's state and a
          // server's answer set a state whatever came before, so they keep the
          // one they set.
          let s = ring[i + 1] as S;
          const w: unknown[] = [];
          for (let t = (i / 3 + 1) & (UNDO_RING - 1); t !== next; t = (t + 1) & (UNDO_RING - 1)) {
            const c = ring[t * 3] as { action: string; target: any; payload?: any };
            if (c === UNDONE) continue;
            const f = _appliedRemotely.has(c) ? undefined : replay.get(c.action);
            w.push(t * 3, s, (s = f ? f(s, c.target, c.payload) : (ring[t * 3 + 2] as S)));
          }
          for (let k = 0; k < w.length; k += 3) {
            ring[(w[k] as number) + 1] = w[k + 1];
            ring[(w[k] as number) + 2] = w[k + 2];
          }
          undone.push(cmd, ring[i + 1], ring[i + 2]);
          // Bounded like the ring: a redo reads the newest undone steps, and
          // no more than UNDO_RING of them can be undone in a row, so older
          // ones can never be redone. Kept, they held two states per undo for
          // the store's lifetime. On the undo path only.
          if (undone.length > UNDO_RING * 3) undone.splice(0, 3);
          ring[i] = UNDONE;
          return (state.value = s);
        },
        canUndo: (cmd) => {
          const i = find(cmd);
          return i !== -1 && ring[i + 2] === state.value;
        },
      };
      // `optimistic` alone: the ring rolls a failure back, and history does not undo.
      if (!options.undo) inverse = { undo: inverse.undo, canUndo: () => false };
    }
    // `share`: an undo of this tab's goes out as the id of the command it
    // reverses. Another tab's undo runs `undoStep` itself, so it is not sent.
    const undoStep = inverse?.undo;
    if (shared && inverse !== undefined) {
      const raw = inverse.undo;
      inverse = {
        undo: (cmd) => {
          const s = raw(cmd);
          if (out !== null) out('undone', { id: cmd.meta.id, state: state.value });
          return s;
        },
        canUndo: inverse.canUndo,
      };
    }

    // `coalesce`: every write of the store's own commands chains on the
    // pending state, and the cell is written once, a microtask later. One
    // flag: a pending state is always scheduled. `land` writes it at once,
    // before a fact or a server read, and the scheduled flush then finds
    // nothing. `step` is unset (refused with undo above).
    let pend: ((cmd: { target?: any; payload?: any }, f: StoreReducer<S>) => S) | undefined;
    let land = landed;
    if (options.coalesce) {
      let pending: S;
      let waiting = false;
      const flush = (): void => {
        if (!waiting) return;
        waiting = false;
        state.value = pending;
      };
      land = flush;
      pend = (cmd, f) => {
        pending = f(waiting ? pending : state.value, cmd.target, cmd.payload);
        if (!waiting) {
          waiting = true;
          queueMicrotask(flush);
        }
        return pending;
      };
    }

    // A state from outside the store is a fact (another tab's, a server's, a
    // seed, a form's write), written as it arrives, a step of its command,
    // the way the action's reducer writes, and kept for the replay while an
    // async read is pending. Never merged by `coalesce` and never dispatched:
    // an own write still pending lands first. A tab's state (an answer to
    // its ask) is written as it is. A server's is checked here: with
    // `version`, a state older than the one held is dropped, the server's
    // number ordering its writes. Only an object is a state, whether `answer` mapped it or a
    // reply declared it under `stores`: anything else writes nothing.
    // A written `null` or `undefined` would make every reader throw.
    // tests/store-facts-lane.test.ts, tests/store-declared-by-server.test.ts,
    // tests/store-answer-not-a-state.test.ts.
    const versionOf = options.version;
    let unversioned = false;
    let malformed = false;
    const write = (cmd: { action: string; target: any; payload?: any }, next: unknown): void => {
      land();
      if (cmd !== RECEIVED) {
        if (next === null || typeof next !== 'object') {
          if (DEV && !malformed) {
            malformed = true;
            _report('warn', 'store:invalid:state', `Store "${id}": the server's state for "${cmd.action}" is not an object. It is not written.`, undefined, { store: id, action: cmd.action });
          }
          return;
        }
        if (versionOf) {
          const v = versionOf(next as S);
          if (Number.isFinite(v)) {
            const held = versionOf(state.value);
            if (Number.isFinite(held) && v <= held) return;
          } else if (DEV && !unversioned) {
            unversioned = true;
            _report('warn', 'store:invalid:version', `Store "${id}": version() of the answer to "${cmd.action}" is ${v}, not a number. Answers without one are written in arrival order.`, undefined, { store: id, action: cmd.action });
          }
        }
      }
      hooks?.held?.(cmd, next as S);
      if (step) step(cmd, state.value, () => next as S);
      else state.value = next as S;
      // A server's state reached this tab alone: it crosses as a state. A
      // seed is each page's own, and another tab's state is not sent back.
      if (out !== null && cmd !== RECEIVED && cmd !== SEEDED) out('state', next as S);
    };
    // The app maps a command's own answer (`answer`). An answer with no `state`
    // writes nothing.
    const onAnswer = options.answer;
    let registered: RegisterOptions | undefined = onAnswer
      ? {
          ...inverse,
          answer: (cmd: { action: string; target: any; payload?: any }, value: unknown): void => {
            if (value !== undefined) write(cmd, onAnswer(state.value, value, cmd));
          },
        }
      : inverse;
    // `optimistic` and `exclusive` are the bus's, declared on each action. The
    // key is the store's id for a sent action; a local one runs at once, or a
    // reducer queued behind a server command would wait on itself.
    if (options.optimistic || options.exclusive) {
      registered = {
        ...registered,
        optimistic: options.optimistic,
        exclusive: options.exclusive ? { key: (cmd) => (_sendsOn.get(bus)?.(cmd.action) ? id : null) } : undefined,
      };
    }

    // Every action becomes a registered handler. The handler is the ONLY writer
    // of `state`, so a plugin that observes the dispatch observes every change.
    // A store whose async read has not landed keeps each write for the replay:
    // its own handlers, picked here, so no other store's write pays a check.
    const keep = hooks !== null ? hooks.keep : null;
    // A `null` reducer: an action a transport sends, with no local change. It
    // declares the action's options with no handler, never `optimistic`
    // (nothing to show). A function reducer goes to register() as it is, so
    // the bus's one rule decides. tests/register-shadow-check.test.ts.
    const sent = registered?.optimistic ? { ...registered, optimistic: undefined } : registered;
    // `share`: the store's own handlers by action, run for another tab's
    // command, and each wrapped once so its command goes out after it.
    const own = shared ? new Map<string, (cmd: any) => unknown>() : null;
    const crossing = (name: string, h: (cmd: any) => unknown): ((cmd: any) => unknown) => {
      (own as Map<string, (cmd: any) => unknown>).set(name, h);
      return (cmd) => {
        const r = h(cmd);
        if (out !== null) out('cmd', wireOf(credited !== undefined ? credited() : cmd));
        return r;
      };
    };
    for (let i = 0; i < keys.length; i++) {
      const reducer = reducers[keys[i] as string] as StoreReducer<S> | null;
      if (reducer === null) {
        offs.push(bus.register(names[i] as string, null, sent));
        continue;
      }
      const h = keep !== null
        ? keep(reducer)
        : step
        ? (cmd: { target: any; payload?: any }) =>
            (step as (cmd: any, prev: S, f: StoreReducer<S>) => S)(cmd, state.value, reducer)
        : pend
        ? (cmd: { target: any; payload?: any }) =>
            (pend as (cmd: any, f: StoreReducer<S>) => S)(cmd, reducer)
        : (cmd: { target: any; payload?: any }) => {
            state.value = reducer(state.value, cmd.target, cmd.payload);
            return state.value;
          };
      offs.push(bus.register(names[i] as string, shared ? crossing(names[i] as string, h) : h, registered));
    }
    // `$reset` is a command too, or persist never saw it and a reload undid it.
    // The `$` keeps it out of reach of a user action (`reset` is `<id>Reset`)
    // and past a naming rule: names with `$` are the library's.
    // tests/store-reset-command.test.ts.
    // One closure in the plain mode; the others pass `state()` as a reducer.
    let reset: (cmd: any) => unknown;
    if (keep === null && step === undefined && pend === undefined) reset = () => (state.value = options.state());
    else {
      const fresh = (): S => options.state();
      reset = keep !== null ? keep(fresh)
        : step !== undefined ? (cmd) => (step as (cmd: any, prev: S, f: StoreReducer<S>) => S)(cmd, state.value, fresh)
        : (cmd) => (pend as (cmd: any, f: StoreReducer<S>) => S)(cmd, fresh);
    }
    offs.push(_registerAsLibrary(bus, resetAction, shared ? crossing(resetAction, reset) : reset, inverse));

    // `$ready`: the saved state read, and the tabs' state taken when shared.
    // tests/store-ready.test.ts.
    let ready = half.ready;
    // `share`: another tab's command runs the store's own handler with no
    // dispatch, `out` cleared so it is not sent back, and this bus's
    // histories hear it (src/ledger.ts). A redo of a command this tab holds
    // as undone takes that command back. Another tab's undo runs the store's
    // own undo of the command with that id. tests/store-propagate-undo.test.ts.
    if (shared) {
      const hear = (kind: 'heard' | 'undone' | 'redone' | 'moved', cmd?: Command, under?: readonly string[]): void => {
        const set = _hearers.get(bus);
        if (set !== undefined) for (const h of set) (h[kind] as TabHearer['heard'])(cmd as Command, under);
      };
      const put = (next: S): void => {
        write(RECEIVED, next);
        hear('moved');
      };
      const quiet = (f: (cmd: any) => unknown, cmd: Command): void => {
        const was = out;
        out = null;
        try { f(cmd); } finally { out = was; }
      };
      const opened = (options.share as StoreShare<S>)({
        id,
        cell: state,
        land: () => land(),
        open: (send) => { out = send; },
        apply: (w, again, under) => {
          const f = (own as Map<string, (cmd: any) => unknown>).get(w.action);
          if (f === undefined) return;
          const redone = takeUndone(w.id);
          const cmd = redone ?? (again ? stepOf(w.id) : undefined) ?? received(w);
          quiet(f, cmd);
          if (!again) hear(redone !== undefined ? 'redone' : 'heard', cmd, under);
        },
        undo: (u, again) => {
          const cmd = stepOf(u.id);
          // A command this tab does not hold (it opened later, or the ring
          // moved past it): the state the undo reached.
          if (cmd === undefined) return put(u.state);
          quiet(undoStep as (cmd: any) => unknown, cmd);
          if (!again) hear('undone', cmd);
        },
        put,
        hear,
        ring: step !== undefined,
        ready,
      });
      if (opened !== null) {
        offs.push(opened.dispose);
        ready = opened.ready;
      }
    }

    // `deep`: a reader gets the runtime's view of the state (Vue's
    // reactive), decided here, one getter for every store.
    const view = options.deep ? rt.view : undefined;
    const store = {
      $id: id,
      state: {
        get value() {
          return view === undefined ? state.value : view(state.value);
        },
      },
      url: {} as ChamberStore<S, R>['url'],
      $reset: () => bus.dispatch(resetAction, null),
      $onField: half.onField,
      $ready: ready ?? DONE,
      $dispose() {
        if (DEV) hotStates(bus)?.set(id, { state: state.value, declared: options.state });
        // Each cleanup in its own try: one that threw stopped the loop before
        // the registry line below, and the next useStore(bus) joined this
        // disposed store. tests/store-dispose-cleanup-throw.test.ts.
        for (const off of offs) {
          try { off(); } catch (e) { _report('error', 'store:failed:cleanup', `Store "${id}": a cleanup threw during $dispose`, e, { store: id }); }
        }
        offs.length = 0;
        // Only while the id is still this store's: a second call, or a scope
        // that held this store ending after the id was taken again, removed
        // the NEWER store. tests/store-review.test.ts.
        if (registry.get(id) === entry) registry.delete(id);
      },
    } as ChamberStore<S, R, B>;

    for (let i = 0; i < keys.length; i++) {
      const name = names[i] as string;
      (store as Record<string, unknown>)[keys[i] as string] = (target?: any, payload?: any) => bus.dispatch(name, target, payload);
    }

    // Pattern 4B. Declared URL fields delegate; the store holds no signal for
    // them, so there is exactly one writer and no reconciliation to get wrong.
    // `router` is set: checked above, before anything was registered.
    if (options.url) {
      for (const field of Object.keys(options.url)) {
        const queryKey = options.url[field] as string;
        (store.url as Record<string, unknown>)[field] = {
          get value() {
            const raw = router!.currentRoute.value.location.query[queryKey];
            return Array.isArray(raw) ? raw[0] : raw;
          },
          set: (next: unknown) => router!.setQuery({ [queryKey]: next }),
        };
      }
    }

    // A state from outside this store reaches it on the stores' lane, by id:
    // the async bus emits a reply's `stores` at the transport's level, a step
    // of the command that got the reply, a push its own (`_pushed`), a seed
    // and a tab theirs. Only the newest store of an id listens: one taking the
    // id over stops the old one's. tests/store-facts-lane.test.ts,
    // tests/store-declared-by-server.test.ts, tests/inbound-push.test.ts.
    const unlisten = lane.on(id, (f: StoreFact) => { write(f.cmd, f.state); });
    offs.push(unlisten);
    const entry = _registryEntry(store, offs, useStore, unlisten, land, write, undefined, state, state.value);
    if (DEV) declaredOf.set(entry, options.state);
    existing?.unlisten();
    registry.set(id, entry);
    // A state the page seeded for this id before the store existed
    // (`seedStores`), written at once through the store's own write: saved
    // by persist, and the server's over a saved one.
    // tests/ssr-store-states.test.ts.
    if (existing !== undefined && existing.store === null) write(SEEDED, existing.seeded);
    // Auto-dispose when the LAST holding scope ends; outside a scope the caller
    // owns `$dispose`, same contract as every composable here.
    // `getCurrentScope()` rather than an instance accessor - the rule
    // `tryAutoCleanup` records. `getCurrentInstance()` answers null in a Vapor
    // setup; the package reads it only as tryKeepAliveHooks' fallback.
    join(rt.scope, entry);
    return store;
  };
}
}
