/**
 * vapor-chamber - the store, once, for both entries.
 *
 * `vapor-chamber/store` (Vue) and `vapor-chamber/store/core` (no Vue) are this
 * implementation over a different runtime (`StoreRuntime`): the rules - actions
 * as commands, the registry per bus, takeover, undo, field events, sharing,
 * the coded refusals - exist once. Log s35.130. The design notes on the store
 * are in src/store.ts and docs/store.md.
 */

import type { BaseBus, CommandResult } from './command-bus';
import { _failures } from './failure';
import { _asLibrary, _isLibraryAction } from './library-names';
import { DEV } from './dev';

// Coded like every library failure (owner:condition:subject); the owner is the
// feature name. The core's shape: the message states the fact, every value in
// it is also in `context`, and the advice is DEV only (plan settled item 5,
// 4.5). tests/store-review.test.ts.
const storeFail = _failures('store');

/** A reducer: current state plus the dispatched target, returning the NEXT state. */
export type StoreAction<S> = (state: S, target: any, payload?: any) => S;

export type ChamberStoreOptions<S extends object, A extends Record<string, StoreAction<S>>> = {
  /**
   * A FACTORY, never a literal. Two stores of the same shape must not share a
   * nested reference, and `$reset` must not hand back the object a previous
   * reset already mutated - both are the same bug, and a factory makes it
   * unrepresentable.
   */
  state: () => S;
  actions: A;
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
   * Share the store across tabs over this event lane, the one an app bridges
   * with `createChannel({ lane, events: ['<id>$state'] })`. Every tab ends on
   * the same state (docs/store.md, Across tabs). Off by default.
   */
  share?: { on(event: string, listener: (data: any) => void): () => void; emit(event: string, data: any): void };
};

/** The router surface pattern 4B needs, named structurally so this module
 *  imports nothing from `src/router`. */
export type StoreRouter = {
  currentRoute: { value: { location: { query: Record<string, string | string[]> } } };
  setQuery: (patch: Record<string, unknown>, opts?: { history?: 'push' | 'replace' }) => void;
};

export type ChamberStore<S extends object, A extends Record<string, StoreAction<S>>> = {
  readonly $id: string;
  /** Read-only by construction: there is no setter, so a direct write throws in
   *  strict mode. The bus is the only mutation channel. */
  readonly state: { readonly value: S };
  /** URL-backed fields (4B), absent when no `url` map was declared. */
  readonly url: Record<string, { readonly value: string | undefined; set: (next: unknown) => void }>;
  /** Dispatches `<id>$reset`, which sets `state()` afresh: a command like any
   *  action, so plugins, listeners and history see it. Returns the dispatch
   *  result; on an async bus, its promise. */
  $reset: () => CommandResult | Promise<CommandResult>;
  /** Call `fn` with a field's new value each time a write changes it (by
   *  identity), the store's own keyed event; returns the unsubscribe. A store
   *  with no subscriber writes as it would without. docs/store.md. */
  $onField: <K extends keyof S & string>(key: K, fn: (value: S[K]) => void) => () => void;
  $dispose: () => void;
} & { [K in keyof A]: (target?: any, payload?: any) => CommandResult | Promise<CommandResult> };

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
type StoreEntry = {
  store: unknown;
  offs: Array<() => void>;
  holders: number;
  /** The definition that built it (its `useStore`): another one takes over. */
  def: unknown;
  /** Held by a caller outside any scope, who owns `$dispose()` (docs/store.md). */
  pinned?: boolean;
};

/** One registry per bus, so a per-request bus gets a per-request store set -
 *  the SSR isolation the shared-bus module global cannot give. Weak, so a
 *  disposed bus takes its stores with it. */
const registries = new WeakMap<BaseBus, Map<string, StoreEntry>>();

function registryFor(bus: BaseBus): Map<string, StoreEntry> {
  let registry = registries.get(bus);
  if (!registry) {
    registry = new Map();
    registries.set(bus, registry);
  }
  return registry;
}

/** The store's own members: an action key equal to one would replace it. */
const MEMBERS = new Set(['$id', 'state', 'url', '$reset', '$dispose', '$onField']);

/** How many steps a store with `undo: true` keeps (a power of two); history's default is 50. */
const UNDO_RING = 256;

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
  /** Call `fn(next, prev)` after each write that changes the cell; returns the stop. */
  watch<T>(cell: { value: T }, fn: (next: T, prev: T) => void): () => void;
  scope?: { active(): boolean; onDispose(fn: () => void): void };
};

export type DefineChamberStore = <S extends object, A extends Record<string, StoreAction<S>>>(
  id: string,
  options: ChamberStoreOptions<S, A>,
) => (bus: BaseBus, router?: StoreRouter) => ChamberStore<S, A>;

