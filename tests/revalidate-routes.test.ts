// @vitest-environment happy-dom
/**
 * revalidateRoutes: a bus plugin that re-runs the affected loaders and patches the route snapshot after a command that changed server state.
 * Why: the data behind the current route would stay stale after a successful command. The plugin composes two public surfaces (`runLoaders`, `setRouteData`) and adds no router capability. It ships router-side on the existing `vapor-chamber/router` entry, because nothing public re-runs a loader (`reload()` reloads the table, not data) and a subpath would isolate no cost. `loaders` is an argument, because the router exposes its LoaderHandlers nowhere and a second preset would diverge from the router's own. The plugin owns its `isRevalidating` flag, because `router.isRevalidating` is read-only, its only writer (the engine's `trackRevalidation`) is not public, and a second writer to the router's state would break the composition; a consumer wanting one spinner ORs the two flags.
 * Shows: the public surface the plugin composes; the map refreshes matching commands only and never after a failure; 'affected' resolves to the current load chain; wiring mistakes and failed refreshes are reported (onError, else console.error) without failing the command; dispose and superseded navigations drop refreshes; the plugin's own flag stays up until the last overlapping refresh settles; a refresh aborts only an overlapping refresh of the same record.
 * See: docs/router.md, docs/whitepaper.md 8.2
 */

import { describe, expect, it, vi } from 'vitest';
import { createAsyncCommandBus, createCommandBus } from '../src/command-bus';
import { matchesPattern } from '../src/pattern';
import { isRouterError } from '@router/errors';
import type { LoaderHandlers } from '@router/loaders';
import { revalidateRoutes, type RevalidatePlugin } from '@router/revalidate';
import { createMemoryHistory } from '@router/history';
import { createRouter, runLoaders } from '@router/index';
import type { Router } from '@router/router-type';

const ROWS = [
  { name: 'shop', path: '/', component: 'Shell' },
  { name: 'shop.cart', path: '/cart', component: 'Cart', load: 'rows:cart' },
];

const settle = () => new Promise((r) => setTimeout(r, 0));
const LOADERS = (fn: () => unknown): LoaderHandlers => ({ prefixes: { 'rows:': () => fn() } });

/** One command settled on a real bus the plugin is installed on: a success, or a handler's throw. */
function fire(plugin: RevalidatePlugin, action: string, ok = true) {
  const bus = createCommandBus();
  bus.register(action, ok ? () => 'ok' : () => { throw new Error('nope'); });
  bus.use(plugin as never);
  return bus.dispatch(action, {});
}
function fireAsync(plugin: RevalidatePlugin, action: string, ok = true) {
  const bus = createAsyncCommandBus({ retry: false });
  bus.register(action, async () => { if (!ok) throw new Error('nope'); return 'ok'; });
  bus.use(plugin as never);
  return bus.dispatch(action, {});
}

function makeRouter(onLoad: () => unknown) {
  return createRouter({
    history: createMemoryHistory(''),
    routes: ROWS as never,
    components: { Shell: { render: () => null }, Cart: { render: () => null } } as never,
    loaders: { prefixes: { 'rows:': () => onLoad() } },
    links: false,
    scroll: false,
    onError: () => {},
  });
}

// If any of these changes, the plugin's design premise changed with it.
describe('composition surface - the plugin depends on exactly this', () => {
  it('exports runLoaders from the router entry', () => {
    expect(typeof runLoaders).toBe('function');
  });

  it('exposes setRouteData as public API on the router', async () => {
    const router = makeRouter(() => ({ items: [] }));
    await router.isReady();
    expect(typeof router.setRouteData).toBe('function');
    router.dispose();
  });

  it('exposes the current matched records, which is what "affected" resolves against', async () => {
    const router = makeRouter(() => ({ items: [] }));
    await router.isReady();
    await router.push('/cart');

    const matched = router.currentRoute.value.location.matched;
    expect(matched.map((r) => r.name)).toContain('shop.cart');
    // The load chain is precomputed on the record; the plugin re-runs it.
    expect(matched[matched.length - 1]?.loadChain.map((r) => r.name)).toEqual(['shop.cart']);
    router.dispose();
  });

  it('reuses the bus pattern matcher rather than inventing glob semantics', () => {
    expect(matchesPattern('cart*', 'cartAdd')).toBe(true);
    expect(matchesPattern('cart*', 'orderCreate')).toBe(false);
    expect(matchesPattern('*', 'anything')).toBe(true);
  });

  it('does NOT expose trackRevalidation - the constraint behind decision 2', async () => {
    const router = makeRouter(() => ({ items: [] }));
    await router.isReady();
    // If this becomes public, the plugin could drive router.isRevalidating itself.
    expect((router as unknown as Record<string, unknown>).trackRevalidation).toBeUndefined();
    router.dispose();
  });

  it('types isRevalidating as read-only, which is why the plugin owns its own flag', async () => {
    const router = makeRouter(() => ({ items: [] }));
    await router.isReady();
    // Runtime shape only: the Readonly<> is compile-time, so this pins only that the flag exists and starts false.
    const typed: Router = router;
    expect(typed.isRevalidating.value).toBe(false);
    router.dispose();
  });
});

