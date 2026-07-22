import { describe, expect, it, vi } from 'vitest';
import { isRouterError } from '../../src/router/errors';
import { createMemoryHistory } from '../../src/router/history';
import { createRouter, unwrapRoutesPayload } from '../../src/router/index';
import type { LoaderHandlers } from '../../src/router/loaders';
import type { RouteRecord } from '../../src/router/types';

const ROWS: RouteRecord[] = [
  { name: 'shell', path: '/', parent: null }, // group
  { name: 'home', path: '/', parent: 'shell', component: 'Home' },
  {
    name: 'products',
    path: '/products',
    parent: 'shell',
    component: 'Products',
    load: 'rows:products',
    query: { page: { type: 'int', default: 1 }, sort: {}, name: {} },
  },
  { name: 'product', path: '/products/:id(\\d+)', parent: 'shell', component: 'Product', params: { id: 'int' } },
  {
    name: 'remote',
    path: '/remote',
    parent: 'shell',
    component: 'Remote',
    load: '/api/vc/remote?page={page}',
    query: { page: { type: 'int', default: 1 } },
  },
  { name: 'secret', path: '/secret', component: 'Secret', meta: { permission: 'admin' } },
];

/** Test preset: a prefix handler echoing what it saw (counts invocations) +
 *  a url handler backed by an injectable async fn. Core tests exercise the
 *  loader MECHANICS; dialect behavior (paginator shapes, envelopes) is the
 *  presets' own test suites. */
function makeLoaders(urlFn?: (template: string, signal?: AbortSignal) => Promise<unknown>) {
  const rowsCalls: string[] = [];
  const handlers: LoaderHandlers = {
    prefixes: {
      'rows:': (ref, location) => {
        rowsCalls.push(String(location.query.page ?? '1'));
        return {
          ref,
          page: String(location.query.page ?? '1'),
          name: String(location.query.name ?? ''),
        };
      },
    },
    url: async (template, location, record, signal) =>
      (urlFn ?? (async () => ({ hit: template })))(template, signal),
  };
  return { handlers, rowsCalls };
}

function makeRouter(overrides: Record<string, unknown> = {}, urlFn?: (t: string, s?: AbortSignal) => Promise<unknown>) {
  const history = createMemoryHistory('/admin');
  const { handlers, rowsCalls } = makeLoaders(urlFn);
  const router = createRouter({
    base: '/admin',
    history,
    routes: ROWS,
    loaders: handlers,
    components: {
      Home: { name: 'Home' },
      Products: { name: 'Products' },
      Product: { name: 'Product' },
      Remote: { name: 'Remote' },
      Secret: { name: 'Secret' },
    },
    ...overrides,
  });
  return { router, history, rowsCalls };
}

const loc = (router: ReturnType<typeof makeRouter>['router']) => router.currentRoute.value.location;
const data = (router: ReturnType<typeof makeRouter>['router'], name: string) =>
  router.currentRoute.value.data.get(name) as { ref: string; page: string; name: string };

describe('startup', () => {
  it('constructor is pure — nothing commits until isReady()', async () => {
    const { router } = makeRouter();
    expect(loc(router).name).toBeNull();
    await router.isReady();
    expect(loc(router).name).toBe('home');
    expect(loc(router).matched.map((r) => r.name)).toEqual(['shell', 'home']);
  });
});

describe('navigation basics', () => {
  it('pushes by path and name; null = committed; render entries resolved', async () => {
    const { router, history } = makeRouter();
    await router.isReady();

    expect(await router.push('/products/7')).toBeNull();
    expect(loc(router).params.id).toBe(7);
    expect(history.location()).toBe('/products/7');
    expect((router.currentRoute.value.render[0].component as { name: string }).name).toBe('Product');

    expect(await router.push({ name: 'home' })).toBeNull();
    expect(loc(router).name).toBe('home');
  });

  it('unmatched → coded error + onError, nothing committed', async () => {
    const onError = vi.fn();
    const { router } = makeRouter({ onError });
    await router.isReady();
    expect(isRouterError(await router.push('/nope'), 'unmatched')).toBe(true);
    expect(onError).toHaveBeenCalledOnce();
    expect(loc(router).name).toBe('home');
  });

  it('guard refusal → "aborted" (no onError); redirect flows', async () => {
    const onError = vi.fn();
    const { router } = makeRouter({ onError });
    await router.isReady();
    const offGuard = router.beforeEach((to) => to.meta.permission !== 'admin');
    expect(isRouterError(await router.push('/secret'), 'aborted')).toBe(true);
    expect(onError).not.toHaveBeenCalled();
    offGuard();

    router.beforeEach((to) => (to.name === 'secret' ? { name: 'home' } : undefined));
    expect(await router.push('/secret')).toBeNull();
    expect(loc(router).name).toBe('home');
  });
});

