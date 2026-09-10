// @vitest-environment happy-dom
/**
 * ACCEPTANCE CRITERIA for `revalidateRoutes`, written against pattern C of
 * the composition plan, which has since been deleted into docs/router.md and
 * docs/whitepaper.md 11.9. git has it.
 *
 * Committed BEFORE the implementation, deliberately - and it earned that order
 * immediately: writing the criteria against today's exports falsified one plan
 * claim (decision 2) and writing the implementation against them overturned the
 * placement the criteria had assumed (decision 1). Both are recorded here as
 * revisions rather than quietly rewritten, because the reasoning is the part
 * worth keeping.
 *
 * WHAT IT IS. A bus plugin. After a command that changed server state, the
 * data behind the current route is stale; the plugin re-runs the affected
 * loaders and patches the snapshot. The router already owns every piece -
 * `runLoaders` is exported, `setRouteData` is public API - so this composes two
 * public surfaces and adds no router capability.
 *
 * ============================================================================
 * DECISION 1 - PLACEMENT: router-side, on the existing entry (revised twice).
 * ============================================================================
 *
 * The choice was between (a) living with the bus plugins and taking the router
 * as a structurally-typed argument, and (b) a router-adjacent subpath.
 *
 * Neither, in the end - router-side, but on the EXISTING entry rather than a
 * subpath. Both revisions are below, and they are the useful half.
 *
 * Stage 1 chose (a) by counting edges: `src/router/**` imports nothing from the
 * bus, `src/index.ts` imports nothing from the router, so hosting the plugin on
 * the router would create an edge that does not exist. True, and not decisive,
 * because it weighed the two edges as if they were equal. They are not.
 *
 * Writing the implementation settled it in one step. The plugin's core move is
 * `runLoaders(...)`, and there is NO public substitute - `reload()` reloads the
 * TABLE, not data, and nothing else on the `Router` type re-runs a loader. So
 * bus-side would have had to import a router module into the root barrel, which
 * is precisely what the constraint forbids. What it needs from the BUS, by
 * contrast, is one function shape - `(cmd, next) => result` - declared inline in
 * the implementation, importing nothing.
 *
 * Deep one way, shallow the other. The edge exists in one direction and it is
 * the cheap one, so it ships router-side - from the EXISTING
 * `vapor-chamber/router` entry, not a subpath of its own. Minting one added a
 * Vite build entry, which re-chunked shared code and dropped the outlet size
 * guard from 20.02 to 19.90 with the outlet itself untouched. A subpath exists
 * to isolate cost; this module imports nothing the router core lacks, so there
 * was none to isolate - and it tree-shakes for anyone who never calls it.
 *
 * ============================================================================
 * DECISION 3 - `loaders` is an argument, and the plan's example could not work.
 * ============================================================================
 *
 * Section 4C sketches `revalidateRoutes(router, MAP)`. `createRouter` closes
 * over its `LoaderHandlers` and exposes them nowhere, so a two-argument form
 * would have to construct a SECOND preset - a second HTTP client, a second
 * cache - silently diverging from the one the router actually uses. Passing the
 * same instance is the composition's one wiring cost, and it is honest.
 *
 * ============================================================================
 * DECISION 2 - `isRevalidating` does NOT flip, and this corrects a plan claim.
 * ============================================================================
 *
 * Section 4C claims "**`isRevalidating` drives the UI for free**". It does not,
 * and cannot, for a plugin restricted to the public surface:
 *
 *   - `router.isRevalidating` is typed `Readonly<ShallowRef<boolean>>`.
 *   - the only writer is the engine's `trackRevalidation`, which is returned by
 *     `createEngine` but is NOT on the `router` object literal and NOT on the
 *     `Router` type - it is wired solely into `runLoaders`' `onRevalidate`.
 *
 * So the flag is reachable only by casting away `Readonly` and writing another
 * module's signal, or by adding router surface. The brief forbids both, and it
 * is right to: a plugin that reaches into the engine stops being a composition
 * of public surfaces and becomes a second writer to the router's own state.
 *
 * The decision is therefore to expose the plugin's OWN `isRevalidating` signal,
 * and for `router.isRevalidating` to stay exactly what it documents: true while
 * a LOADER hands the engine a refresh through `ctx.revalidate`. Two independent
 * refresh sources get two flags rather than one flag with two writers, and a
 * consumer that wants a single spinner ORs them - which is a line of app code,
 * not a router change.
 *
 * The pinned consequence is asserted below: the plan's phrasing is wrong, and
 * the acceptance file records that rather than quietly building around it.
 */

import { describe, expect, it, vi } from 'vitest';
import { matchesPattern } from '../src/command-bus';
import { isRouterError } from '../src/router/errors';
import type { LoaderHandlers } from '../src/router/loaders';
import { revalidateRoutes } from '../src/router/revalidate';
import { createMemoryHistory } from '../src/router/history';
import { createRouter, runLoaders } from '../src/router/index';
import type { Router } from '../src/router/router-type';

