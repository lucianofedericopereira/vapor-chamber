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
