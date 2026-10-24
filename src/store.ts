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
 * `history` records it (and undoes it for a store defined
 * with `undo: true`), `share` keeps the same state in every tab,
 * its `optimistic` option rolls a failed write back, `idempotent` collapses a
 * double-submit, its `exclusive` option orders its sent writes, and the
 * devtools timeline shows it. Its
 * saved state is its own option (`persist`, src/store-persist.ts). Pinia
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
 * beats a deep `ref` on array state (tests/signal-shallow-ab.test.ts; the dated
 * figure is in docs/performance.md).
 * A reducer that mutates and returns the same object is a no-op to the signal,
 * which is why `$reset` and every action build fresh objects.
 */

import { effect, effectScope, getCurrentScope, onScopeDispose, reactive, shallowRef } from 'vue';
import { type DefineChamberStore, type StoreRuntime, _fieldCell, createStoreDefiner } from './store-base';

export type { ChamberStore, ChamberStoreOptions, StoreReducer, StoreRouter } from './store-base';
export { saveTo, type PersistStorage, type SaveToOptions, type StorePersist } from './store-persist';
export { shareTabs, type StoreShare } from './store-share';

const vueRuntime: StoreRuntime = {
  cell: (initial) => shallowRef(initial),
  // `deep`: Vue's one cached reactive proxy of the raw state.
  view: (value) => reactive(value as object) as typeof value,
  // One sync effect in a detached scope (not the calling component's), so a
  // watch lives with the store, not with whoever subscribed first.
  // `fn` runs inside the effect's run, so what it reads tracks into this
  // effect, not into the effect that wrote. A running effect does not re-run
  // for a write it causes, so a write `fn` makes is read back here and
  // delivered after it, in order (a scheduler that called `fn` after the run
  // delivered out of order and leaked `fn`'s reads into the writer's effect).
  // tests/store-write-during-delivery.test.ts.
  watch(cell, fn) {
    const scope = effectScope(true);
    let prev = cell.value;
    scope.run(() => effect(() => {
      let next = cell.value;
      while (next !== prev) { const was = prev; prev = next; fn(next, was); next = cell.value; }
    }));
    return () => scope.stop();
  },
  scope: { active: () => getCurrentScope() !== undefined, onDispose: onScopeDispose },
};

export const defineChamberStore: DefineChamberStore = createStoreDefiner(vueRuntime);

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
  return _fieldCell(store, key, shallowRef);
}
