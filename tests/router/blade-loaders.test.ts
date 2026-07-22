// @vitest-environment happy-dom
/**
 * Tests for router/index.ts — blade-row rendering (custom + default fetchBlade)
 * and the table loaders (remote { url } / inline { inline }), lazy component
 * import, and the component_missing path.
 */

import { describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import { createMemoryHistory } from '../../src/router/history';
import { createRouter } from '../../src/router/index';
import { isRouterError } from '../../src/router/errors';
import type { HttpClient } from '../../src/http';
import type { RouteRecord } from '../../src/router/types';

const ROWS: RouteRecord[] = [
  { name: 'shell', path: '/', parent: null },
  { name: 'home', path: '/', parent: 'shell', component: 'Home' },
  { name: 'report', path: '/report', parent: 'shell', blade: true },
];

const HOME = { Home: defineComponent({ render: () => h('span', 'home') }) };

/** Minimal fake HttpClient — only get() is used by the router. */
function fakeHttp(get: (url: string, config?: unknown) => Promise<{ data: unknown }>): HttpClient {
  return { get } as unknown as HttpClient;
}

describe('blade rows', () => {
  it('wraps fetched HTML into a component via a custom fetchBlade', async () => {
    const fetchBlade = vi.fn(async () => '<p>server html</p>');
    const router = createRouter({
      base: '/admin',
      history: createMemoryHistory('/admin'),
      routes: ROWS,
      components: HOME,
      fetchBlade,
      hydrate: vi.fn(),
    });
    await router.isReady();

    expect(await router.push('/report')).toBeNull();
    expect(fetchBlade).toHaveBeenCalledWith('/admin/report');
    const render = router.currentRoute.value.render;
    expect(render[render.length - 1].component).toBeTypeOf('object'); // makeBladeComponent result
  });

  it('surfaces blade_fetch_failed when the fetch rejects', async () => {
    const onError = vi.fn();
    const router = createRouter({
      base: '/admin',
      history: createMemoryHistory('/admin'),
      routes: ROWS,
      components: HOME,
      fetchBlade: async () => {
        throw new Error('network down');
      },
      onError,
    });
    await router.isReady();

    expect(isRouterError(await router.push('/report'), 'blade_fetch_failed')).toBe(true);
    expect(onError).toHaveBeenCalled();
  });

  it('default fetchBlade extracts bladeRoot from fetched HTML via the http client', async () => {
    const get = vi.fn(async () => ({
      data: '<html><body><main><h1>Hi</h1></main><footer>skip</footer></body></html>',
    }));
    const router = createRouter({
      base: '/admin',
      history: createMemoryHistory('/admin'),
      routes: ROWS,
      components: HOME,
      http: fakeHttp(get), // no fetchBlade → defaultFetchBlade(http, 'main')
    });
    await router.isReady();

    expect(await router.push('/report')).toBeNull();
    expect(get).toHaveBeenCalledWith('/admin/report', expect.objectContaining({ responseType: 'text' }));
  });
});

describe('table loaders', () => {
  it('loads a remote table from { url }; reload() refetches', async () => {
    const get = vi.fn(async () => ({ data: { routes: ROWS, base: '/admin' } }));
    const router = createRouter({
      base: '/admin',
      history: createMemoryHistory('/admin'),
      routes: { url: '/api/routes' },
      components: HOME,
      http: fakeHttp(get),
    });
    await router.isReady();

    expect(get).toHaveBeenCalledWith('/api/routes', expect.objectContaining({ retry: 2 }));
    expect(router.currentRoute.value.location.name).toBe('home');

    await router.reload();
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('remote table load failure dispatches routes_load_failed', async () => {
    const onError = vi.fn();
    const router = createRouter({
      base: '/admin',
      history: createMemoryHistory('/admin'),
      routes: { url: '/api/routes' },
      components: {},
      http: fakeHttp(async () => {
        throw new Error('500');
      }),
      onError,
    });
    await router.isReady().catch(() => {}); // start() rejects; error is dispatched

    expect(onError).toHaveBeenCalled();
    expect(isRouterError(onError.mock.calls[0][0], 'routes_load_failed')).toBe(true);
  });

  it('loads an inline table from a DOM element', async () => {
    const el = document.createElement('script');
    el.id = 'vcr-routes';
    el.textContent = JSON.stringify({ routes: ROWS });
    document.body.appendChild(el);

    const router = createRouter({
      base: '/admin',
      history: createMemoryHistory('/admin'),
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
    const router = createRouter({
      base: '/admin',
      history: createMemoryHistory('/admin'),
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

  it('surfaces component_missing for an unregistered component key', async () => {
    const router = createRouter({
      base: '/admin',
      history: createMemoryHistory('/admin'),
      routes: LAZY_ROWS,
      components: HOME, // no 'Ghost'
    });
    await router.isReady();

    expect(isRouterError(await router.push('/ghost'), 'component_missing')).toBe(true);
  });
});