describe('revalidateRoutes - behaviour', () => {
  it('refreshes the mapped record data after a matching command', async () => {
    let n = 0;
    const router = makeRouter(() => ({ n: ++n }));
    await router.isReady();
    await router.push('/cart');
    expect(router.currentRoute.value.data.get('shop.cart')).toEqual({ n: 1 });

    const plugin = revalidateRoutes(router, LOADERS(() => ({ n: ++n })), { 'cart*': ['shop.cart'] });
    fire(plugin, 'cartAdd');
    await settle();

    expect(router.currentRoute.value.data.get('shop.cart')).toEqual({ n: 2 });
    plugin.dispose();
    router.dispose();
  });

  it('performs ZERO loader fetches for a non-matching command', async () => {
    let n = 0;
    const router = makeRouter(() => ({ n: ++n }));
    await router.isReady();
    await router.push('/cart');
    const before = n;

    const plugin = revalidateRoutes(router, LOADERS(() => ({ n: ++n })), { 'cart*': ['shop.cart'] });
    fire(plugin, 'orderCreate');
    await settle();

    expect(n).toBe(before);
    plugin.dispose();
    router.dispose();
  });

  it('does not refresh when the command itself failed', async () => {
    let n = 0;
    const router = makeRouter(() => ({ n: ++n }));
    await router.isReady();
    await router.push('/cart');
    const before = n;

    const plugin = revalidateRoutes(router, LOADERS(() => ({ n: ++n })), { 'cart*': ['shop.cart'] });
    fire(plugin, 'cartAdd', false);
    await settle();

    expect(n).toBe(before);
    plugin.dispose();
    router.dispose();
  });

  it("resolves 'affected' to the current snapshot load chain", async () => {
    let n = 0;
    const router = makeRouter(() => ({ n: ++n }));
    await router.isReady();
    await router.push('/cart');

    const plugin = revalidateRoutes(router, LOADERS(() => ({ n: ++n })), { productSave: 'affected' });
    fire(plugin, 'productSave');
    await settle();

    expect(router.currentRoute.value.data.get('shop.cart')).toEqual({ n: 2 });
    plugin.dispose();
    router.dispose();
  });

  it('reports a record that is not in the current chain as a coded error, through onError', async () => {
    const router = makeRouter(() => ({ ok: 1 }));
    await router.isReady();
    await router.push('/cart');

    const onError = vi.fn();
    const plugin = revalidateRoutes(router, LOADERS(() => ({ ok: 1 })), { 'cart*': ['nope'] }, { onError });
    const result = fire(plugin, 'cartAdd');
    expect(result).toMatchObject({ ok: true });
    expect(isRouterError(onError.mock.calls[0]?.[0], 'router:missing:record')).toBe(true);
    plugin.dispose();
    router.dispose();
  });

  it('a wiring mistake never turns a succeeded command into a failure', async () => {
    const router = makeRouter(() => ({ ok: 1 }));
    await router.isReady();
    await router.push('/cart');

    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bus = createCommandBus();
    bus.register('cartAdd', () => 'added');
    const plugin = revalidateRoutes(router, LOADERS(() => ({ ok: 1 })), { 'cart*': ['nope'] });
    bus.use(plugin as never);
    expect(bus.dispatch('cartAdd', {})).toMatchObject({ ok: true, value: 'added' });
    expect(errors).toHaveBeenCalled();
    plugin.dispose();
    router.dispose();
  });

  it('stops revalidating after dispose', async () => {
    let n = 0;
    const router = makeRouter(() => ({ n: ++n }));
    await router.isReady();
    await router.push('/cart');
    const before = n;

    const plugin = revalidateRoutes(router, LOADERS(() => ({ n: ++n })), { 'cart*': ['shop.cart'] });
    plugin.dispose();
    fire(plugin, 'cartAdd');
    await settle();

    expect(n).toBe(before);
    router.dispose();
  });

  it('awaits an async bus result before refreshing', async () => {
    let n = 0;
    const router = makeRouter(() => ({ n: ++n }));
    await router.isReady();
    await router.push('/cart');

    const plugin = revalidateRoutes(router, LOADERS(() => ({ n: ++n })), { 'cart*': ['shop.cart'] });
    void fireAsync(plugin, 'cartAdd');
    await settle();

    expect(router.currentRoute.value.data.get('shop.cart')).toEqual({ n: 2 });
    plugin.dispose();
    router.dispose();
  });

  it('flips its OWN isRevalidating and never the router\'s (decision 2)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const router = makeRouter(() => ({ v: 0 }));
    await router.isReady();
    await router.push('/cart');

    const plugin = revalidateRoutes(router, LOADERS(async () => { await gate; return { v: 1 }; }), {
      'cart*': ['shop.cart'],
    });
    expect(plugin.isRevalidating.value).toBe(false);

    fire(plugin, 'cartAdd');
    await settle();
    expect(plugin.isRevalidating.value).toBe(true);
    // The router's flag belongs to the loader-driven channel and must not move.
    expect(router.isRevalidating.value).toBe(false);

    release();
    await settle();
    expect(plugin.isRevalidating.value).toBe(false);
    plugin.dispose();
    router.dispose();
  });

  it('leaves stale data in place when a refresh rejects, and reports it', async () => {
    const router = makeRouter(() => ({ good: true }));
    await router.isReady();
    await router.push('/cart');

    const errors: unknown[] = [];
    const plugin = revalidateRoutes(
      router,
      LOADERS(() => { throw new Error('backend down'); }),
      { 'cart*': ['shop.cart'] },
      { onError: (e) => errors.push(e) },
    );
    fire(plugin, 'cartAdd');
    await settle();

    expect(errors).toHaveLength(1);
    expect(router.currentRoute.value.data.get('shop.cart')).toEqual({ good: true });
    plugin.dispose();
    router.dispose();
  });

  it('reads the map with Object.hasOwn - patterns are external strings', async () => {
    let n = 0;
    const router = makeRouter(() => ({ n: ++n }));
    await router.isReady();
    await router.push('/cart');
    const before = n;

    const plugin = revalidateRoutes(router, LOADERS(() => ({ n: ++n })), {});
    // `constructor` is on Object.prototype; a `map[action]` lookup would treat it as a configured target.
    fire(plugin, 'constructor');
    fire(plugin, 'toString');
    await settle();

    expect(n).toBe(before);
    plugin.dispose();
    router.dispose();
  });
});

