/** The HTTP cache's B6 cases, re-run through a cached router loader on a real server. The long note is at the end. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createCommandBus } from '../../src/command-bus';
import { createHttpClient } from '../../src/http';
import { fetchLoaders } from '../../src/router-fetch/index';
import { createMemoryHistory } from '@router/history';
import { createRouter } from '@router/index';
import { revalidateRoutes } from '@router/revalidate';

/** One value per URL; a write sets it to 'new'; `hold` keeps the next GET open until `release()`. */
const s = { value: 'old', gets: 0, hold: false, release: () => {} };
let server: Server;
let base = '';
beforeAll(async () => {
  server = createServer((req, res) => {
    const answer = () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ v: s.value }));
    };
    if (req.method !== 'GET') {
      req.resume();
      req.on('end', () => { s.value = 'new'; answer(); });
      return;
    }
    s.gets++;
    const v = s.value;
    if (s.hold) {
      s.hold = false;
      s.release = () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ v })); };
      return;
    }
    answer();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => Object.assign(s, { value: 'old', gets: 0, hold: false, release: () => {} }));

/** Wait for `cond`, up to 2 s; fail naming it rather than return as if it held. */
const until = async (cond: () => boolean) => {
  for (const end = Date.now() + 2000; !cond(); await new Promise((r) => setTimeout(r, 5))) {
    if (Date.now() > end) throw new Error(`until: still false after 2 s: ${cond}`);
  }
};

async function build() {
  const http = createHttpClient({ baseURL: base, retry: 0 });
  const loaders = fetchLoaders({ http, cache: { ttl: 60_000 } });
  const router = createRouter({
    history: createMemoryHistory('/'),
    routes: [
      { name: 'shell', path: '/', parent: null },
      { name: 'home', path: '/', parent: 'shell', component: 'P' },
      { name: 'cart', path: '/cart', parent: 'shell', component: 'P', load: '/cart' },
    ],
    components: { P: { name: 'P' } },
    loaders,
    scroll: false,
    links: false,
    announce: false,
    onError: () => {},
  });
  await router.isReady();
  const shown = () => (router.currentRoute.value.data.get('cart') as { v: string } | undefined)?.v;
  /** Leave the page and come back: a navigation, which reads the cache. */
  const revisit = async () => { await router.push('/'); await router.push('/cart'); };
  return { http, loaders, router, shown, revisit };
}

describe('a cached router loader against the B6 cases', () => {
  it('control: a revisit is answered from the cache', async () => {
    const { router, shown, revisit } = await build();
    await router.push('/cart');
    await revisit();
    expect({ gets: s.gets, shown: shown() }).toEqual({ gets: 1, shown: 'old' });
    router.dispose();
  });

  it('a loader read in flight across an invalidation of its URL: shown, not stored; the revisit fetches', async () => {
    const { http, router, shown, revisit } = await build();
    s.hold = true;
    const going = router.push('/cart');
    await until(() => s.gets === 1);
    s.value = 'new';
    http.invalidateCache('/cart');
    s.release();
    await going;
    const first = shown();
    await revisit();
    expect({ first, gets: s.gets, shown: shown() }).toEqual({ first: 'old', gets: 2, shown: 'new' });
    router.dispose();
  });

  it('a write to the loader URL through the same client: the revisit fetches the new value', async () => {
    const { http, router, shown, revisit } = await build();
    await router.push('/cart');
    await http.put('/cart', { n: 1 });
    await revisit();
    expect({ gets: s.gets, shown: shown() }).toEqual({ gets: 2, shown: 'new' });
    router.dispose();
  });

  it('revalidateRoutes after a mapped command: one more GET, the page shows the new value', async () => {
    const { loaders, router, shown } = await build();
    const bus = createCommandBus();
    bus.use(revalidateRoutes(router, loaders, { 'cart*': 'affected' }) as never);
    bus.register('cartAdd', () => true);
    await router.push('/cart');
    s.value = 'new';
    bus.dispatch('cartAdd', {});
    await until(() => shown() === 'new');
    expect(s.gets).toBe(2);
    router.dispose();
  });
});

/*
 * Plan 1.28 item 6 (log s35.207). The plan named "the loader cache"
 * (src/router/loaders.ts). The router holds no cache: `runLoaders` calls the
 * preset, and the in-box preset (`fetchLoaders`, src/router-fetch/index.ts)
 * reads through the HttpClient it is given, so a cached loader read is the
 * client's own cache entry. This file runs the B6 cases (log B6, ext 10, 11,
 * 12) through a router navigation on a real `node:http` server: a loader read
 * in flight across an invalidation of its URL, a write to the loader's URL
 * through the same client, and `revalidateRoutes`. Each answers as the client
 * alone does (tests/http-cache-writes.test.ts,
 * tests/http-cache-unrelated-invalidation.test.ts, the positive control), and
 * the first case's control shows the revisit does read the cache.
 */
