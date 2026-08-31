// @vitest-environment happy-dom
/**
 * ACCEPTANCE CRITERIA for `vapor-chamber/store`, written against the
 * composition plan that has since been deleted into the docs it fed
 * (docs/store.md, docs/whitepaper.md 11.9, ROADMAP posture). git has it.
 *
 * Written BEFORE any implementation, the order that paid for itself on
 * `revalidateRoutes`: two of that section's three claims were falsified by
 * writing criteria against today's exports, before either became code. This
 * file does the same for the larger section, and has already found one.
 *
 * ============================================================================
 * FINDING - the plan's Vue-access pattern is not reachable, and should not be.
 * ============================================================================
 *
 * Section 3 lists among the patterns adopted from Pinia 4: "injection-first +
 * active-instance-fallback resolution on `hasInjectionContext()`". That reads
 * as though the store would resolve Vue the way `chamber.ts` does. It cannot,
 * and it should not want to:
 *
 *   - `_vueHasInjectionContext` is module-private in chamber.ts. Six `@internal`
 *     accessors are exported (`getVaporAppFn`, `getDefineVaporComponentFn`,
 *     ...) and there is none for it. `effectScope` is not exposed at all.
 *   - More decisively, chamber.ts reaches Vue through a runtime PROBE, and that
 *     probe is the source of this repo's two shipped prod-only bugs: it
 *     resolves under a dev server and cannot resolve in a production bundle.
 *     `vapor-chamber/vue` and `vapor-chamber/vapor` exist to kill exactly that
 *     failure class.
 *
 * So the store imports `effectScope`, `inject`, `hasInjectionContext` and
 * `shallowRef` STATICALLY from `vue`, the way `src/router/**` already does. An
 * upstream rename becomes a consumer build error rather than a runtime null.
 * That also settles placement: a module with static `vue` imports cannot live
 * in the root barrel, which is Vue-less by construction - so
 * `vapor-chamber/store` is a subpath because it genuinely isolates a cost,
 * which is the only thing that convention exists for.
 *
 * ============================================================================
 * WHAT THIS MUST NOT BECOME
 * ============================================================================
 *
 * Whitepaper section 6 says "The bus coordinates state transitions. It does not
 * store state." That stands and is load-bearing here: the store owns state, and
 * the bus stays the ONLY way state changes. A store that mutates its own signal
 * directly - without a dispatch - is the design failure this file exists to
 * prevent, because it would put a second mutation channel next to the bus and
 * quietly cost every plugin below.
 *
 * The claim section 6 DOES contradict is its other one, about package scope:
 * "Adding a state layer to vapor-chamber would create a fourth source of truth
 * and a competition problem." Section 3 is the counter-argument (a bus-backed
 * store is structurally different from Pinia, which grew a ~70-line bus inside
 * itself for want of one underneath), and it gets recorded in the landing
 * commit rather than assumed here.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { effectScope } from 'vue';
import { createCommandBus, inspectBus } from '../src/command-bus';
import { defineChamberStore } from '../src/store';
import { getCommandBus, resetCommandBus, setCommandBus, signal } from '../src/chamber';
import { history } from '../src/plugins-core';
import { persist } from '../src/plugins-io';

/**
 * The surface the store will compose. Real assertions today: each one is a
 * premise of the design above, and a change to any of them changes the design.
 */