describe('revalidateRoutes - edges', () => {
  it("treats '*' as every command", async () => {
    let n = 0;
    const router = makeRouter(() => ({ n: ++n }));
    await router.isReady();
    await router.push('/cart');

    const plugin = revalidateRoutes(router, LOADERS(() => ({ n: ++n })), { '*': ['shop.cart'] });
    fire(plugin, 'literallyAnything');
    await settle();

    expect(router.currentRoute.value.data.get('shop.cart')).toEqual({ n: 2 });
    plugin.dispose();
    router.dispose();
  });

  it('is a no-op before the first navigation, when nothing is matched', async () => {
    let n = 0;
    const router = makeRouter(() => ({ n: ++n }));
    // Not ready on purpose: START_LOCATION matches nothing, so no leaf resolves a chain.
    const plugin = revalidateRoutes(router, LOADERS(() => ({ n: ++n })), { '*': 'affected' });
    expect(() => fire(plugin, 'cartAdd')).not.toThrow();
    await settle();
    expect(n).toBe(0);
    plugin.dispose();
    router.dispose();
  });

  it("is a no-op for 'affected' on a route with no loaders", async () => {
    let n = 0;
    const router = makeRouter(() => ({ n: ++n }));
    await router.isReady(); // '/' is shop, which declares no `load`
    const before = n;

    const plugin = revalidateRoutes(router, LOADERS(() => ({ n: ++n })), { '*': 'affected' });
    fire(plugin, 'cartAdd');
    await settle();

    expect(n).toBe(before);
    plugin.dispose();
    router.dispose();
  });

  it("names an empty chain as 'none' in the unknown-record error", async () => {
    const router = makeRouter(() => ({ v: 1 }));
    await router.isReady(); // on '/', no loader-bearing records at all

    const onError = vi.fn();
    const plugin = revalidateRoutes(router, LOADERS(() => ({ v: 1 })), { '*': ['shop.cart'] }, { onError });
    fire(plugin, 'cartAdd');
    const caught = onError.mock.calls[0]?.[0];
    expect(isRouterError(caught, 'router:missing:record')).toBe(true);
    expect(String((caught as Error).message)).toContain('none');
    plugin.dispose();
    router.dispose();
  });

  it('drops a refresh whose navigation was superseded before it resolved', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const router = makeRouter(() => ({ page: 'cart' }));
    await router.isReady();
    await router.push('/cart');

    const plugin = revalidateRoutes(router, LOADERS(async () => { await gate; return { page: 'STALE' }; }), {
      'cart*': ['shop.cart'],
    });
    fire(plugin, 'cartAdd');
    await settle();

    await router.push('/'); // navigate away while the refresh is open
    release();
    await settle();

    // The value belongs to a page nobody is looking at, so it must not land.
    expect(router.currentRoute.value.data.get('shop.cart')).toBeUndefined();
    plugin.dispose();
    router.dispose();
  });

  it('abandons an in-flight refresh when disposed mid-flight', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const router = makeRouter(() => ({ v: 'first' }));
    await router.isReady();
    await router.push('/cart');

    const plugin = revalidateRoutes(router, LOADERS(async () => { await gate; return { v: 'second' }; }), {
      'cart*': ['shop.cart'],
    });
    fire(plugin, 'cartAdd');
    await settle();
    plugin.dispose();
    release();
    await settle();

    expect(router.currentRoute.value.data.get('shop.cart')).toEqual({ v: 'first' });
    expect(plugin.isRevalidating.value).toBe(false);
    router.dispose();
  });

  it('logs to console.error when no onError is supplied', async () => {
    const seen: unknown[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { seen.push(a[0]); });
    const router = makeRouter(() => ({ ok: true }));
    await router.isReady();
    await router.push('/cart');

    const plugin = revalidateRoutes(router, LOADERS(() => { throw new Error('down'); }), { 'cart*': ['shop.cart'] });
    fire(plugin, 'cartAdd');
    await settle();

    expect(seen.some((m) => String(m).includes('revalidateRoutes refresh failed'))).toBe(true);
    spy.mockRestore();
    plugin.dispose();
    router.dispose();
  });

  it('keeps the flag up until the LAST of several refreshes settles', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const router = makeRouter(() => ({ v: 0 }));
    await router.isReady();
    await router.push('/cart');

    const plugin = revalidateRoutes(router, LOADERS(async () => { await gate; return { v: 1 }; }), {
      'cart*': ['shop.cart'],
    });
    fire(plugin, 'cartAdd');
    await settle();
    fire(plugin, 'cartRemove');
    await settle();
    expect(plugin.isRevalidating.value).toBe(true);

    release();
    await settle();
    expect(plugin.isRevalidating.value).toBe(false);
    plugin.dispose();
    router.dispose();
  });

  it('stays silent when an aborted refresh rejects rather than resolves', async () => {
    // dispose() aborts and runLoaders maps the aborted signal to a `router:aborted:navigation` rejection; a refusal the plugin caused must not reach onError or the console.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const seen: unknown[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { seen.push(a[0]); });
    const errors: unknown[] = [];

    const router = makeRouter(() => ({ v: 'first' }));
    await router.isReady();
    await router.push('/cart');

    const plugin = revalidateRoutes(
      router,
      LOADERS(async () => { await gate; throw new Error('boom'); }),
      { 'cart*': ['shop.cart'] },
      { onError: (e) => errors.push(e) },
    );
    fire(plugin, 'cartAdd');
    await settle();
    plugin.dispose();
    release();
    await settle();

    expect(errors).toHaveLength(0);
    expect(seen).toHaveLength(0);
    spy.mockRestore();
    router.dispose();
  });

  it('does not refresh when an async command resolves not-ok', async () => {
    let n = 0;
    const router = makeRouter(() => ({ n: ++n }));
    await router.isReady();
    await router.push('/cart');
    const before = n;

    const plugin = revalidateRoutes(router, LOADERS(() => ({ n: ++n })), { 'cart*': ['shop.cart'] });
    void fireAsync(plugin, 'cartAdd', false);
    await settle();

    expect(n).toBe(before);
    plugin.dispose();
    router.dispose();
  });
});