/** @internal The store, over a runtime. */
export function createStoreDefiner(rt: StoreRuntime): DefineChamberStore {
  return function defineChamberStore<S extends object, A extends Record<string, StoreAction<S>>>(
  id: string,
  options: ChamberStoreOptions<S, A>,
): (bus: BaseBus, router?: StoreRouter) => ChamberStore<S, A> {
  // An action is a method on the store, so a key named like a member would
  // replace it: `actions: { state }` left `store.state` a function. Refused
  // here, where the options are first known. tests/store-review.test.ts.
  // A `$` name is the library's (`<id>$reset`, `<action>$undo`): an id or an
  // action key carrying one would read as the library's command. Log s35.117.
  if (_isLibraryAction(id)) {
    throw storeFail('invalid:name', `Store "${id}": a name with "$" is the library's.${DEV ? ' Rename the store.' : ''}`, { context: { id } });
  }
  for (const key of Object.keys(options.actions)) {
    if (MEMBERS.has(key)) {
      throw storeFail('already:member', `Store "${id}": the action "${key}" would replace the store's own "${key}".${DEV ? ' Rename the action.' : ''}`, { context: { id, key } });
    }
    if (_isLibraryAction(key)) {
      throw storeFail('invalid:name', `Store "${id}": the action "${key}" has a "$", which names the library's commands.${DEV ? ' Rename the action.' : ''}`, { context: { id, key } });
    }
  }
  return function useStore(bus: BaseBus, router?: StoreRouter) {
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
    const registry = registryFor(bus);

    /**
     * Join this scope to a store's holder count, and leave when the scope ends.
     *
     * The LAST holder out disposes, not the first one in. Outside a scope there
     * is no lifetime to hook, so nothing is counted and the caller owns
     * `$dispose()` - the same contract every composable here has.
     */
    const join = (entry: StoreEntry): void => {
      // A caller outside any scope has no lifetime to hook: it PINS the store,
      // and owns $dispose() (docs/store.md), so scoped holders leaving do not
      // dispose it under that owner. tests/store-unscoped-holder.test.ts.
      if (!rt.scope?.active()) {
        entry.pinned = true;
        return;
      }
      entry.holders++;
      rt.scope.onDispose(() => {
        entry.holders--;
        if (entry.holders <= 0 && !entry.pinned) (entry.store as ChamberStore<S, A>).$dispose();
      });
    };

    // `Object.hasOwn` semantics via Map: the id is an external string and a
    // plain object would answer for `constructor`. See `./dict` for the rule
    // and the six sites that learned it.
    // The same definition joins its store. Another definition of the id takes
    // over, as register() does for a handler (last wins, with ownership): it
    // builds below and registers over the old actions - register() warns per
    // action in DEV - and the old store's $dispose removes only what it still
    // owns. tests/store-redefine.test.ts, tests/vapor/store-hmr.test.ts.
    const existing = registry.get(id);
    if (existing?.def === useStore) {
      join(existing);
      return existing.store as ChamberStore<S, A>;
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

    const state = rt.cell(options.state());
    const offs: Array<() => void> = [];

    // Keyed field events (`$onField`, log s35.125): one watch on the state,
    // started by the first subscriber. The handlers never change: any check in
    // them cost every store's writes.
    let fieldSubs: Map<string, Array<(value: unknown) => void>> | null = null;
    let stopFields: (() => void) | null = null;
    const notify = (next: S, prev: S): void => {
      const subs = fieldSubs as Map<string, Array<(value: unknown) => void>>;
      for (const k in next) {
        const v = (next as Record<string, unknown>)[k];
        if (v !== (prev as Record<string, unknown>)[k]) {
          const fns = subs.get(k);
          if (fns !== undefined) for (let i = 0; i < fns.length; i++) fns[i](v);
        }
      }
    };

    // `undo: true`: each action's inverse puts back the state it replaced; it
    // runs inside the bus's `<action>$undo` command. canUndo holds while the
    // state is the one that command produced; a redo's write is credited to the
    // last command undone. The steps sit in a ring of UNDO_RING entries, not in
    // weak maps keyed by every command (5x the action's cost, log s35.118): an
    // older step reads canUndo false. tests/store-undo.test.ts.
    let step: ((cmd: any, prev: S) => void) | undefined;
    let inverse: { undo: (cmd: any) => unknown; canUndo: (cmd: any) => boolean } | undefined;
    if (options.undo) {
      // One flat array, three slots a step: [cmd, before, after].
      const ring: unknown[] = new Array(UNDO_RING * 3).fill(undefined);
      let next = 0;
      const undone: object[] = [];
      // The newest step holding `cmd` (its first slot), or -1.
      const find = (cmd: unknown): number => {
        for (let k = 1; k <= UNDO_RING; k++) {
          const i = ((next - k) & (UNDO_RING - 1)) * 3;
          if (ring[i] === cmd) return i;
        }
        return -1;
      };
      step = (cmd, prev) => {
        const i = next * 3;
        ring[i] = cmd.meta?.origin === 'redo' && undone.length !== 0 ? undone.pop() : cmd;
        ring[i + 1] = prev;
        ring[i + 2] = state.value;
        next = (next + 1) & (UNDO_RING - 1);
      };
      inverse = {
        undo: (cmd) => {
          undone.push(cmd);
          state.value = ring[find(cmd) + 1] as S;
          return state.value;
        },
        canUndo: (cmd) => {
          const i = find(cmd);
          return i !== -1 && ring[i + 2] === state.value;
        },
      };
    }

    // Every action becomes a registered handler. The handler is the ONLY writer
    // of `state`, so a plugin that observes the dispatch observes every change.
    for (const key of Object.keys(options.actions)) {
      const reducer = options.actions[key] as StoreAction<S>;
      offs.push(
        step
          ? bus.register(actionName(id, key), (cmd: { target: any; payload?: any }) => {
              const prev = state.value;
              state.value = reducer(prev, cmd.target, cmd.payload);
              (step as (cmd: any, prev: S) => void)(cmd, prev);
              return state.value;
            }, inverse)
          : bus.register(actionName(id, key), (cmd: { target: any; payload?: any }) => {
              state.value = reducer(state.value, cmd.target, cmd.payload);
              return state.value;
            }),
      );
    }
    // `$reset` is a command too, or persist never saw it and a reload undid it.
    // The `$` keeps it out of reach of a user action (`reset` is `<id>Reset`)
    // and past a naming rule: names with `$` are the library's.
    // tests/store-reset-command.test.ts.
    const resetAction = id + '$reset';
    offs.push(
      _asLibrary(() => bus.register(resetAction, (cmd: object) => {
        const prev = state.value;
        state.value = options.state();
        step?.(cmd, prev);
        return state.value;
      }, inverse)),
    );

    // `share`: each local write goes out as `<id>$state` with a version; a
    // newer one from another tab comes in as the `<id>$sync` command (origin
    // 'sync', which history does not record). The handlers never change: a
    // watch on the state sends. tests/store-share.test.ts, log s35.129.
    if (options.share) {
      const lane = options.share;
      const event = id + '$state';
      const syncAction = id + '$sync';
      const tab = Math.random().toString(36).slice(2);
      let version = 0;
      let received: S | undefined;
      offs.push(_asLibrary(() => bus.register(syncAction, (cmd: { target: S }) => {
        state.value = cmd.target;
        return state.value;
      })));
      offs.push(rt.watch(state, (next) => {
        if (next === received) return; // a state from another tab is not sent back
        version++;
        lane.emit(event, { state: next, version, tab });
      }));
      offs.push(lane.on(event, (m: { state: S; version: number; tab: string }) => {
        if (m.tab === tab) return;
        // The newer version wins, a tie goes to the higher tab id: two tabs
        // writing at once end on one state.
        if (m.version > version || (m.version === version && m.tab > tab)) {
          version = m.version;
          received = m.state;
          bus.dispatch(syncAction, m.state, { __origin: 'sync' });
        }
      }));
    }

    const store = {
      $id: id,
      state: {
        get value() {
          return state.value;
        },
      },
      url: {} as ChamberStore<S, A>['url'],
      $reset: () => bus.dispatch(resetAction, null),
      $onField(key: string, fn: (value: unknown) => void) {
        if (fieldSubs === null) {
          fieldSubs = new Map();
          stopFields = rt.watch(state, notify);
        }
        const subs = fieldSubs;
        let fns = subs.get(key);
        if (fns === undefined) { fns = []; subs.set(key, fns); }
        fns.push(fn);
        const own = fns;
        return () => {
          const at = own.indexOf(fn);
          if (at !== -1) own.splice(at, 1);
        };
      },
      $dispose() {
        for (const off of offs) off();
        offs.length = 0;
        stopFields?.();
        stopFields = null;
        fieldSubs = null;
        // Only while the id is still this store's: a second call, or a scope
        // that held this store ending after the id was taken again, removed
        // the NEWER store. tests/store-review.test.ts.
        if (registry.get(id) === entry) registry.delete(id);
      },
    } as ChamberStore<S, A>;

    for (const key of Object.keys(options.actions)) {
      (store as Record<string, unknown>)[key] = (target?: any, payload?: any) =>
        bus.dispatch(actionName(id, key), target, payload);
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

    // Auto-dispose when the LAST holding scope ends; outside a scope the caller
    // owns `$dispose`, same contract as every composable here.
    // `getCurrentScope()` rather than an instance accessor - the rule
    // `tryAutoCleanup` records, and the reason `getCurrentInstance()` is never
    // used in this package.
    const entry: StoreEntry = { store, offs, holders: 0, def: useStore };
    registry.set(id, entry);
    join(entry);
    return store;
  };
}
}