const ROWS = [
  { name: 'shop', path: '/', component: 'Shell' },
  { name: 'shop.cart', path: '/cart', component: 'Cart', load: 'rows:cart' },
];

const settle = () => new Promise((r) => setTimeout(r, 0));
const LOADERS = (fn: () => unknown): LoaderHandlers => ({ prefixes: { 'rows:': () => fn() } });

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

/**
 * The surface the plugin will compose. These are real assertions today: if any
 * of them changes, the plugin's design premise changed with it, and this file
 * says so before the implementation is written rather than after it breaks.
 */
describe('composition surface - the plugin depends on exactly this', () => {
  it('exports runLoaders from the router entry', () => {
    expect(typeof runLoaders).toBe('function');
  });

  it('exposes setRouteData as public API on the router', async () => {
    const router = makeRouter(() => ({ items: [] }));
    await router.isReady();
    expect(typeof router.setRouteData).toBe('function');
    router.destroy();
  });

  it('exposes the current matched records, which is what "affected" resolves against', async () => {
    const router = makeRouter(() => ({ items: [] }));
    await router.isReady();
    await router.push('/cart');

    const matched = router.currentRoute.value.location.matched;
    expect(matched.map((r) => r.name)).toContain('shop.cart');
    // The load chain is precomputed on the record - the plugin re-runs this,
    // it does not rediscover it.
    expect(matched[matched.length - 1]?.loadChain.map((r) => r.name)).toEqual(['shop.cart']);
    router.destroy();
  });

  it('reuses the bus pattern matcher rather than inventing glob semantics', () => {
    expect(matchesPattern('cart*', 'cartAdd')).toBe(true);
    expect(matchesPattern('cart*', 'orderCreate')).toBe(false);
    expect(matchesPattern('*', 'anything')).toBe(true);
  });

  it('does NOT expose trackRevalidation - the constraint behind decision 2', async () => {
    const router = makeRouter(() => ({ items: [] }));
    await router.isReady();
    // If this ever becomes public, decision 2 is worth revisiting: the plugin
    // could then drive router.isRevalidating without reaching into internals.
    expect((router as unknown as Record<string, unknown>).trackRevalidation).toBeUndefined();
    router.destroy();
  });

  it('types isRevalidating as read-only, which is why the plugin owns its own flag', async () => {
    const router = makeRouter(() => ({ items: [] }));
    await router.isReady();
    // Runtime shape only - the Readonly<> is compile-time. Asserting the value
    // exists and starts false pins what the plugin must NOT try to drive.
    const typed: Router = router;
    expect(typed.isRevalidating.value).toBe(false);
    router.destroy();
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
    plugin({ action: 'cartAdd' }, () => ({ ok: true }));
    await settle();

    expect(router.currentRoute.value.data.get('shop.cart')).toEqual({ n: 2 });
    plugin.dispose();
    router.destroy();
  });

  it('performs ZERO loader fetches for a non-matching command', async () => {
    let n = 0;
    const router = makeRouter(() => ({ n: ++n }));
    await router.isReady();
    await router.push('/cart');
    const before = n;

    const plugin = revalidateRoutes(router, LOADERS(() => ({ n: ++n })), { 'cart*': ['shop.cart'] });
    plugin({ action: 'orderCreate' }, () => ({ ok: true }));
    await settle();

    expect(n).toBe(before);
    plugin.dispose();
    router.destroy();
  });

  it('does not refresh when the command itself failed', async () => {
    let n = 0;
    const router = makeRouter(() => ({ n: ++n }));
    await router.isReady();
    await router.push('/cart');
    const before = n;

    const plugin = revalidateRoutes(router, LOADERS(() => ({ n: ++n })), { 'cart*': ['shop.cart'] });
    plugin({ action: 'cartAdd' }, () => ({ ok: false, error: new Error('nope') }));
    await settle();

    expect(n).toBe(before);
    plugin.dispose();
    router.destroy();
  });

  it("resolves 'affected' to the current snapshot load chain", async () => {
    let n = 0;
    const router = makeRouter(() => ({ n: ++n }));
    await router.isReady();
    await router.push('/cart');

    const plugin = revalidateRoutes(router, LOADERS(() => ({ n: ++n })), { productSave: 'affected' });
    plugin({ action: 'productSave' }, () => ({ ok: true }));
    await settle();

    expect(router.currentRoute.value.data.get('shop.cart')).toEqual({ n: 2 });
    plugin.dispose();
    router.destroy();
  });

  it('raises a loud coded error for a record that is not in the current chain', async () => {
    const router = makeRouter(() => ({ ok: 1 }));
    await router.isReady();
    await router.push('/cart');

    const plugin = revalidateRoutes(router, LOADERS(() => ({ ok: 1 })), { 'cart*': ['nope'] });
    let caught: unknown;
    try {
      plugin({ action: 'cartAdd' }, () => ({ ok: true }));
    } catch (error) {
      caught = error;
    }
    expect(isRouterError(caught, 'unknown_route_name')).toBe(true);
    plugin.dispose();
    router.destroy();
  });

  it('stops revalidating after dispose', async () => {
    let n = 0;
    const router = makeRouter(() => ({ n: ++n }));
    await router.isReady();
    await router.push('/cart');
    const before = n;

    const plugin = revalidateRoutes(router, LOADERS(() => ({ n: ++n })), { 'cart*': ['shop.cart'] });
    plugin.dispose();
    plugin({ action: 'cartAdd' }, () => ({ ok: true }));
    await settle();

    expect(n).toBe(before);
    router.destroy();
  });

  it('awaits an async bus result before refreshing', async () => {
    let n = 0;
    const router = makeRouter(() => ({ n: ++n }));
    await router.isReady();
    await router.push('/cart');

    const plugin = revalidateRoutes(router, LOADERS(() => ({ n: ++n })), { 'cart*': ['shop.cart'] });
    plugin({ action: 'cartAdd' }, () => Promise.resolve({ ok: true }));
    await settle();

    expect(router.currentRoute.value.data.get('shop.cart')).toEqual({ n: 2 });
    plugin.dispose();
    router.destroy();
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

    plugin({ action: 'cartAdd' }, () => ({ ok: true }));
    await settle();
    expect(plugin.isRevalidating.value).toBe(true);
    // The router's flag belongs to the loader-driven channel and must not move.
    expect(router.isRevalidating.value).toBe(false);

    release();
    await settle();
    expect(plugin.isRevalidating.value).toBe(false);
    plugin.dispose();
    router.destroy();
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
    plugin({ action: 'cartAdd' }, () => ({ ok: true }));
    await settle();

    expect(errors).toHaveLength(1);
    expect(router.currentRoute.value.data.get('shop.cart')).toEqual({ good: true });
    plugin.dispose();
    router.destroy();
  });

  it('reads the map with Object.hasOwn - patterns are external strings', async () => {
    let n = 0;
    const router = makeRouter(() => ({ n: ++n }));
    await router.isReady();
    await router.push('/cart');
    const before = n;

    const plugin = revalidateRoutes(router, LOADERS(() => ({ n: ++n })), {});
    // `constructor` is on Object.prototype; a `map[action]` lookup would find
    // it and treat it as a configured target.
    plugin({ action: 'constructor' }, () => ({ ok: true }));
    plugin({ action: 'toString' }, () => ({ ok: true }));
    await settle();

    expect(n).toBe(before);
    plugin.dispose();
    router.destroy();
  });
});

