/**
 * A query-only change while a path navigation is still loading, and a query refetch in flight beside a navigation.
 * Why: the latest request must win, or the pending page would commit over the query and lose it; a refetch must not abort the page lane, and isLoading must stay true until the refetch ends.
 * Shows: a query commit aborts the in-flight loader, the push answers router:aborted:navigation with no onError, and the router stays on products with the query in history; a blocked refetch keeps isLoading true after a full navigation settles, then false once released.
 * See: log s35.120, tests/router/query-during-navigation.test.ts
 */

import { describe, expect, it, vi } from 'vitest';
import { isRouterError } from '@router/errors';
import { createMemoryHistory } from '@router/history';
import { createRouter } from '@router/index';
import type { LoaderHandlers } from '@router/loaders';
import type { RouteRecord } from '@router/types';

const ROWS: RouteRecord[] = [
  { name: 'shell', path: '/', parent: null },
  { name: 'home', path: '/', parent: 'shell', component: 'Home' },
  {
    // Start page; its loader is affected by the query, so setQuery refetches.
    name: 'products',
    path: '/products',
    parent: 'shell',
    component: 'Products',
    load: 'rows:products',
    query: { page: { type: 'int', default: 1 }, name: {} },
  },
  {
    // Target page; its loader is gated by the test.
    name: 'remote',
    path: '/remote',
    parent: 'shell',
    component: 'Remote',
    load: '/api/vc/remote',
  },
];

describe('REPRO: query change during an in-flight navigation', () => {
  it('a query COMMIT supersedes the pending path navigation, on purpose and told (s35.120)', async () => {
    let releaseRemote!: () => void;
    const remoteGate = new Promise<void>((resolve) => {
      releaseRemote = resolve;
    });
    let remoteAborted = false;

    const handlers: LoaderHandlers = {
      prefixes: {
        'rows:': (ref, location) => ({ ref, name: String(location.query.name ?? '') }),
      },
      // Rejects on abort, like a fetch-backed preset.
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

    const pending = router.push('/remote');
    await Promise.resolve();

    router.setQuery({ name: 'abc' });

    releaseRemote();
    const result = await pending;

    // The query commit supersedes the pending navigation; the push answers aborted:navigation, not onError.
    expect(remoteAborted).toBe(true);
    expect(isRouterError(result, 'router:aborted:navigation')).toBe(true);
    expect(router.currentRoute.value.location.name).toBe('products');
    expect(history.location()).toBe('/products?name=abc');
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
          if (rowsCalls > 1) await rowsGate; // only the refetch blocks
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

    // The navigation settles while the refetch it triggered stays blocked.
    router.setQuery({ name: 'abc' });
    await router.push('/remote');

    expect(rowsCalls).toBe(2); // the refetch did start
    expect(router.isLoading.value).toBe(true); // and has NOT finished

    releaseRows();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(router.isLoading.value).toBe(false);
  });
});
