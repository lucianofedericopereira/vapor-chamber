/**
 * vapor-chamber/store - state whose every mutation is a command.
 *
 * The bus already owns dispatch, plugins, hooks and observability; what it
 * deliberately does not own is state. This adds the state half WITHOUT moving
 * state into the bus: a store holds a signal, and the only way that signal
 * changes is a dispatch.
 *
 * Consumer docs are docs/store.md; docs/whitepaper.md 11.9 places this in the
 * composed surface, and its section 6 records why the package ships a state
 * layer at all, having previously argued it should not.
 *
 *   const useCart = defineChamberStore('cart', {
 *     state: () => ({ items: [] as number[] }),
 *     actions: {
 *       add:   (s, id: number) => ({ items: [...s.items, id] }),
 *       clear: () => ({ items: [] }),
 *     },
 *   });
 *
 *   const cart = useCart(bus);
 *   cart.add(42);            // dispatches `cartAdd` - a command, not a setter
 *   cart.state.value.items;  // [42]
 *
 * WHY THAT MATTERS, and it is the whole design. Because `cart.add(42)` is a
 * command, everything the bus already does applies with no store-specific code:
 * `persist` saves it, `createChannel` mirrors it, `history` records it (undo: the record only),
 * `optimistic` rolls it back, `idempotent` collapses a double-submit,
 * `serialize` orders same-key writes, and the devtools timeline shows it. Pinia
 * grew a ~70-line bus inside itself (`action()` / `$onAction`) to reach a
 * fraction of that, because no bus existed underneath. Here the bus is the
 * foundation and the store is the thin part.
 *
 * VUE IS IMPORTED STATICALLY, not resolved through `chamber.ts`'s registry.
 * That probe cannot resolve in a production bundle and is behind both of this
 * package's shipped prod-only bugs, which is why `vapor-chamber/vue` and
 * `vapor-chamber/vapor` exist. A static import turns an upstream rename into a
 * consumer BUILD error rather than a runtime null. It also settles why this is
 * a subpath: a module that imports `vue` cannot live in the root barrel, which
 * is Vue-less by construction, so the subpath isolates a real cost.
 *
 * THE BUS IS A REQUIRED ARGUMENT, and the first draft of this file got that
 * wrong in a way only measurement caught. It defaulted to `getCommandBus()`,
 * which reads well and cost two things the paragraph above claims this module
 * does not pay. Importing that accessor pulls `chamber.ts`, whose top-level
 * `probeVue()` then runs on any `vapor-chamber/store` import - so the module
 * that exists to avoid the probe was executing it at load. And the registry
 * below is keyed per bus precisely because a module global cannot isolate an
 * SSR request; defaulting to that global handed every request the same stores
 * unless the caller opted out. One default, contradicting both neighbouring
 * docblocks. Required is also simply honest: a store IS its bus, and every
 * call site in the suite already passed one.
 *
 * SHALLOW, REPLACED WHOLESALE. State is a `shallowRef` and every action returns
 * a NEW state object. Measured on the real dispatch path, wholesale replacement
 * over a deep `ref` is ~3.4x on array state (tests/signal-shallow-ab.test.ts).
 * A reducer that mutates and returns the same object is a no-op to the signal,
 * which is why `$reset` and every action build fresh objects.
 */

import { type ShallowRef, getCurrentScope, onScopeDispose, shallowRef } from 'vue';
import type { BaseBus, CommandResult } from './command-bus';

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
  $reset: () => void;
  $dispose: () => void;
} & { [K in keyof A]: (target?: any, payload?: any) => CommandResult | Promise<CommandResult> };

/**
 * A store plus the bookkeeping its LIFETIME needs.
 *
 * `holders` is the count of live component scopes using this store, and it is
 * the whole reason this is an entry rather than the store alone. A store is
 * shared by construction - the registry hands the same object to every caller
 * of `useCart(bus)` - but disposal used to be wired to whichever scope happened
 * to create it FIRST. So:
 *
 *   component A mounts   -> creates the store, registers the bus handlers
 *   component B mounts   -> gets the same store back
 *   component A unmounts -> $dispose(): handlers unregistered, registry cleared
 *   component B, still on screen, calls cart.add(2)
 *
 * B holds a live object whose every action now returns `ok: false` and whose
 * state never changes again. Silent - no throw, no warning, and B's own code is
 * blameless. Measured exactly that way in tests/store-form-sharing.test.ts,
 * which pins all three paths: first holder out, last holder out, and no scope
 * at all. Two components sharing a store is not an edge case, it is what a
 * store IS.
 */