describe('resolve()', () => {
  it('carries param inheritance, typed query and hash into hrefs', async () => {
    const { router } = makeRouter();
    await router.isReady();
    await router.push('/products/7');
    expect(router.resolve({ name: 'products', query: { page: 2 }, hash: '#top' })).toBe(
      '/admin/products?page=2#top',
    );
    expect(router.resolve('/products?page=2')).toBe('/admin/products?page=2');
    expect(router.resolve({ name: 'product' })).toBe('/admin/products/7'); // id inherited
  });
});

describe('loader mechanics (via test preset)', () => {
  it('prefix loader result commits atomically with the navigation', async () => {
    const { router } = makeRouter();
    await router.isReady();
    expect(await router.push('/products?page=2')).toBeNull();
    expect(data(router, 'products')).toEqual({ ref: 'products', page: '2', name: '' });
  });

  it('query-only page change: guards skipped, refetch in place, render reused', async () => {
    const { router, history, rowsCalls } = makeRouter();
    await router.isReady();
    await router.push('/products');
    const renderBefore = router.currentRoute.value.render;

    const guard = vi.fn();
    router.beforeEach(guard);
    router.setQuery({ page: '2' });

    expect(history.location()).toBe('/products?page=2'); // optimistic URL
    await vi.waitFor(() => expect(data(router, 'products').page).toBe('2'));
    expect(guard).not.toHaveBeenCalled();
    expect(router.currentRoute.value.render).toBe(renderBefore);
    expect(rowsCalls).toEqual(['1', '2']);
  });

  it('declared filter change refetches; undeclared key change does not', async () => {
    const { router, rowsCalls } = makeRouter();
    await router.isReady();
    await router.push('/products');

    router.setQuery({ name: 'P2' });
    await vi.waitFor(() => expect(data(router, 'products').name).toBe('P2'));

    const callsBefore = rowsCalls.length;
    router.setQuery({ unrelated: 'x' });
    await new Promise((r) => setTimeout(r, 10));
    expect(rowsCalls.length).toBe(callsBefore);
  });

  it('a custom affects hook fully replaces the default policy', async () => {
    const rowsCalls: string[] = [];
    const handlers: LoaderHandlers = {
      prefixes: {
        'rows:': (ref) => {
          rowsCalls.push(ref);
          return { ref };
        },
      },
      // Ignore everything the default would react to; opt in only `zoom`.
      affects: (_record, keys) => keys.includes('zoom'),
    };
    const { router } = makeRouter({ loaders: handlers });
    await router.isReady();
    await router.push('/products');
    const before = rowsCalls.length;

    router.setQuery({ page: '2' }); // default policy would refetch — the hook ignores it
    await new Promise((r) => setTimeout(r, 10));
    expect(rowsCalls.length).toBe(before);

    router.setQuery({ zoom: '1' }); // undeclared, non-pagination — the hook opts it in
    await vi.waitFor(() => expect(rowsCalls.length).toBe(before + 1));
  });

  it('url handler receives the template; newer navigation aborts in-flight load', async () => {
    let sawAbortedSignal = false;
    const { router } = makeRouter(
      {},
      (template, signal) =>
        new Promise((resolve, reject) => {
          if (!template.includes('remote')) return resolve({});
          signal?.addEventListener('abort', () => {
            sawAbortedSignal = true;
            reject(new Error('aborted'));
          });
        }),
    );
    await router.isReady();
    const slow = router.push('/remote');
    const fast = router.push('/products/1');
    const [slowResult, fastResult] = await Promise.all([slow, fast]);
    expect(isRouterError(slowResult, 'cancelled')).toBe(true);
    expect(fastResult).toBeNull();
    expect(sawAbortedSignal).toBe(true);
    expect(loc(router).name).toBe('product');
  });

  it('loader failure → "load_failed" with cause, navigation not committed', async () => {
    const onError = vi.fn();
    const boom = new Error('500');
    const { router } = makeRouter({ onError }, async (template) => {
      if (template.includes('remote')) throw boom;
      return {};
    });
    await router.isReady();
    const result = await router.push('/remote');
    expect(isRouterError(result, 'load_failed')).toBe(true);
    expect((result as Error & { cause?: unknown }).cause).toBe(boom);
    expect(loc(router).name).toBe('home');
  });

  it('no preset configured + load route → "load_failed"', async () => {
    const { router } = makeRouter({ loaders: undefined });
    await router.isReady();
    expect(isRouterError(await router.push('/products'), 'load_failed')).toBe(true);
  });
});

