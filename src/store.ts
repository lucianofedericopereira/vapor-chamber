/**
 * vapor-chamber/store - state whose every mutation is a command.
 *
 * The bus already owns dispatch, plugins, hooks and observability; what it
 * deliberately does not own is state. This adds the state half WITHOUT moving
 * state into the bus: a store holds a signal, and the only way that signal
 * changes is a dispatch.
 *
 * Consumer docs are docs/store.md; docs/whitepaper.md 8.2 places this in the
 * composed surface, and its appendix A.3 (with section 3.6) records why the
 * package ships a state layer at all.
 *
 *   const useCart = defineChamberStore('cart', {
 *     state: () => ({ items: [] as number[] }),
 *     reducers: {
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
 * `persist` saves it, `history` records it (and undoes it for a store defined
 * with `undo: true`), `share` keeps the same state in every tab,
 * `optimistic` rolls it back, `idempotent` collapses a double-submit,
 * `serialize` orders same-key writes, and the devtools timeline shows it. Pinia
 * grew a bus of about 60 lines inside itself (4.0.3: `action()` / `$onAction`)
 * to reach a fraction of that, because no bus existed underneath. Here the bus is the
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

import { type ShallowRef, effect, effectScope, getCurrentScope, onScopeDispose, shallowRef } from 'vue';
import { type DefineChamberStore, type StoreRuntime, createStoreDefiner } from './store-base';

export type { ChamberStore, ChamberStoreOptions, StoreReducer, StoreRouter } from './store-base';

const vueRuntime: StoreRuntime = {
  cell: (initial) => shallowRef(initial),
  // One sync effect in a detached scope (not the calling component's), so a
  // watch lives with the store, not with whoever subscribed first.
  watch(cell, fn) {
    const scope = effectScope(true);
    let prev = cell.value;
    scope.run(() => effect(() => {
      const next = cell.value;
      if (next !== prev) { const was = prev; prev = next; fn(next, was); }
    }));
    return () => scope.stop();
  },
  scope: { active: () => getCurrentScope() !== undefined, onDispose: onScopeDispose },
};

export const defineChamberStore: DefineChamberStore = createStoreDefiner(vueRuntime);

const bindings = new WeakMap<object, Map<string, ShallowRef<unknown>>>();

/**
 * A field of a store as a read-only Vue ref, over the store's `$onField`
 * events: a component reading one field re-renders when that field changes,
 * not on every write of the store. One ref per store and field, for the
 * store's life. Against a computed per field, it pays off from a few readers
 * (docs/store.md, log s35.125).
 *
 * @example
 * const count = fieldRef(cart, 'count'); // count.value
 */
export function fieldRef<S extends object, K extends keyof S & string>(
  store: { readonly state: { readonly value: S }; $onField: (key: K, fn: (value: S[K]) => void) => () => void },
  key: K,
): { readonly value: S[K] } {
  let refs = bindings.get(store);
  if (refs === undefined) { refs = new Map(); bindings.set(store, refs); }
  let r = refs.get(key);
  if (r === undefined) {
    const made = shallowRef<unknown>(store.state.value[key]);
    store.$onField(key, (value) => { made.value = value; });
    refs.set(key, made);
    r = made;
  }
  return r as { readonly value: S[K] };
}
