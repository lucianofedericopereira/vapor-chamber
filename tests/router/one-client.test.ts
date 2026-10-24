/** The router's requests on the app's one client (plan 1.32 step 3d). The long note is at the end. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHttpClient } from '../../src/http';
import { fetchLoaders } from '../../src/router-fetch/index';
import { createMemoryHistory } from '@router/history';
import { createRouter, type RouterOptions } from '@router/index';
import { bladeFetcher, routerHttp } from '@router/remote';

/** `/routes` answers the table, `/page` HTML, anything else `{ v }`; a write sets `v` to 'new'. */
const s = { v: 'old', fail: 0, gets: [] as Array<{ url: string; headers: IncomingHttpHeaders }> };
const TABLE = {
  routes: [
    { name: 'shell', path: '/', parent: null },
    { name: 'home', path: '/', parent: 'shell', component: 'P' },
    { name: 'cart', path: '/cart', parent: 'shell', component: 'P', load: '/cart' },
    { name: 'old', path: '/old', parent: 'shell', blade: true },
  ],
};
let server: Server;
let base = '';
beforeAll(async () => {
  server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (req.method !== 'GET') {
        s.v = 'new';
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      s.gets.push({ url: req.url as string, headers: req.headers });
      if (s.fail > 0) {
        s.fail--;
        res.writeHead(503, { 'content-type': 'application/problem+json', 'retry-after': '0' });
        res.end('{"status":503}');
        return;
      }
      if (req.url === '/page') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<main>blade</main>');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(req.url === '/routes' ? TABLE : { v: s.v }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => Object.assign(s, { v: 'old', fail: 0, gets: [] }));

/** The app's one client: every request it sends carries `X-App`. */
const appClient = () => createHttpClient({ baseURL: base, headers: { 'X-App': '1' } });

async function boot(opts: Partial<RouterOptions>) {
  const router = createRouter({
    history: createMemoryHistory('/'),
    routes: { url: '/routes' },
    components: { P: { name: 'P' } },
    scroll: false,
    links: false,
    announce: false,
    onError: () => {},
    ...opts,
  });
  await router.isReady();
  return router;
}
const got = (url: string) => s.gets.filter((g) => g.url === url);
const data = (router: Awaited<ReturnType<typeof boot>>) => (router.currentRoute.value.data.get('cart') as { v: string } | undefined)?.v;

describe("fetchLoaders() reads through the router's client", () => {
  it("a loader read carries the app client's header and its `headers` option", async () => {
    const router = await boot({ http: appClient(), loaders: fetchLoaders({ headers: { 'X-Loader': '1' } }) });
    await router.push('/cart');
    const h = got('/cart')[0]?.headers;
    expect({ app: h?.['x-app'], loader: h?.['x-loader'] }).toEqual({ app: '1', loader: '1' });
    router.dispose();
  });

  it("one cache: a write through the app's client is seen by the next cached loader read", async () => {
    const http = appClient();
    const router = await boot({ http, loaders: fetchLoaders({ cache: { ttl: 60_000 } }) });
    await router.push('/cart');
    await http.put('/cart', { n: 1 });
    await router.push('/');
    await router.push('/cart');
    expect({ reads: got('/cart').length, shown: data(router) }).toEqual({ reads: 2, shown: 'new' });
    router.dispose();
  });

  it('an explicit `http` wins over the router client, and `headers` still go out', async () => {
    const own = createHttpClient({ baseURL: base, headers: { 'X-Own': '1' } });
    const router = await boot({ http: appClient(), loaders: fetchLoaders({ http: own, headers: { 'X-Loader': '1' } }) });
    await router.push('/cart');
    const h = got('/cart')[0]?.headers;
    expect({ app: h?.['x-app'], own: h?.['x-own'], loader: h?.['x-loader'] }).toEqual({ app: undefined, own: '1', loader: '1' });
    router.dispose();
  });

  it('control: with no client anywhere it builds its own', async () => {
    const routes = TABLE.routes.map((r) => (r.name === 'cart' ? { ...r, load: `${base}/cart` } : r));
    const router = await boot({ routes, loaders: fetchLoaders({ headers: { 'X-Loader': '1' } }) });
    await router.push('/cart');
    expect({ shown: data(router), loader: got('/cart')[0]?.headers['x-loader'] }).toEqual({ shown: 'old', loader: '1' });
    router.dispose();
  });
});

describe("bladeFetcher() on the router's client, marked as router traffic", () => {
  it("a blade row is fetched through the app's client with X-Vapor-Router", async () => {
    const router = await boot({ http: appClient(), fetchBlade: bladeFetcher() });
    await router.push('/old');
    const h = got('/old')[0]?.headers;
    expect({ app: h?.['x-app'], marker: h?.['x-vapor-router'] }).toEqual({ app: '1', marker: '1' });
    router.dispose();
  });
});

describe('routerHttp({ http }): the app client with the marker', () => {
  it('carries both headers', async () => {
    const router = await boot({ http: routerHttp({ http: appClient() }) });
    const h = got('/routes')[0]?.headers;
    expect({ app: h?.['x-app'], marker: h?.['x-vapor-router'] }).toEqual({ app: '1', marker: '1' });
    router.dispose();
  });

  it("one cache: a write on the app's client reaches a read cached through the view", async () => {
    const http = appClient();
    const view = routerHttp({ http });
    await view.get('/cart', { cache: true });
    await http.post('/cart', {});
    await view.get('/cart', { cache: true });
    expect(got('/cart').length).toBe(2);
  });

  it("`create()` on it derives a client with the app's defaults, the marker and its own", async () => {
    await routerHttp({ http: appClient() }).create({ headers: { 'X-More': '1' } }).get('/cart');
    const h = got('/cart')[0]?.headers;
    expect({ app: h?.['x-app'], marker: h?.['x-vapor-router'], more: h?.['x-more'] }).toEqual({ app: '1', marker: '1', more: '1' });
  });

  it("bladeFetcher() follows the client it is handed: a second router's client is marked in turn", async () => {
    const fetchBlade = bladeFetcher();
    const other = createHttpClient({ baseURL: base, headers: { 'X-Other': '1' } });
    await fetchBlade('/page', appClient());
    await fetchBlade('/page', other);
    const [first, second] = got('/page').map((g) => g.headers);
    expect([first?.['x-app'], second?.['x-other'], second?.['x-app'], second?.['x-vapor-router']]).toEqual(['1', '1', undefined, '1']);
  });

  it('control: with no client it builds its own, marked', async () => {
    await routerHttp({ baseURL: base }).get('/cart');
    expect(got('/cart')[0]?.headers['x-vapor-router']).toBe('1');
  });
});

describe('the routes table: the default re-sends, no count of its own', () => {
  it('control: a 503 then the table loads on the third attempt', async () => {
    s.fail = 2;
    const router = await boot({ http: appClient() });
    expect({ reads: got('/routes').length, routes: router.routes.value.length }).toEqual({ reads: 3, routes: 4 });
    router.dispose();
  });
});

/*
 * Plan 1.32 step 3d, plan-router.md gap 2: four clients for one app. The router
 * used its `http` option for the `{ url }` table only, so `fetchLoaders()` and
 * `bladeFetcher()` each built a client of their own beside it: a second cache, a
 * second dedupe map, interceptors the app never installed. A write through the
 * app's client then could not reach a loader's cached read (the record's hole F,
 * which invalidation in step 3g needs). Now the router hands its client to its
 * loaders (`LoaderContext.http`) and to `fetchBlade(href, http)`. An explicit
 * `http` still wins, and with no client anywhere each builds its own, as before.
 * A default `bladeFetcher` marks the router's client as router traffic
 * (`X-Vapor-Router`), as its own `routerHttp()` did. `routerHttp({ http })` is the
 * app's client with that marker: one cache, one dedupe map, one set of
 * interceptors. The `{ url }` table read lost its own `retry: 2`: the default is
 * the same three attempts.
 *
 * The "no client anywhere" control reads a table given as rows (the `{ url }`
 * source needs a client) and an absolute loader URL.
 */