describe('locale-prefixed admin (/admin/:locale/…) — param inheritance', () => {
  const LOCALE_ROWS = [
    { name: 'home', path: '/:locale(it|en)', component: 'Home', params: { locale: 'string' as const } },
    { name: 'products', path: '/:locale(it|en)/products', component: 'Products', params: { locale: 'string' as const } },
  ];

  it('push by name inherits the current locale param; explicit param overrides', async () => {
    const { router, history } = makeRouter();
    await router.isReady();
    router.setRoutes(LOCALE_ROWS);
    await router.push('/it');
    expect(loc(router).params.locale).toBe('it');

    expect(await router.push({ name: 'products' })).toBeNull(); // no locale passed
    expect(history.location()).toBe('/it/products');            // inherited

    expect(await router.push({ name: 'products', params: { locale: 'en' } })).toBeNull();
    expect(history.location()).toBe('/en/products');            // explicit switch, real navigation
    expect(loc(router).params.locale).toBe('en');
  });
});

describe('setRouteData — the hot path', () => {
  it('patches loader data with zero loader runs, reactively, snapshot frozen', async () => {
    const { router, rowsCalls } = makeRouter();
    await router.isReady();
    await router.push('/products');
    const callsBefore = rowsCalls.length;
    const snapshotBefore = router.currentRoute.value;

    router.setRouteData('products', { patched: true }); // e.g. a bus command's response

    expect(router.currentRoute.value.data.get('products')).toEqual({ patched: true });
    expect(router.currentRoute.value).not.toBe(snapshotBefore); // new frozen snapshot
    expect(Object.isFrozen(router.currentRoute.value)).toBe(true);
    expect(rowsCalls.length).toBe(callsBefore); // no loader ran
    expect(router.currentRoute.value.render).toBe(snapshotBefore.render); // no remount
  });
});

describe('popstate', () => {
  it('back/forward navigates; refused pops roll the URL forward again', async () => {
    const { router, history } = makeRouter();
    await router.isReady();
    await router.push('/products');
    await router.push('/products/5');

    history.go(-1);
    await vi.waitFor(() => expect(loc(router).name).toBe('products'));

    router.beforeEach(() => false);
    history.go(-1);
    await vi.waitFor(() => expect(history.location()).toBe('/products'));
  });

  it('back through pages restores the previous page data (query fast path on pop)', async () => {
    const { router, history } = makeRouter();
    await router.isReady();
    await router.push('/products'); // page 1
    router.setQuery({ page: '2' }); // convention: pushState
    await vi.waitFor(() => expect(data(router, 'products').page).toBe('2'));

    history.go(-1);
    await vi.waitFor(() => expect(data(router, 'products').page).toBe('1'));
    expect(history.location()).toBe('/products');
  });
});

describe('errors & delivery', () => {
  it('envelope unwrap accepts both shapes and throws coded errors', () => {
    const payload = { routes: [{ name: 'a', path: '/a', component: 'A' }] };
    expect(unwrapRoutesPayload(payload)).toEqual(payload);
    expect(unwrapRoutesPayload({ ok: true, state: payload })).toEqual(payload);
    expect(() => unwrapRoutesPayload({ ok: false, error: 'x' })).toThrow(
      expect.objectContaining({ code: 'routes_load_failed' }),
    );
    expect(() => unwrapRoutesPayload({})).toThrow(expect.objectContaining({ code: 'invalid_routes_payload' }));
  });

  it('component_missing / component_load_failed(cause) / blade_unconfigured', async () => {
    const onError = vi.fn();
    const boom = new Error('chunk 404');
    const { router } = makeRouter({
      onError,
      components: { Home: { name: 'Home' }, Broken: () => Promise.reject(boom) },
    });
    await router.isReady();

    router.setRoutes([
      { name: 'home', path: '/', component: 'Home' },
      { name: 'missing', path: '/missing', component: 'Nope' },
      { name: 'broken', path: '/broken', component: 'Broken' },
      { name: 'legacy', path: '/legacy', blade: true },
    ]);
    expect(isRouterError(await router.push('/missing'), 'component_missing')).toBe(true);
    const broken = await router.push('/broken');
    expect(isRouterError(broken, 'component_load_failed')).toBe(true);
    expect((broken as Error & { cause?: unknown }).cause).toBe(boom);
    expect(isRouterError(await router.push('/legacy'), 'blade_unconfigured')).toBe(true);
    expect(loc(router).name).toBe('home'); // none committed
  });

  it('onError subscribers fire before the terminal handler; lastError tracks', async () => {
    const order: string[] = [];
    const { router } = makeRouter({ onError: () => order.push('terminal') });
    await router.isReady();
    const off = router.onError(() => order.push('subscriber'));
    await router.push('/nope');
    expect(order).toEqual(['subscriber', 'terminal']);
    expect(isRouterError(router.lastError.value, 'unmatched')).toBe(true);
    off();
    await router.push('/still-nope');
    expect(order).toEqual(['subscriber', 'terminal', 'terminal']);
  });

  it('setRoutes swaps the table; reload() without { url } is a coded error', async () => {
    const { router } = makeRouter();
    await router.isReady();
    router.setRoutes([{ name: 'only', path: '/only', component: 'Home' }]);
    expect(await router.push('/only')).toBeNull();
    await expect(router.reload()).rejects.toMatchObject({ code: 'routes_load_failed' });
  });
});