describe('revalidateRoutes - edges', () => {
  it("treats '*' as every command", async () => {
    let n = 0;
    const router = makeRouter(() => ({ n: ++n }));
    await router.isReady();
    await router.push('/cart');

    const plugin = revalidateRoutes(router, LOADERS(() => ({ n: ++n })), { '*': ['shop.cart'] });
    plugin({ action: 'literallyAnything' }, () => ({ ok: true }));
    await settle();

    expect(router.currentRoute.value.data.get('shop.cart')).toEqual({ n: 2 });
    plugin.dispose();
    router.destroy();
  });

  it('is a no-op before the first navigation, when nothing is matched', async () => {
    let n = 0;
    const router = makeRouter(() => ({ n: ++n }));
    // Deliberately NOT ready: START_LOCATION matches nothing, so there is no
    // leaf to resolve a chain against.
    const plugin = revalidateRoutes(router, LOADERS(() => ({ n: ++n })), { '*': 'affected' });
    expect(() => plugin({ action: 'cartAdd' }, () => ({ ok: true }))).not.toThrow();
    await settle();
    expect(n).toBe(0);
    plugin.dispose();
    router.destroy();
  });

  it("is a no-op for 'affected' on a route with no loaders", async () => {
    let n = 0;
    const router = makeRouter(() => ({ n: ++n }));
    await router.isReady();   // '/' -> shop, which declares no `load`
    const before = n;

    const plugin = revalidateRoutes(router, LOADERS(() => ({ n: ++n })), { '*': 'affected' });
    plugin({ action: 'cartAdd' }, () => ({ ok: true }));
    await settle();

    expect(n).toBe(before);
    plugin.dispose();
    router.destroy();
  });

  it("names an empty chain as 'none' in the unknown-record error", async () => {
    const router = makeRouter(() => ({ v: 1 }));
    await router.isReady();   // on '/', no loader-bearing records at all

    const plugin = revalidateRoutes(router, LOADERS(() => ({ v: 1 })), { '*': ['shop.cart'] });
    let caught: unknown;
    try {
      plugin({ action: 'cartAdd' }, () => ({ ok: true }));
    } catch (error) {
      caught = error;
    }
    expect(isRouterError(caught, 'unknown_route_name')).toBe(true);
    expect(String((caught as Error).message)).toContain('none');
    plugin.dispose();
    router.destroy();
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
    plugin({ action: 'cartAdd' }, () => ({ ok: true }));
    await settle();

    await router.push('/');          // navigate away while the refresh is open
    release();
    await settle();

    // The value belongs to a page nobody is looking at, so it must not land.
    expect(router.currentRoute.value.data.get('shop.cart')).toBeUndefined();
    plugin.dispose();
    router.destroy();
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
    plugin({ action: 'cartAdd' }, () => ({ ok: true }));
    await settle();
    plugin.dispose();
    release();
    await settle();

    expect(router.currentRoute.value.data.get('shop.cart')).toEqual({ v: 'first' });
    expect(plugin.isRevalidating.value).toBe(false);
    router.destroy();
  });

  it('logs to console.error when no onError is supplied', async () => {
    const seen: unknown[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { seen.push(a[0]); });
    const router = makeRouter(() => ({ ok: true }));
    await router.isReady();
    await router.push('/cart');

    const plugin = revalidateRoutes(router, LOADERS(() => { throw new Error('down'); }), { 'cart*': ['shop.cart'] });
    plugin({ action: 'cartAdd' }, () => ({ ok: true }));
    await settle();

    expect(seen.some((m) => String(m).includes('revalidateRoutes refresh failed'))).toBe(true);
    spy.mockRestore();
    plugin.dispose();
    router.destroy();
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
    plugin({ action: 'cartAdd' }, () => ({ ok: true }));
    await settle();
    plugin({ action: 'cartRemove' }, () => ({ ok: true }));
    await settle();
    expect(plugin.isRevalidating.value).toBe(true);

    release();
    await settle();
    expect(plugin.isRevalidating.value).toBe(false);
    plugin.dispose();
    router.destroy();
  });

  it('stays silent when an aborted refresh rejects rather than resolves', async () => {
    // The other half of the abort story: dispose() aborts, and runLoaders maps
    // an aborted signal to a coded 'cancelled' rejection. That is a refusal we
    // caused, so it must not reach onError or the console.
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
    plugin({ action: 'cartAdd' }, () => ({ ok: true }));
    await settle();
    plugin.dispose();
    release();
    await settle();

    expect(errors).toHaveLength(0);
    expect(seen).toHaveLength(0);
    spy.mockRestore();
    router.destroy();
  });

  it('does not refresh when an async command resolves not-ok', async () => {
    let n = 0;
    const router = makeRouter(() => ({ n: ++n }));
    await router.isReady();
    await router.push('/cart');
    const before = n;

    const plugin = revalidateRoutes(router, LOADERS(() => ({ n: ++n })), { 'cart*': ['shop.cart'] });
    plugin({ action: 'cartAdd' }, () => Promise.resolve({ ok: false }));
    await settle();

    expect(n).toBe(before);
    plugin.dispose();
    router.destroy();
  });
});

