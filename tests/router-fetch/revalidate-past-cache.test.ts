// @vitest-environment happy-dom
/** revalidateRoutes re-reads a cached fetchLoaders URL. The long note is at the end. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCommandBus } from '../../src/command-bus';
import { createHttpClient } from '../../src/http';
import { fetchLoaders } from '../../src/router-fetch/index';
import { createMemoryHistory } from '@router/history';
import { createRouter } from '@router/index';
import { type LoaderContext, runLoaders } from '@router/loaders';
import { revalidateRoutes } from '@router/revalidate';

afterEach(() => vi.unstubAllGlobals());

function build(cache: boolean, baseURL?: string) {
  const s = { value: 'old', gets: 0, urls: [] as string[] };
  vi.stubGlobal('fetch', async (url: string) => {
    s.gets++;
    s.urls.push(url);
    return new Response(JSON.stringify({ v: s.value }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const http = createHttpClient(baseURL ? { baseURL } : {});
  const loaders = fetchLoaders({ http, cache: cache ? { ttl: 60_000 } : undefined });
  const router = createRouter({
    history: createMemoryHistory(''),
    routes: [
      { name: 'shop', path: '/', component: 'Shell' },
      { name: 'shop.cart', path: '/cart', component: 'Cart', load: '/cart' },
    ] as never,
    components: { Shell: { render: () => null }, Cart: { render: () => null } } as never,
    loaders,
    links: false,
    scroll: false,
    onError: () => {},
  });
  const bus = createCommandBus();
  bus.use(revalidateRoutes(router, loaders, { 'cart*': 'affected' }) as never);
  bus.register('cartAdd', () => true);
  return { s, router, bus };
}

describe('revalidateRoutes past the fetchLoaders cache', () => {
  for (const [label, cache, baseURL] of [
    ['control, no cache', false, undefined],
    ['cached loader', true, undefined],
    ['cached loader under a baseURL', true, '/api'],
  ] as const) {
    it(`${label}: a mapped command re-fetches the loader URL and shows the new data`, async () => {
      const { s, router, bus } = build(cache, baseURL);
      await router.isReady();
      await router.push('/cart');
      const before = s.gets;
      s.value = 'new';
      bus.dispatch('cartAdd', {});
      await new Promise((r) => setTimeout(r, 20));
      expect(s.gets).toBe(before + 1);
      expect((router.currentRoute.value.data.get('shop.cart') as { v: string }).v).toBe('new');
      router.destroy();
    });
  }

  it('a navigation back to a cached page still reads the cache', async () => {
    const { s, router } = build(true);
    await router.isReady();
    await router.push('/cart');
    await router.push('/');
    await router.push('/cart');
    expect(s.gets).toBe(1);
    router.destroy();
  });

  it('LoaderContext.refresh is false on a navigation, true when runLoaders is asked to refresh', async () => {
    const seen: boolean[] = [];
    const handlers = { prefixes: { 'x:': (_r: string, _l: unknown, _rec: unknown, _s: AbortSignal, ctx: LoaderContext) => seen.push(ctx.refresh) } };
    const record = { name: 'r', load: 'x:r' } as never;
    const at = { fullPath: '/' } as never;
    await runLoaders(handlers as never, [record], at, new AbortController().signal);
    await runLoaders(handlers as never, [record], at, new AbortController().signal, undefined, true);
    expect(seen).toEqual([false, true]);
  });
});

/*
 * External item 12 of the 1.26 evaluation (log s35.41). `revalidateRoutes`
 * re-runs the current page's loaders after a mapped command succeeds; with
 * `fetchLoaders({ cache })` that re-run read the client's cache, found the
 * entry the navigation had stored, and put the pre-mutation data back on the
 * page without a request. The control (no cache) shows the refresh itself
 * worked.
 *
 * The loader context now says why a loader runs: `refresh` is true when
 * `runLoaders` is called to refresh (revalidateRoutes is the caller) and false
 * on a navigation or a query refetch, always present, one shape. On a refresh,
 * `fetchLoaders` invalidates its own URL before the cached read, so the read
 * fetches and stores the new value. The match is anchored at the end of the
 * client's key, which is the URL after the client's `baseURL`, hence the
 * third case. A plain navigation back to the page still reads the cache.
 */