describe('composition surface - what the store is built from', () => {
  it('ships as its own subpath, because it imports vue statically', async () => {
    // Stage 1 asserted the opposite - that `./store` did not exist yet - which
    // was the honest thing to pin before it did. It exists now, and the reason
    // it is a subpath rather than a barrel export is the static `vue` import:
    // the root barrel is Vue-less by construction.
    const pkg = await import('../package.json');
    expect(Object.keys(pkg.default.exports)).toContain('./store');
  });

  it('does NOT expose hasInjectionContext or effectScope - the finding above', async () => {
    const chamber = await import('../src/chamber');
    // If either of these ever appears, revisit the static-import decision: the
    // store could then resolve Vue the way the plan originally described.
    expect(Object.keys(chamber)).not.toContain('getHasInjectionContextFn');
    expect(Object.keys(chamber)).not.toContain('getEffectScopeFn');
  });

  it('exposes signal(), which is what a store field will be', () => {
    const s = signal(0);
    s.value = 1;
    expect(s.value).toBe(1);
  });

  it('has an ambient bus, which the store deliberately does not use', () => {
    // This surface exists and works. The store still refuses it. `useStore`
    // takes the bus as a required argument, and the reason is recorded in
    // src/store.ts: reaching for this accessor imports chamber.ts, whose
    // top-level probe then runs on every `vapor-chamber/store` import - and a
    // module global is the one thing that cannot isolate an SSR request, which
    // is the entire purpose of keying the store registry per bus.
    const a = createCommandBus();
    setCommandBus(a);
    expect(getCommandBus()).toBe(a);
    resetCommandBus();
    expect(getCommandBus()).not.toBe(a);
    resetCommandBus();
  });

  it('does not silently fall back to that ambient bus', () => {
    const a = createCommandBus();
    setCommandBus(a);
    // A JS caller writing `useCart()` gets a named error, not the shared bus
    // and not a WeakMap TypeError.
    expect(() => (useCart as unknown as () => unknown)()).toThrow(/needs a bus/);
    resetCommandBus();
    a.dispose();
  });

  it('imports vue and nothing else - the boundary the probe argument rests on', () => {
    // The first draft of src/store.ts failed this. It read well and pulled
    // chamber.ts through a default argument, so importing the store executed
    // the very probe its own docblock says it exists to avoid. Nothing in the
    // behaviour suite could see that; only the built graph shows it.
    // `process.cwd()`, NOT `import.meta.url`. This file runs under happy-dom
    // (the persist plugin needs localStorage), and there `import.meta.url` is
    // an http://localhost URL, so `existsSync` answered false for every run and
    // the assertion below could never fail. It was written, it passed, and it
    // was inert - the exact shape this suite has a rule against.
    const built = resolve(process.cwd(), 'dist/store.js');
    if (!existsSync(built)) return; // 8 test files skip without dist/; this is one
    const src = readFileSync(built, 'utf8');
    const imports = [...src.matchAll(/^import[^;]*?from\s*["']([^"']+)["']/gm)].map((m) => m[1]);
    expect(imports).toEqual(['vue']);
  });

  /**
   * The central claim of section 3's table: a store gets persistence, undo and
   * cross-tab sync for free because its actions are COMMANDS, so the existing
   * plugins already apply. That is testable today, without a store - if it were
   * false, the whole premise would be.
   */
  it('applies the existing plugins to plain commands, which is why a store needs no store-specific ones', () => {
    const bus = createCommandBus();
    let state = { items: [] as number[] };
    bus.register('itemAdd', (cmd) => {
      state = { items: [...state.items, cmd.target as number] };
      return state;
    });

    const hist = history({ maxSize: 10, bus });
    bus.use(hist);
    bus.use(persist({ key: 'vc:test-store', getState: () => state }));

    bus.dispatch('itemAdd', 1);
    bus.dispatch('itemAdd', 2);
    expect(state.items).toEqual([1, 2]);
    // Undo/redo and persistence observed the mutation without knowing a store
    // exists - because the mutation was a command.
    expect(hist.getState().canUndo).toBe(true);
    expect(inspectBus(bus).pluginCount).toBe(2);
    bus.dispose();
  });
});

const useCart = defineChamberStore('cart', {
  state: () => ({ items: [] as number[] }),
  actions: {
    add: (s, id: number) => ({ items: [...s.items, id] }),
    clear: () => ({ items: [] }),
  },
});

