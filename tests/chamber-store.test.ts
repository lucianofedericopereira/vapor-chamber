/**
 * vapor-chamber/store: what it is built from, how it behaves, and its URL-backed fields.
 * Why: the store owns state but the bus stays the only way it changes, so every plugin applies; it imports vue statically, never through chamber.ts's probe, which a production bundle cannot resolve.
 * Shows: a subpath whose graph reaches only vue; no ambient-bus fallback; state replaced whole, no setter; actions are commands; a registry per bus; $reset, $dispose; url fields via the router.
 * See: docs/store.md, docs/whitepaper.md 3.6 and 8.2, src/store.ts, log s35.130, log s35.184, plan 1.32 4.2.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect } from 'vitest';
import { effectScope } from 'vue';
import { createCommandBus, inspectBus } from '../src/command-bus';
import { defineChamberStore } from '../src/store';
import { getCommandBus, resetCommandBus, setCommandBus, signal } from '../src/chamber';
import { it } from '../src/vitest';
import { requireDist } from './require-dist';
import { saveTo } from '../src/store-persist';
import { history } from '../src/plugins-core';

/** The surface the store is built from: each case is a premise of the design, and a change to any changes it. */
describe('composition surface - what the store is built from', () => {
  it('ships as its own subpath, because it imports vue statically', async () => {
    // A subpath, not a barrel export: the root barrel is Vue-less, and the store imports vue.
    const pkg = await import('../package.json');
    expect(Object.keys(pkg.default.exports)).toContain('./store');
  });

  it('does NOT expose hasInjectionContext or effectScope - the finding above', async () => {
    const chamber = await import('../src/chamber');
    // If either appears, revisit the static-import decision.
    expect(Object.keys(chamber)).not.toContain('getHasInjectionContextFn');
    expect(Object.keys(chamber)).not.toContain('getEffectScopeFn');
  });

  it('exposes signal(), which is what a store field will be', () => {
    const s = signal(0);
    s.value = 1;
    expect(s.value).toBe(1);
  });

  it('has an ambient bus, which the store deliberately does not use', () => {
    // The store refuses it: it imports chamber.ts and its probe, and a module global cannot isolate an SSR request.
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
    expect(() => (useCart as unknown as () => unknown)()).toThrow(/was given no bus/);
    resetCommandBus();
    a.dispose();
  });

  it('imports vue and the probe-free bus module, nothing else - the boundary the probe argument rests on', () => {
    // Only the built graph shows what importing the store pulls in; no behaviour test can.
    // `process.cwd()`, not `import.meta.url`: under happy-dom that is an http URL, and existsSync would always be false.
    const built = resolve(process.cwd(), 'dist/store.js');
    requireDist(existsSync(built));
    const src = readFileSync(built, 'utf8');
    const imports = [...src.matchAll(/^import[^;]*?from\s*["']([^"']+)["']/gm)].map((m) => m[1]);
    // The whole graph, not chunk names, which the bundler regroups: one external, vue, and no chamber.js or bus chunk.
    expect(imports).toContain('vue');
    const files = new Set<string>();
    const externals = new Set<string>();
    const walk = (file: string): void => {
      if (files.has(file)) return;
      files.add(file);
      const code = readFileSync(resolve(process.cwd(), 'dist', file), 'utf8');
      for (const m of code.matchAll(/^import[^;]*?from\s*["']([^"']+)["']/gm)) {
        const dep = m[1] as string;
        if (dep.startsWith('./')) walk(dep.slice(2));
        else externals.add(dep);
      }
    };
    walk('store.js');
    expect([...externals]).toEqual(['vue']);
    expect([...files].filter((f) => /^(chamber|index|command-bus)\.js$/.test(f))).toEqual([]);
    // It reaches the store implementation, in whichever chunk the bundler put it.
    expect([...files].some((f) => readFileSync(resolve(process.cwd(), 'dist', f), 'utf8').includes('function createStoreDefiner'))).toBe(true);
    // Control: the same walk from the root reaches chamber.js, so its absence
    // above is a fact of the graph, not a walker that stops early.
    files.clear();
    walk('index.js');
    expect(files.has('chamber.js')).toBe(true);
  });

  /** The store's premise, testable without a store: plugins apply to any command, so store actions get undo and history free. */
  it('applies the existing plugins to plain commands, which is why a store needs no store-specific ones', () => {
    const bus = createCommandBus();
    let state = { items: [] as number[] };
    bus.register('itemAdd', (cmd) => {
      state = { items: [...state.items, cmd.target as number] };
      return state;
    });

    const hist = history({ maxSize: 10, bus });

    bus.dispatch('itemAdd', 1);
    bus.dispatch('itemAdd', 2);
    expect(state.items).toEqual([1, 2]);
    // Undo/redo observed the mutation without knowing a store exists -
    // because the mutation was a command.
    expect(hist.getState().canUndo).toBe(true);
    expect(inspectBus(bus).afterHookCount).toBe(1); // history's recorder, not a plugin
    bus.dispose();
  });
});

