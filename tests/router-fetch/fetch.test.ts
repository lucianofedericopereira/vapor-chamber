import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHttpClient } from '../../src/index';
import { createMemoryHistory, createRouter, isRouterError } from '../../src/router/index';
import { fetchLoaders } from '../../src/router-fetch/index';

const ROWS = [
  { name: 'home', path: '/', component: 'Home' },
  {
    name: 'items',
    path: '/items',
    component: 'Items',
    load: '/api/items?page={page}',
    query: { page: { type: 'int' as const, default: 1 } },
  },
];

function jsonResponse(body: unknown, ok = true, status = 200) {
  const headers = { 'content-type': 'application/json' };
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    headers: { entries: () => Object.entries(headers), get: (k: string) => (headers as any)[k.toLowerCase()] ?? null },
    text: async () => JSON.stringify(body),
    json: async () => body,
  };
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchLoaders', () => {
  it('interpolates, fetches through vapor-chamber\'s HttpClient, returns bare JSON — no envelope games', async () => {
    const seen: string[] = [];
    (globalThis.fetch as any).mockImplementation(async (url: string | URL | Request) => {
      seen.push(String(url));
      return jsonResponse({ items: [1, 2, 3] });
    });

    const router = createRouter({
      history: createMemoryHistory(),
      routes: ROWS,
      components: { Home: { name: 'Home' }, Items: { name: 'Items' } },
      loaders: fetchLoaders(),
    });
    await router.isReady();
    expect(await router.push('/items?page=2')).toBeNull();
    expect(seen[0]).toContain('/api/items?page=2');
    expect(router.currentRoute.value.data.get('items')).toEqual({ items: [1, 2, 3] });
  });

  it('non-2xx → coded load_failed, navigation not committed', async () => {
    (globalThis.fetch as any).mockImplementation(async () => jsonResponse({ error: 'nope' }, false, 500));
    const router = createRouter({
      history: createMemoryHistory(),
      routes: ROWS,
      components: { Home: { name: 'Home' }, Items: { name: 'Items' } },
      // retry: 0 keeps this deterministic and fast — the default client
      // (createHttpClient()'s own retry: 2 for GET) behaves the same, just
      // after its own backoff delays, which real consumers get for free.
      loaders: fetchLoaders({ http: createHttpClient({ retry: 0 }) }),
      onError: () => {},
    });
    await router.isReady();
    const result = await router.push('/items');
    expect(isRouterError(result, 'load_failed')).toBe(true);
    expect(router.currentRoute.value.location.name).toBe('home');
  });

  it('retries a flaky loader on 500 (the retry/timeout/CSRF handling this fix was for)', async () => {
    let attempts = 0;
    (globalThis.fetch as any).mockImplementation(async () => {
      attempts++;
      return attempts < 2 ? jsonResponse({ error: 'flaky' }, false, 500) : jsonResponse({ items: [1] });
    });

    vi.useFakeTimers();
    const router = createRouter({
      history: createMemoryHistory(),
      routes: ROWS,
      components: { Home: { name: 'Home' }, Items: { name: 'Items' } },
      loaders: fetchLoaders(), // default client: retry: 2 for GET
    });
    const ready = router.isReady();
    await vi.advanceTimersByTimeAsync(3000);
    await ready;
    const push = router.push('/items');
    await vi.advanceTimersByTimeAsync(3000);
    expect(await push).toBeNull();

    expect(attempts).toBe(2);
    expect(router.currentRoute.value.data.get('items')).toEqual({ items: [1] });
    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// Loader caching (item 2) — the http client's cache engine sits directly
// underneath every loader read; before this it was unreachable from here.
// ---------------------------------------------------------------------------

describe('fetchLoaders — cache', () => {
  const CACHE_ROWS = [
    { name: 'home', path: '/', component: 'Home' },
    { name: 'items', path: '/items', component: 'Items', load: '/api/items' },
    {
      name: 'countries',
      path: '/countries',
      component: 'Items',
      load: '/api/countries',
      meta: { cache: { ttl: 3_600_000 } },
    },
    { name: 'stock', path: '/stock', component: 'Items', load: '/api/stock', meta: { cache: false } },
  ];

  const COMPONENTS = { Home: { name: 'Home' }, Items: { name: 'Items' } };

  function routerWith(cache?: boolean | { ttl?: number; staleTtl?: number }) {
    return createRouter({
      history: createMemoryHistory(),
      routes: CACHE_ROWS,
      components: COMPONENTS,
      loaders: fetchLoaders({ cache, http: createHttpClient({ retry: 0 }) }),
    });
  }

  it('is off by default — every navigation re-reads', async () => {
    let calls = 0;
    (globalThis.fetch as any).mockImplementation(async () => {
      calls++;
      return jsonResponse({ items: [1] });
    });

    const router = routerWith();
    await router.isReady();
    await router.push('/items');
    await router.push('/');
    await router.push('/items');

    expect(calls).toBe(2);
  });

  it('serves a fresh hit without a second request', async () => {
    let calls = 0;
    (globalThis.fetch as any).mockImplementation(async () => {
      calls++;
      return jsonResponse({ items: [1] });
    });

    const router = routerWith(true);
    await router.isReady();
    await router.push('/items');
    await router.push('/');
    await router.push('/items');

    expect(calls).toBe(1);
    expect(router.currentRoute.value.data.get('items')).toEqual({ items: [1] });
  });

  it('meta.cache on the row overrides the preset default, both ways', async () => {
    const seen: string[] = [];
    (globalThis.fetch as any).mockImplementation(async (url: string | URL | Request) => {
      seen.push(String(url));
      return jsonResponse({ ok: true });
    });

    // Preset default OFF, but the countries row opts in.
    const router = routerWith(false);
    await router.isReady();
    await router.push('/countries');
    await router.push('/');
    await router.push('/countries');
    expect(seen.filter((u) => u.includes('/api/countries'))).toHaveLength(1);

    // Preset default ON, but the stock row opts out.
    const live = routerWith(true);
    await live.isReady();
    await live.push('/stock');
    await live.push('/');
    await live.push('/stock');
    expect(seen.filter((u) => u.includes('/api/stock'))).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Stale-while-revalidate (item 2a) — the third lane. A stale hit commits
// instantly; the refresh behind it has to reach the snapshot, and has to be
// distinguishable from "loading".
// ---------------------------------------------------------------------------

describe('fetchLoaders — stale-while-revalidate', () => {
  const SWR_ROWS = [
    { name: 'home', path: '/', component: 'Home' },
    { name: 'items', path: '/items', component: 'Items', load: '/api/items' },
  ];
  const COMPONENTS = { Home: { name: 'Home' }, Items: { name: 'Items' } };

  it('commits stale data, then patches the fresh value into the snapshot', async () => {
    // The revalidation response is held open so the stale-commit moment is
    // observable — with an instantly-resolving mock the refresh lands before
    // the push() await returns and there is nothing to assert about.
    let calls = 0;
    let releaseRefresh: (() => void) | null = null;
    (globalThis.fetch as any).mockImplementation(async () => {
      calls++;
      if (calls === 1) return jsonResponse({ version: 1 });
      return new Promise((resolve) => {
        releaseRefresh = () => resolve(jsonResponse({ version: 2 }));
      });
    });

    const router = createRouter({
      history: createMemoryHistory(),
      routes: SWR_ROWS,
      components: COMPONENTS,
      // ttl 0 → the entry is past-fresh immediately, staleTtl keeps it servable.
      loaders: fetchLoaders({
        cache: { ttl: 0, staleTtl: 60_000 },
        http: createHttpClient({ retry: 0 }),
      }),
    });
    await router.isReady();

    await router.push('/items'); // miss → version 1, cached
    expect(router.currentRoute.value.data.get('items')).toEqual({ version: 1 });

    await router.push('/');
    await router.push('/items'); // stale hit → commits version 1 immediately
    expect(router.currentRoute.value.data.get('items')).toEqual({ version: 1 });
    expect(router.isLoading.value).toBe(false); // it has data — it is not loading
    expect(router.isRevalidating.value).toBe(true); // ...but a refresh is running

    releaseRefresh?.();
    await vi.waitFor(() => expect(router.isRevalidating.value).toBe(false));
    // The background response reached the page, not just the HTTP cache.
    expect(router.currentRoute.value.data.get('items')).toEqual({ version: 2 });
  });

  it('drops the patch when the user navigated away meanwhile', async () => {
    let resolveSecond: ((value: unknown) => void) | null = null;
    let calls = 0;
    (globalThis.fetch as any).mockImplementation(async () => {
      calls++;
      if (calls <= 1) return jsonResponse({ version: 1 });
      return new Promise((resolve) => {
        resolveSecond = () => resolve(jsonResponse({ version: 2 }));
      });
    });

    const router = createRouter({
      history: createMemoryHistory(),
      routes: SWR_ROWS,
      components: COMPONENTS,
      loaders: fetchLoaders({
        cache: { ttl: 0, staleTtl: 60_000 },
        http: createHttpClient({ retry: 0 }),
      }),
    });
    await router.isReady();

    await router.push('/items');
    await router.push('/');
    await router.push('/items'); // stale hit, revalidation pending
    expect(router.isRevalidating.value).toBe(true);

    await router.push('/'); // navigate away before it lands
    resolveSecond?.(undefined);
    await vi.waitFor(() => expect(router.isRevalidating.value).toBe(false));

    expect(router.currentRoute.value.location.name).toBe('home');
  });
});