// One controller per refresh, aborted only by a refresh that overlaps it: a shared controller would let a refresh of one record discard another's fresh data, leaving stale data with no error.
describe('revalidateRoutes - overlapping refreshes only', () => {
  const TWO_ROWS = [
    { name: 'shop', path: '/', component: 'Shell' },
    { name: 'shop.cart', path: '/cart', component: 'Cart', load: 'rows:cart' },
    { name: 'shop.wish', path: '/cart/wish', parent: 'shop.cart', component: 'Wish', load: 'rows:wish' },
  ];

  /** Both records load; each returns a counter naming itself. */
  function twoRecordRouter(counts: Record<string, number>) {
    return createRouter({
      history: createMemoryHistory(''),
      routes: TWO_ROWS as never,
      components: {
        Shell: { render: () => null },
        Cart: { render: () => null },
        Wish: { render: () => null },
      } as never,
      loaders: {
        prefixes: {
          'rows:': (ref: string) => {
            counts[ref] = (counts[ref] ?? 0) + 1;
            return { ref, n: counts[ref] };
          },
        },
      },
      links: false,
      scroll: false,
      onError: () => {},
    });
  }

  it('does not let a wishlist refresh discard the cart refresh', async () => {
    const counts: Record<string, number> = {};
    const router = twoRecordRouter(counts);
    await router.isReady();
    await router.push('/cart/wish');

    const loaders: LoaderHandlers = {
      prefixes: {
        'rows:': (ref: string) => {
          counts[ref] = (counts[ref] ?? 0) + 1;
          return { ref, n: counts[ref] };
        },
      },
    };
    const plugin = revalidateRoutes(router, loaders, {
      cartAdd: ['shop.cart'],
      wishAdd: ['shop.wish'],
    });

    const cartBefore = router.currentRoute.value.data.get('shop.cart');
    fire(plugin, 'cartAdd');
    fire(plugin, 'wishAdd');
    await settle();

    // Both landed: an aborted cart refresh would leave its value as it was before the command.
    expect(router.currentRoute.value.data.get('shop.cart')).not.toEqual(cartBefore);
    expect((router.currentRoute.value.data.get('shop.wish') as { ref: string }).ref).toBe('wish');

    plugin.dispose();
    router.dispose();
  });

  it('still lets the later refresh of the SAME record win', async () => {
    const counts: Record<string, number> = {};
    const router = twoRecordRouter(counts);
    await router.isReady();
    await router.push('/cart/wish');

    const loaders: LoaderHandlers = {
      prefixes: {
        'rows:': async (ref: string) => {
          counts[ref] = (counts[ref] ?? 0) + 1;
          return { ref, n: counts[ref] };
        },
      },
    };
    const plugin = revalidateRoutes(router, loaders, { cartAdd: ['shop.cart'] });

    fire(plugin, 'cartAdd');
    fire(plugin, 'cartAdd');
    await settle();

    // The first was superseded, not merged: the committed value is the later run's.
    expect((router.currentRoute.value.data.get('shop.cart') as { n: number }).n).toBe(counts.cart);
    expect(plugin.isRevalidating.value).toBe(false);

    plugin.dispose();
    router.dispose();
  });

  it('clears the flag after dispose without letting a late finally reopen it', async () => {
    const counts: Record<string, number> = {};
    const router = twoRecordRouter(counts);
    await router.isReady();
    await router.push('/cart/wish');

    const plugin = revalidateRoutes(
      router,
      { prefixes: { 'rows:': async (ref: string) => ({ ref }) } },
      { cartAdd: ['shop.cart'] },
    );
    fire(plugin, 'cartAdd');
    plugin.dispose();
    await settle();

    expect(plugin.isRevalidating.value).toBe(false);
    router.dispose();
  });
});
