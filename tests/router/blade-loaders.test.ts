// @vitest-environment happy-dom
/**
 * Blade rows (custom fetchBlade, bladeFetcher), route-table loaders (remote url, inline), and component resolution (lazy import, missing key).
 * Why: a table or blade fetch that failed silently, or a remote table that read a bundler-only global, would leave a Blade app with no routes or a wrong error.
 * Shows: fetchBlade gets the base-prefixed path and its HTML becomes the last render component; a rejected fetch gives router:failed:blade; bladeFetcher calls the client with responseType text; a remote table loads, reloads, and a failure reports router:failed:routes; it loads with no global process; an inline table loads; a lazy component loads once; an unknown key gives router:missing:component.
 */
import { describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import { bladeFetcher } from '@router/remote';
import { isRouterError } from '@router/errors';
import type { HttpClient } from '../../src/http';
import type { RouteRecord } from '@router/types';
import { makeRouter } from './fixture';

const ROWS: RouteRecord[] = [
  { name: 'shell', path: '/', parent: null },
  { name: 'home', path: '/', parent: 'shell', component: 'Home' },
  { name: 'report', path: '/report', parent: 'shell', blade: true },
];

const HOME = { Home: defineComponent({ render: () => h('span', 'home') }) };

/** Minimal fake HttpClient - only get() is used by the router. */
function fakeHttp(get: (url: string, config?: unknown) => Promise<{ data: unknown }>): HttpClient {
  return { get, onInvalidateGroup: () => () => {} } as unknown as HttpClient;
}

describe('blade rows', () => {
  it('wraps fetched HTML into a component via a custom fetchBlade', async () => {
    const fetchBlade = vi.fn(async () => '<p>server html</p>');
    const router = makeRouter({
      base: '/admin',
      routes: ROWS,
      components: HOME,
      fetchBlade,
      hydrate: vi.fn(),
    });
    await router.isReady();

    expect(await router.push('/report')).toBeNull();
    // The second argument is the router's client: none here.
    expect(fetchBlade).toHaveBeenCalledWith('/admin/report', undefined);
    const render = router.currentRoute.value.render;
    expect(render[render.length - 1].component).toBeTypeOf('object'); // makeBladeComponent result
  });

  it('surfaces router:failed:blade when the fetch rejects', async () => {
    const onError = vi.fn();
    const router = makeRouter({
      base: '/admin',
      routes: ROWS,
      components: HOME,
      fetchBlade: async () => {
        throw new Error('network down');
      },
      onError,
    });
    await router.isReady();

    expect(isRouterError(await router.push('/report'), 'router:failed:blade')).toBe(true);
    expect(onError).toHaveBeenCalled();
  });

  it('bladeFetcher extracts bladeRoot from fetched HTML via the http client', async () => {
    const get = vi.fn(async () => ({
      data: '<html><body><main><h1>Hi</h1></main><footer>skip</footer></body></html>',
    }));
    const router = makeRouter({
      base: '/admin',
      routes: ROWS,
      components: HOME,
      // bladeFetcher lives in router/remote: the core builds no http client for it.
      fetchBlade: bladeFetcher({ http: fakeHttp(get) }),
    });
    await router.isReady();

    expect(await router.push('/report')).toBeNull();
    expect(get).toHaveBeenCalledWith('/admin/report', expect.objectContaining({ responseType: 'text' }));
  });
});

describe('table loaders', () => {
  it('loads a remote table from { url }; reload() refetches', async () => {
    const get = vi.fn(async () => ({ data: { routes: ROWS, base: '/admin' } }));
    const router = makeRouter({
      base: '/admin',
      routes: { url: '/api/routes' },
      components: HOME,
      http: fakeHttp(get),
    });
    await router.isReady();

    // No call count here: the client's default re-sends a read (tests/router/one-client.test.ts).
    expect(get).toHaveBeenCalledWith('/api/routes');
    expect(router.currentRoute.value.location.name).toBe('home');

    await router.reload();
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('remote table load failure dispatches router:failed:routes', async () => {
    const onError = vi.fn();
    const router = makeRouter({
      base: '/admin',
      routes: { url: '/api/routes' },
      components: {},
      http: fakeHttp(async () => {
        throw new Error('500');
      }),
      onError,
    });
    await router.isReady().catch(() => {}); // start() rejects; error is dispatched

    expect(onError).toHaveBeenCalled();
    expect(isRouterError(onError.mock.calls[0][0], 'router:failed:routes')).toBe(true);
  });

  it('loads a remote table with no global `process` (no-bundler delivery)', async () => {
    // No-bundler delivery has no define and no `process`; Node always has one, so it is deleted.
    const saved = globalThis.process;
    const onError = vi.fn();
    const get = vi.fn(async () => ({ data: { routes: ROWS, base: '/admin' } }));
    const router = makeRouter({
      base: '/admin',
      routes: { url: '/api/routes' },
      components: HOME,
      http: fakeHttp(get),
      onError,
    });

    // @ts-expect-error - deleting a required global on purpose.
    delete globalThis.process;
    try {
      await router.isReady();
    } finally {
      globalThis.process = saved;
    }

    expect(onError).not.toHaveBeenCalled();
    expect(router.currentRoute.value.location.name).toBe('home');
  });

  it('loads an inline table from a DOM element', async () => {
    const el = document.createElement('script');
    el.id = 'vcr-routes';
    el.textContent = JSON.stringify({ routes: ROWS });
    document.body.appendChild(el);

    const router = makeRouter({
      base: '/admin',
      routes: { inline: '#vcr-routes' },
      components: HOME,
    });
    await router.isReady();

    expect(router.currentRoute.value.location.name).toBe('home');
    el.remove();
  });
});

describe('component resolution', () => {
  const LAZY_ROWS: RouteRecord[] = [
    { name: 'shell', path: '/', parent: null },
    { name: 'home', path: '/', parent: 'shell', component: 'Home' },
    { name: 'lazy', path: '/lazy', parent: 'shell', component: 'Lazy' },
    { name: 'ghost', path: '/ghost', parent: 'shell', component: 'Ghost' },
  ];

  it('loads a lazy (async import) component once and caches it', async () => {
    const Lazy = defineComponent({ render: () => h('span', 'lazy') });
    const loader = vi.fn(async () => ({ default: Lazy }));
    const router = makeRouter({
      base: '/admin',
      routes: LAZY_ROWS,
      components: { ...HOME, Lazy: loader },
    });
    await router.isReady();

    await router.push('/lazy');
    expect(loader).toHaveBeenCalledTimes(1);
    await router.push('/');
    await router.push('/lazy'); // served from componentCache
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('surfaces router:missing:component for an unregistered component key', async () => {
    const router = makeRouter({
      base: '/admin',
      routes: LAZY_ROWS,
      components: HOME, // no 'Ghost',
    });
    await router.isReady();

    expect(isRouterError(await router.push('/ghost'), 'router:missing:component')).toBe(true);
  });
});