/**
 * One controller per refresh, aborted only by a refresh that overlaps it.
 *
 * A single shared AbortController made every revalidation cancel every other
 * one whatever it was refreshing. Two commands in a row mapped to different
 * records meant the second aborted the first, the first record's fresh data was
 * discarded, and nothing retried it. The command had succeeded, so the page
 * kept stale data with no error anywhere - the exact outcome this plugin exists
 * to prevent.
 */
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
    plugin({ action: 'cartAdd' }, () => ({ ok: true }));
    plugin({ action: 'wishAdd' }, () => ({ ok: true }));
    await settle();

    // Both landed. The cart's refresh used to be aborted by the wishlist's and
    // its value stayed exactly as it was before the command.
    expect(router.currentRoute.value.data.get('shop.cart')).not.toEqual(cartBefore);
    expect((router.currentRoute.value.data.get('shop.wish') as { ref: string }).ref).toBe('wish');

    plugin.dispose();
    router.destroy();
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

    plugin({ action: 'cartAdd' }, () => ({ ok: true }));
    plugin({ action: 'cartAdd' }, () => ({ ok: true }));
    await settle();

    // The first was superseded, not merged: the committed value is the later
    // run's, and the flag is back down.
    expect((router.currentRoute.value.data.get('shop.cart') as { n: number }).n).toBe(counts.cart);
    expect(plugin.isRevalidating.value).toBe(false);

    plugin.dispose();
    router.destroy();
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
    plugin({ action: 'cartAdd' }, () => ({ ok: true }));
    plugin.dispose();
    await settle();

    expect(plugin.isRevalidating.value).toBe(false);
    router.destroy();
  });
});