type StoreEntry = { store: unknown; offs: Array<() => void>; holders: number };

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

/** `cart` + `add` -> `cartAdd`, the house convention `useCommandGroup` uses. */
function actionName(id: string, key: string): string {
  return id + key.charAt(0).toUpperCase() + key.slice(1);
}

export function defineChamberStore<S extends object, A extends Record<string, StoreAction<S>>>(
  id: string,
  options: ChamberStoreOptions<S, A>,
): (bus: BaseBus, router?: StoreRouter) => ChamberStore<S, A> {
  return function useStore(bus: BaseBus, router?: StoreRouter) {
    // JS callers get no type error, and the failure without this guard is a
    // `WeakMap.set` TypeError naming neither the store nor the argument. The
    // house rule is that an error says what to do next.
    if (!bus) {
      throw new Error(
        `[vapor-chamber] store "${id}" needs a bus: useStore(bus). It is not optional and does ` +
          'not fall back to the shared bus - stores are keyed per bus so that a per-request bus ' +
          'gets its own state, which a module global cannot give.',
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
      if (!getCurrentScope()) return;
      entry.holders++;
      onScopeDispose(() => {
        entry.holders--;
        if (entry.holders <= 0) (entry.store as ChamberStore<S, A>).$dispose();
      });
    };

    // `Object.hasOwn` semantics via Map: the id is an external string and a
    // plain object would answer for `constructor`. See `./dict` for the rule
    // and the six sites that learned it.
    const existing = registry.get(id);
    if (existing) {
      join(existing);
      return existing.store as ChamberStore<S, A>;
    }

    const state = shallowRef(options.state()) as ShallowRef<S>;
    const offs: Array<() => void> = [];

    // Every action becomes a registered handler. The handler is the ONLY writer
    // of `state`, so a plugin that observes the dispatch observes every change.
    for (const key of Object.keys(options.actions)) {
      const reducer = options.actions[key] as StoreAction<S>;
      offs.push(
        bus.register(actionName(id, key), (cmd: { target: any; payload?: any }) => {
          state.value = reducer(state.value, cmd.target, cmd.payload);
          return state.value;
        }),
      );
    }

    const store = {
      $id: id,
      state: {
        get value() {
          return state.value;
        },
      },
      url: {} as ChamberStore<S, A>['url'],
      $reset() {
        state.value = options.state();
      },
      $dispose() {
        for (const off of offs) off();
        offs.length = 0;
        registry.delete(id);
      },
    } as ChamberStore<S, A>;

    for (const key of Object.keys(options.actions)) {
      (store as Record<string, unknown>)[key] = (target?: any, payload?: any) =>
        bus.dispatch(actionName(id, key), target, payload);
    }

    // Pattern 4B. Declared URL fields delegate; the store holds no signal for
    // them, so there is exactly one writer and no reconciliation to get wrong.
    if (options.url) {
      if (!router) {
        throw new Error(
          `[vapor-chamber] store "${id}" declares url fields (${Object.keys(options.url).join(', ')}) ` +
            'but no router was passed. Call useStore(bus, router) - the store takes the router as an ' +
            'argument so a store without url fields never imports it.',
        );
      }
      for (const field of Object.keys(options.url)) {
        const queryKey = options.url[field] as string;
        (store.url as Record<string, unknown>)[field] = {
          get value() {
            const raw = router.currentRoute.value.location.query[queryKey];
            return Array.isArray(raw) ? raw[0] : raw;
          },
          set: (next: unknown) => router.setQuery({ [queryKey]: next }),
        };
      }
    }

    // Auto-dispose when the LAST holding scope ends; outside a scope the caller
    // owns `$dispose`, same contract as every composable here.
    // `getCurrentScope()` rather than an instance accessor - the rule
    // `tryAutoCleanup` records, and the reason `getCurrentInstance()` is never
    // used in this package.
    const entry: StoreEntry = { store, offs, holders: 0 };
    registry.set(id, entry);
    join(entry);
    return store;
  };
}