const useCart = defineChamberStore('cart', {
  state: () => ({ items: [] as number[] }),
  reducers: {
    add: (s, id: number) => ({ items: [...s.items, id] }),
    clear: () => ({ items: [] }),
  },
});

describe('defineChamberStore - behaviour', () => {

  it('replaces state wholesale and never hands back a deep proxy', ({ bus }) => {
    const cart = useCart(bus);
    const before = cart.state.value;
    cart.add(1);
    expect(cart.state.value).not.toBe(before);   // new object, not mutated
    expect(cart.state.value.items).toEqual([1]);
    expect(before.items).toEqual([]);            // the old snapshot is intact
    cart.$dispose();
    bus.dispose();
  });

  it('mutates ONLY through a dispatch - state has no setter', ({ bus }) => {
    const cart = useCart(bus);
    // `state` is a getter, so a write throws in strict mode instead of opening a second mutation channel.
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
    // `cart$reset` is `$reset()`'s own command (tests/store-reset-command.test.ts).
    expect(inspectBus(bus).actions.sort()).toEqual(['cart$reset', 'cartAdd', 'cartClear']);
    // Dispatching the command directly is equivalent to calling the action -
    // there is one path, not two.
    bus.dispatch('cartAdd', 7);
    expect(cart.state.value.items).toEqual([7]);
    cart.$dispose();
    bus.dispose();
  });

  it('returns the same instance for one id and an independent one for another', ({ bus }) => {
    const useOther = defineChamberStore('wish', { state: () => ({ items: [] as number[] }), reducers: { add: (s, id: number) => ({ items: [...s.items, id] }) } });
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

  it('$reset builds a fresh state, never reusing a nested reference', ({ bus }) => {
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

  it('the existing plugins apply to store actions with no store-specific code; saving is its own option', async ({ bus }) => {
    let saved: unknown = null;
    const cart = defineChamberStore('cart', {
      state: () => ({ items: [] as number[] }),
      reducers: { add: (s, id: number) => ({ items: [...s.items, id] }) },
      persist: saveTo({ key: 'vc:store-test', storage: { getItem: () => null, setItem: (_k: string, v: string) => { saved = JSON.parse(v); } } }),
    })(bus);
    const hist = history({ maxSize: 10, bus });

    cart.add(1);
    cart.add(2);
    await Promise.resolve();
    // Undo observed a store mutation without knowing a store exists, because it was a command.
    expect(saved).toEqual({ items: [1, 2] });
    expect(hist.getState().canUndo).toBe(true);
    cart.$dispose();
    bus.dispose();
  });

  it('reads the registry with a Map, so a store id cannot collide with Object.prototype', ({ bus }) => {
    const useCtor = defineChamberStore('constructor', { state: () => ({ n: 0 }), reducers: { bump: (s) => ({ n: s.n + 1 }) } });
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
    reducers: { setView: (s, view: string) => ({ ...s, view }) },
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

  it('reads a url field through the router and owns no signal for it', ({ bus }) => {
    const router = fakeRouter();
    router.currentRoute.value.location.query.page = '3';
    const catalog = useCatalog(bus, router as never);

    expect(catalog.url.page.value).toBe('3');
    // The store's own state never carried it - that is the single-writer rule.
    expect(Object.keys(catalog.state.value)).toEqual(['view']);
    catalog.$dispose();
    bus.dispose();
  });

  it('writes a url field through setQuery, so the router stays the single writer', ({ bus }) => {
    const router = fakeRouter();
    const catalog = useCatalog(bus, router as never);

    catalog.url.page.set(4);
    expect(router.writes).toEqual([{ page: 4 }]);
    expect(catalog.url.page.value).toBe('4');
    catalog.$dispose();
    bus.dispose();
  });

  it('takes the first value when the query key repeats', ({ bus }) => {
    const router = fakeRouter();
    router.currentRoute.value.location.query.page = ['2', '5'];
    const catalog = useCatalog(bus, router as never);
    expect(catalog.url.page.value).toBe('2');
    catalog.$dispose();
    bus.dispose();
  });

  it('refuses url fields with no router, loudly and by name', ({ bus }) => {
    expect(() => useCatalog(bus)).toThrow(/declares url fields \(page\) and was given no router/);
    bus.dispose();
  });

  it('a store with no url fields needs no router at all', ({ bus }) => {
    const plain = useCart(bus);
    expect(plain.url).toEqual({});
    plain.$dispose();
    bus.dispose();
  });
});