describe('defineChamberStore - behaviour', () => {

  it('replaces state wholesale and never hands back a deep proxy', () => {
    const bus = createCommandBus();
    const cart = useCart(bus);
    const before = cart.state.value;
    cart.add(1);
    expect(cart.state.value).not.toBe(before);   // new object, not mutated
    expect(cart.state.value.items).toEqual([1]);
    expect(before.items).toEqual([]);            // the old snapshot is intact
    cart.$dispose();
    bus.dispose();
  });

  it('mutates ONLY through a dispatch - state has no setter', () => {
    const bus = createCommandBus();
    const cart = useCart(bus);
    // The bus is the only mutation channel. A direct write must not be a
    // second one, so `state` is a getter and assignment throws under ESM
    // strict mode rather than silently opening a bypass.
    expect(() => {
      (cart.state as { value: unknown }).value = { items: [99] };
    }).toThrow();
    expect(cart.state.value.items).toEqual([]);
    cart.$dispose();
    bus.dispose();
  });

  it('registers each action as a command on the bus', () => {
    const bus = createCommandBus();
    const cart = useCart(bus);
    expect(inspectBus(bus).actions.sort()).toEqual(['cartAdd', 'cartClear']);
    // Dispatching the command directly is equivalent to calling the action -
    // there is one path, not two.
    bus.dispatch('cartAdd', 7);
    expect(cart.state.value.items).toEqual([7]);
    cart.$dispose();
    bus.dispose();
  });

  it('returns the same instance for one id and an independent one for another', () => {
    const bus = createCommandBus();
    const useOther = defineChamberStore('wish', { state: () => ({ items: [] as number[] }), actions: { add: (s, id: number) => ({ items: [...s.items, id] }) } });
    expect(useCart(bus)).toBe(useCart(bus));
    useCart(bus).add(1);
    expect(useOther(bus).state.value.items).toEqual([]);
    useCart(bus).$dispose();
    useOther(bus).$dispose();
    bus.dispose();
  });

  it('per-request isolation: two buses hold two independent registries', () => {
    const a = createCommandBus();
    const b = createCommandBus();
    useCart(a).add(1);
    // The SSR failure this prevents: a module-global store would leak user A's
    // cart into user B's render.
    expect(useCart(b).state.value.items).toEqual([]);
    expect(useCart(a).state.value.items).toEqual([1]);
    useCart(a).$dispose();
    useCart(b).$dispose();
    a.dispose();
    b.dispose();
  });

  it('$reset builds a fresh state, never reusing a nested reference', () => {
    const bus = createCommandBus();
    const cart = useCart(bus);
    cart.add(1);
    const dirty = cart.state.value;
    cart.$reset();
    expect(cart.state.value.items).toEqual([]);
    expect(cart.state.value).not.toBe(dirty);
    expect(cart.state.value.items).not.toBe(dirty.items);
    cart.$dispose();
    bus.dispose();
  });

  it('$dispose unregisters the handlers and drops the instance', () => {
    const bus = createCommandBus();
    const cart = useCart(bus);
    expect(inspectBus(bus).actions).toContain('cartAdd');
    cart.$dispose();
    expect(inspectBus(bus).actions).not.toContain('cartAdd');
    expect(useCart(bus)).not.toBe(cart);   // a fresh instance, not the disposed one
    useCart(bus).$dispose();
    bus.dispose();
  });

  it('disposes with the surrounding scope when created inside one', () => {
    const bus = createCommandBus();
    const scope = effectScope();
    let inner!: ReturnType<typeof useCart>;
    scope.run(() => { inner = useCart(bus); });
    expect(inspectBus(bus).actions).toContain('cartAdd');
    scope.stop();
    expect(inspectBus(bus).actions).not.toContain('cartAdd');
    expect(inner.$id).toBe('cart');
    bus.dispose();
  });

  it('the existing plugins apply to store actions with no store-specific code', () => {
    const bus = createCommandBus();
    const cart = useCart(bus);
    const hist = history({ maxSize: 10, bus });
    bus.use(hist);
    let saved: unknown = null;
    bus.use(persist({ key: 'vc:store-test', getState: () => cart.state.value, storage: {
      getItem: () => null,
      setItem: (_k: string, v: string) => { saved = JSON.parse(v); },
      removeItem: () => {},
    } as never }));

    cart.add(1);
    cart.add(2);
    // This is section 3's whole premise: persistence and undo observed a STORE
    // mutation without knowing a store exists, because the mutation was a command.
    expect(saved).toEqual({ items: [1, 2] });
    expect(hist.getState().canUndo).toBe(true);
    cart.$dispose();
    bus.dispose();
  });

  it('reads the registry with a Map, so a store id cannot collide with Object.prototype', () => {
    const bus = createCommandBus();
    const useCtor = defineChamberStore('constructor', { state: () => ({ n: 0 }), actions: { bump: (s) => ({ n: s.n + 1 }) } });
    const store = useCtor(bus);
    store.bump();
    expect(store.state.value.n).toBe(1);
    expect(store.$id).toBe('constructor');
    store.$dispose();
    bus.dispose();
  });
});

describe('URL-backed fields - pattern 4B', () => {
  const useCatalog = defineChamberStore('catalog', {
    state: () => ({ view: 'grid' }),
    actions: { setView: (s, view: string) => ({ ...s, view }) },
    url: { page: 'page' },
  });

  function fakeRouter() {
    const query: Record<string, string | string[]> = {};
    return {
      writes: [] as unknown[],
      currentRoute: { value: { location: { query } } },
      setQuery(patch: Record<string, unknown>) {
        this.writes.push(patch);
        for (const [k, v] of Object.entries(patch)) query[k] = String(v);
      },
    };
  }

  it('reads a url field through the router and owns no signal for it', () => {
    const bus = createCommandBus();
    const router = fakeRouter();
    router.currentRoute.value.location.query.page = '3';
    const catalog = useCatalog(bus, router as never);

    expect(catalog.url.page.value).toBe('3');
    // The store's own state never carried it - that is the single-writer rule.
    expect(Object.keys(catalog.state.value)).toEqual(['view']);
    catalog.$dispose();
    bus.dispose();
  });

  it('writes a url field through setQuery, so the router stays the single writer', () => {
    const bus = createCommandBus();
    const router = fakeRouter();
    const catalog = useCatalog(bus, router as never);

    catalog.url.page.set(4);
    expect(router.writes).toEqual([{ page: 4 }]);
    expect(catalog.url.page.value).toBe('4');
    catalog.$dispose();
    bus.dispose();
  });

  it('takes the first value when the query key repeats', () => {
    const bus = createCommandBus();
    const router = fakeRouter();
    router.currentRoute.value.location.query.page = ['2', '5'];
    const catalog = useCatalog(bus, router as never);
    expect(catalog.url.page.value).toBe('2');
    catalog.$dispose();
    bus.dispose();
  });

  it('refuses url fields with no router, loudly and by name', () => {
    const bus = createCommandBus();
    expect(() => useCatalog(bus)).toThrow(/declares url fields \(page\).*no router was passed/s);
    bus.dispose();
  });

  it('a store with no url fields needs no router at all', () => {
    const bus = createCommandBus();
    const plain = useCart(bus);
    expect(plain.url).toEqual({});
    plain.$dispose();
    bus.dispose();
  });
});
