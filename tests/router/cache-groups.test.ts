/**
 * The router's loader data follows the server's cache groups, a 304 keeps the snapshot, and revalidateRoutes listens to a bus.
 * Why: a write that names a group must refresh exactly the current records whose reads carried it, past every cache, and stop on dispose; a stale read answered 304 must not re-render; an action matching two patterns must refresh both targets.
 * Shows: against a real node:http server, a POST naming "cart" refetches /cart only (isRevalidating true meanwhile, second fetch with cache 'no-cache'); an unknown group, no matched route and a disposed router refresh nothing; dispose aborts a refresh in flight; a newer refresh supersedes an older one; a 304 keeps the same snapshot object, a changed read gives a new one; revalidateRoutes refreshes both pattern targets, stops after the returned off() and refreshes an Accepted only when its done is ok.
 * See: log 36.53, RFC 9875
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Accepted } from '../../src/accepted';
import { createAsyncCommandBus, createCommandBus } from '../../src/command-bus';
import { createHttpClient, type HttpClient } from '../../src/http';
import { fetchLoaders, type FetchLoadersOptions } from '../../src/router-fetch/index';
import { createMemoryHistory } from '@router/history';
import { createRouter, revalidateRoutes, type LoaderHandlers } from '@router/index';

/** `/stock` and `/cart` answer `{ v }` with an ETag and their group; a POST bumps cart and names "cart". */
const s = { cart: 1, stock: 1, gets: [] as Array<{ url: string; inm?: string }> };
const TABLE = [
  { name: 'shell', path: '/', component: 'P' },
  { name: 'shop', path: '/shop', component: 'P', load: '/stock' },
  { name: 'shop.cart', path: '/shop/cart', parent: 'shop', component: 'P', load: '/cart' },
];
let server: Server;
let base = '';
beforeAll(async () => {
  server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (req.method !== 'GET') {
        s.cart++;
        res.writeHead(200, { 'content-type': 'application/json', 'cache-group-invalidation': '"cart"' });
        res.end('{"state":1}');
        return;
      }
      const url = req.url as string;
      const inm = req.headers['if-none-match'] as string | undefined;
      s.gets.push({ url, inm });
      const v = url === '/cart' ? s.cart : s.stock;
      const headers = { 'content-type': 'application/json', etag: `"${url}${v}"`, 'cache-groups': url === '/cart' ? '"cart"' : '"stock"' };
      if (inm === headers.etag) {
        res.writeHead(304, headers);
        res.end();
        return;
      }
      res.writeHead(200, headers);
      res.end(JSON.stringify({ v }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => Object.assign(s, { cart: 1, stock: 1, gets: [] }));
afterEach(() => vi.restoreAllMocks());

async function boot(http: HttpClient, loaders: LoaderHandlers = fetchLoaders()) {
  const router = createRouter({
    history: createMemoryHistory('/'),
    routes: TABLE as never,
    components: { P: { name: 'P' } },
    http,
    loaders,
    scroll: false,
    links: false,
    announce: false,
    onError: () => {},
  });
  await router.isReady();
  await router.push('/shop/cart');
  return router;
}
const got = (url: string) => s.gets.filter((g) => g.url === url).length;
const value = (router: Awaited<ReturnType<typeof boot>>, name: string) => (router.currentRoute.value.data.get(name) as { v: number } | undefined)?.v;

describe('a group named by a write refreshes the records whose reads carried it', () => {
  it('only those, past every cache, with the router revalidating meanwhile', async () => {
    const real = globalThis.fetch;
    const modes: Array<RequestCache | undefined> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => { modes.push(init?.cache); return real(input, init); });
    const http = createHttpClient({ baseURL: base });
    const router = await boot(http, fetchLoaders({ cache: true }));
    expect([value(router, 'shop'), value(router, 'shop.cart')]).toEqual([1, 1]);
    modes.length = 0;

    await http.post('/vc', {});
    expect(router.isRevalidating.value).toBe(true);
    await vi.waitFor(() => expect(value(router, 'shop.cart')).toBe(2));
    expect({ cart: got('/cart'), stock: got('/stock'), revalidating: router.isRevalidating.value }).toEqual({ cart: 2, stock: 1, revalidating: false });
    // The POST, then the refresh past the browser's cache.
    expect(modes).toEqual([undefined, 'no-cache']);
    router.dispose();
  });

  it('a group no record of the current page carries refreshes nothing', async () => {
    const http = createHttpClient({ baseURL: base });
    const router = await boot(http);
    http.invalidateGroups(['orders']);
    await new Promise((r) => setTimeout(r, 20));
    expect(s.gets.length).toBe(2);
    router.dispose();
  });

  it('with no page on screen (no route matched), a group refreshes nothing', async () => {
    const http = createHttpClient({ baseURL: base });
    const router = createRouter({ history: createMemoryHistory('/nowhere'), routes: [{ name: 'shop', path: '/shop', component: 'P', load: '/cart' }] as never, components: { P: { name: 'P' } }, http, loaders: fetchLoaders(), links: false, scroll: false, onError: () => {} });
    await router.isReady();
    expect(() => http.invalidateGroups(['cart'])).not.toThrow();
    expect(s.gets.length).toBe(0);
    router.dispose();
  });

  it('after dispose the router no longer listens', async () => {
    const http = createHttpClient({ baseURL: base });
    const router = await boot(http);
    router.dispose();
    http.invalidateGroups(['cart']);
    await new Promise((r) => setTimeout(r, 20));
    expect(got('/cart')).toBe(1);
  });

  it('dispose aborts a refresh in flight: nothing lands after it', async () => {
    const http = createHttpClient({ baseURL: base });
    const router = await boot(http);
    s.cart = 9;
    http.invalidateGroups(['cart']);
    router.dispose();
    await vi.waitFor(() => expect(router.isRevalidating.value).toBe(false));
    expect(value(router, 'shop.cart')).toBe(1);
  });

  it('a newer refresh of a record aborts the older one: the later value lands', async () => {
    const http = createHttpClient({ baseURL: base });
    const router = await boot(http);
    http.invalidateGroups(['cart']);
    s.cart = 7;
    http.invalidateGroups(['cart']);
    await vi.waitFor(() => expect(router.isRevalidating.value).toBe(false));
    expect(value(router, 'shop.cart')).toBe(7);
    router.dispose();
  });
});

describe('a stale loader read answered 304 keeps the snapshot', () => {
  const swr: FetchLoadersOptions = { cache: { ttl: 20, staleTtl: 60_000 } };
  async function revisit(changed: boolean) {
    const http = createHttpClient({ baseURL: base });
    const router = await boot(http, fetchLoaders(swr));
    await router.push('/');
    await new Promise((r) => setTimeout(r, 40));
    if (changed) s.cart = 2;
    await router.push('/shop/cart');
    const committed = router.currentRoute.value;
    await vi.waitFor(() => expect(s.gets.filter((g) => g.inm !== undefined).length).toBe(2));
    await vi.waitFor(() => expect(router.isRevalidating.value).toBe(false));
    const after = router.currentRoute.value;
    router.dispose();
    return { committed, after };
  }

  it('unchanged: the same snapshot object, no re-render', async () => {
    const { committed, after } = await revisit(false);
    expect(after).toBe(committed);
  });

  it('control: changed, a new snapshot with the new data', async () => {
    const { committed, after } = await revisit(true);
    expect({ same: after === committed, v: (after.data.get('shop.cart') as { v: number }).v }).toEqual({ same: false, v: 2 });
  });
});

describe('revalidateRoutes on a bus, a listener of settled results', () => {
  const ROWS = [{ name: 'shop', path: '/', component: 'P', load: 'rows:shop' }];
  function local(onLoad: () => unknown) {
    const loaders: LoaderHandlers = { prefixes: { 'rows:': () => onLoad() } };
    const router = createRouter({ history: createMemoryHistory(''), routes: ROWS as never, components: { P: { name: 'P' } }, loaders, links: false, scroll: false, onError: () => {} });
    return { router, loaders };
  }

  it('an action matching two patterns refreshes both targets', async () => {
    let n = 0;
    const { router, loaders } = local(() => ({ n: ++n }));
    await router.isReady();
    const refreshed: string[] = [];
    const bus = createCommandBus();
    bus.register('cartAdd', () => 'ok');
    const plugin = revalidateRoutes(router, loaders, { 'cart*': ['shop'], cartAdd: 'affected' }, { onError: (e) => refreshed.push(String(e)) });
    bus.use(plugin);
    const before = n;
    bus.dispatch('cartAdd', {});
    await vi.waitFor(() => expect(plugin.isRevalidating.value).toBe(false));
    // Both targets name `shop`: the second refresh supersedes the first, two loads run.
    expect({ loads: n - before, errors: refreshed }).toEqual({ loads: 2, errors: [] });
    plugin.dispose();
    router.dispose();
  });

  it("the function `use` returns takes its listeners out too", async () => {
    let n = 0;
    const { router, loaders } = local(() => ({ n: ++n }));
    await router.isReady();
    const bus = createCommandBus();
    bus.register('cartAdd', () => 'ok');
    const off = bus.use(revalidateRoutes(router, loaders, { 'cart*': 'affected' }));
    off();
    const before = n;
    bus.dispatch('cartAdd', {});
    await new Promise((r) => setTimeout(r, 10));
    expect(n).toBe(before);
    router.dispose();
  });

  it('an Accepted answer refreshes once its done settles ok, and not when it fails', async () => {
    let n = 0;
    const { router, loaders } = local(() => ({ n: ++n }));
    await router.isReady();
    let finish!: (r: { ok: boolean; error?: Error }) => void;
    const bus = createAsyncCommandBus({ retry: false });
    bus.register('reportRun', async () => new Accepted(() => new Promise((r) => { finish = r as never; })));
    const plugin = revalidateRoutes(router, loaders, { reportRun: 'affected' });
    bus.use(plugin);
    const before = n;
    await bus.dispatch('reportRun', {});
    await new Promise((r) => setTimeout(r, 10));
    expect(n).toBe(before);
    finish({ ok: true });
    await vi.waitFor(() => expect(n).toBe(before + 1));
    await bus.dispatch('reportRun', {});
    finish({ ok: false, error: new Error('job failed') });
    await new Promise((r) => setTimeout(r, 10));
    expect(n).toBe(before + 1);
    plugin.dispose();
    router.dispose();
  });
});
