/**
 * REPRO — shared AbortController between the navigation lane and the
 * query-refetch lane (src/router/engine.ts:81).
 *
 * A query-only change fired while a PATH navigation is still loading calls
 * `controller?.abort()` (engine.ts:259) and kills the in-flight navigation's
 * loaders.
 */

import { describe, expect, it, vi } from 'vitest';
import { isRouterError } from '../../src/router/errors';
import { createMemoryHistory } from '../../src/router/history';
import { createRouter } from '../../src/router/index';
import type { LoaderHandlers } from '../../src/router/loaders';
import type { RouteRecord } from '../../src/router/types';

const ROWS: RouteRecord[] = [
  { name: 'shell', path: '/', parent: null },
  { name: 'home', path: '/', parent: 'shell', component: 'Home' },
  {
    // the page we start ON — has an affected loader, so setQuery triggers a refetch
    name: 'products',
    path: '/products',
    parent: 'shell',
    component: 'Products',
    load: 'rows:products',
    query: { page: { type: 'int', default: 1 }, name: {} },
  },
  {
    // the page we navigate TO — slow loader we control
    name: 'remote',
    path: '/remote',
    parent: 'shell',
    component: 'Remote',
    load: '/api/vc/remote',
  },
];

describe('REPRO: query change during an in-flight navigation', () => {
  it('does not cancel the pending path navigation', async () => {
    // gate the /remote loader so the navigation stays in flight
    let releaseRemote!: () => void;
    const remoteGate = new Promise<void>((resolve) => {
      releaseRemote = resolve;
    });
    let remoteAborted = false;

    const handlers: LoaderHandlers = {
      prefixes: {
        'rows:': (ref, location) => ({ ref, name: String(location.query.name ?? '') }),
      },
      // behaves like any real fetch-backed preset: rejects when the signal aborts
      url: async (template, _location, _record, signal) =>
        new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => {
            remoteAborted = true;
            reject(new DOMException('Aborted', 'AbortError'));
          });
          void remoteGate.then(() => resolve({ hit: template }));
        }),
    };

    const onError = vi.fn();
    const history = createMemoryHistory('/admin', '/products');
    const router = createRouter({
      base: '/admin',
      history,
      routes: ROWS,
      loaders: handlers,
      onError,
      components: {
        Home: { name: 'Home' },
        Products: { name: 'Products' },
        Remote: { name: 'Remote' },
      },
    });

    await router.isReady();
    expect(router.currentRoute.value.location.name).toBe('products');

    // 1. user clicks through to /remote — loaders start, nothing committed yet
    const pending = router.push('/remote');
    await Promise.resolve();

    // 2. user types in the list's search box — query-only change on /products
    router.setQuery({ name: 'abc' });

    // 3. the /remote loader finishes
    releaseRemote();
    const result = await pending;

    // ---- MEASURED on rc.2 (fails until the lanes get separate controllers) --
    //   remoteAborted    : true            <- the query refetch killed it
    //   push() result    : 'cancelled'
    //   committed route  : 'products'      <- never went to /remote
    //   history location : '/products?name=abc'
    //   onError calls    : 0               <- silent, nothing surfaced
    expect(remoteAborted).toBe(false);
    expect(isRouterError(result, 'cancelled')).toBe(false);
    expect(result).toBeNull(); // null = committed
    expect(router.currentRoute.value.location.name).toBe('remote');
    expect(history.location()).toBe('/remote');
    expect(onError).not.toHaveBeenCalled();
  });

  it('keeps isLoading true while a query refetch is still in flight', async () => {
    let releaseRows!: () => void;
    const rowsGate = new Promise<void>((resolve) => {
      releaseRows = resolve;
    });
    let rowsCalls = 0;

    const handlers: LoaderHandlers = {
      prefixes: {
        'rows:': async (ref) => {
          rowsCalls++;
          if (rowsCalls > 1) await rowsGate; // the REFETCH blocks, the initial load does not
          return { ref };
        },
      },
      url: async (template) => ({ hit: template }),
    };

    const history = createMemoryHistory('/admin', '/products');
    const router = createRouter({
      base: '/admin',
      history,
      routes: ROWS,
      loaders: handlers,
      components: { Home: { name: 'Home' }, Products: { name: 'Products' }, Remote: { name: 'Remote' } },
    });

    await router.isReady();
    expect(router.isLoading.value).toBe(false);

    // a full navigation settles while the query refetch it triggered is still blocked
    router.setQuery({ name: 'abc' });
    await router.push('/remote');

    expect(rowsCalls).toBe(2); // the refetch did start
    expect(router.isLoading.value).toBe(true); // and has NOT finished

    releaseRows();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(router.isLoading.value).toBe(false);
  });
});
