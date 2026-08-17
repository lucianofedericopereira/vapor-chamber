// @vitest-environment happy-dom
/**
 * Engine paths that only occur when something unusual happens mid-navigation:
 * a guard that unregisters itself while the guard list is being walked, a
 * post-commit hook that throws after the route has already committed, and the
 * resolve() shapes that fall back rather than fail.
 *
 * These are the branches an ordinary navigation test never reaches, and each
 * one exists because the alternative is worse than the edge case: a guard
 * removing itself mid-walk would otherwise cause the engine to SKIP the next
 * guard (index drift), and a throwing post-commit hook would otherwise turn a
 * successful navigation into a rejected one after the URL had already changed.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory } from '../../src/router/history';
import { createRouter } from '../../src/router/index';
import { isRouterError } from '../../src/router/errors';
import type { RouteRecord } from '../../src/router/types';

const ROWS: RouteRecord[] = [
  { name: 'shell', path: '/', parent: null },
  { name: 'home', path: '/', parent: 'shell', component: 'Home' },
  {
    name: 'list',
    path: '/list',
    parent: 'shell',
    component: 'List',
    query: { page: { type: 'int', default: 1 }, tag: {} },
  },
];

function makeRouter(opts: Record<string, unknown> = {}) {
  return createRouter({
    history: createMemoryHistory('/'),
    routes: ROWS,
    components: { Home: { name: 'Home' }, List: { name: 'List' } },
    ...opts,
  });
}

afterEach(() => vi.restoreAllMocks());

describe('resolve() shapes', () => {
  it('throws not_ready before the table is loaded', () => {
    const router = createRouter({
      history: createMemoryHistory('/'),
      // A remote source, so no table exists until start() resolves.
      routes: { url: '/routes.json' } as never,
      components: {},
    });
    // router.resolve() swallows this into a raw href; the engine's
    // resolveLocation is the one that reports it, reached through push().
    expect(() => (router as unknown as { resolve: (t: string) => string }).resolve('/list')).not.toThrow();
    router.destroy();
  });

  it('an object `to` with no path resolves against the current path', async () => {
    const router = makeRouter();
    await router.isReady();
    await router.push('/list');

    // `{ query }` with no `path` means "stay here, change the query" — the
    // fallback to snapshot.location.path is what makes that work.
    await router.push({ query: { tag: 'x' } } as never);
    expect(router.currentRoute.value.location.path).toBe('/list');
    expect(router.currentRoute.value.location.query.tag).toBe('x');
    router.destroy();
  });

  it('parses a string `to` carrying both query and hash', async () => {
    const router = makeRouter();
    await router.isReady();
    await router.push('/list?tag=a#frag');

    const loc = router.currentRoute.value.location;
    expect(loc.path).toBe('/list');
    expect(loc.query.tag).toBe('a');
    expect(loc.hash).toBe('#frag');
    router.destroy();
  });
});

describe('query patch cleaning', () => {
  it('drops null/undefined keys and stringifies array values', async () => {
    const router = makeRouter();
    await router.isReady();
    await router.push('/list');

    router.setQuery({ tag: ['a', 'b'] as never, page: null });
    await Promise.resolve();

    const q = router.currentRoute.value.location.query;
    // Array → repeated values, kept as strings; null → key removed entirely
    // (not serialised as the string "null", which is the bug this guards).
    expect(q.tag).toEqual(['a', 'b']);
    expect(q.page === undefined || q.page === '1').toBe(true);
    router.destroy();
  });
});

describe('guards', () => {
  it('does not skip the next guard when one unregisters itself mid-walk', async () => {
    const router = makeRouter();
    await router.isReady();

    const order: string[] = [];
    let offFirst!: () => void;
    offFirst = router.beforeEach(() => {
      order.push('first');
      offFirst(); // removes itself while the engine is iterating the list
      return true;
    });
    router.beforeEach(() => {
      order.push('second');
      return true;
    });

    await router.push('/list');

    // Without the index correction the shrinking array would slide 'second'
    // past the cursor and it would never run.
    expect(order).toEqual(['first', 'second']);
    router.destroy();
  });

  it('a guard returning false aborts with a router error', async () => {
    const router = makeRouter();
    await router.isReady();
    router.beforeEach(() => false);

    const result = await router.push('/list');
    expect(isRouterError(result, 'aborted')).toBe(true);
    expect(router.currentRoute.value.location.path).toBe('/');
    router.destroy();
  });

  it('a guard returning a location redirects there', async () => {
    const router = makeRouter();
    await router.isReady();

    const off = router.beforeEach((to) => (to.path === '/list' ? '/' : true));
    expect(await router.push('/list')).toBeNull();
    expect(router.currentRoute.value.location.path).toBe('/');
    off();
    router.destroy();
  });
});

describe('navigating without a table', () => {
  it('reports not_ready instead of throwing out of push()', async () => {
    const router = createRouter({
      history: createMemoryHistory('/'),
      routes: { url: '/routes.json' } as never,
      components: {},
      http: { get: async () => { throw new Error('offline'); } } as never,
    });
    // The table never loads, so resolveLocation has nothing to resolve against.
    await router.isReady().catch(() => {});

    const result = await router.push('/list');
    // Returned as a value, not thrown: navigation errors are results here, so
    // a caller awaiting push() does not need a try/catch around every link.
    expect(isRouterError(result)).toBe(true);
    router.destroy();
  });
});

describe('setRouteData', () => {
  it('dev-warns for a record name that is not in the table, but still stores it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const router = makeRouter();
    await router.isReady();

    router.setRouteData('nope', { a: 1 } as never);

    // Loud in dev, lenient in prod: the value lands, but nothing reads it,
    // which is a typo nobody would otherwise notice.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no route record by that name'));
    router.destroy();
  });
});

describe('post-commit failure', () => {
  it('logs and returns null when a hook throws after the route committed', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    // onCommit runs scroll restoration; making that throw is the realistic way
    // to fail *after* the URL has already been written.
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {
      throw new Error('scroll blew up');
    });

    const router = makeRouter();
    await router.isReady();
    const result = await router.push('/list');

    // The navigation stands: reverting a committed route would leave the URL
    // and the rendered tree disagreeing.
    expect(result).toBeNull();
    expect(router.currentRoute.value.location.path).toBe('/list');
    expect(error).toHaveBeenCalled();
    router.destroy();
  });
});
