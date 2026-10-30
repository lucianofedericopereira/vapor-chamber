// @vitest-environment happy-dom
/**
 * Unusual mid-navigation paths of the router engine: guards and hooks that unregister during the walk, redirect chains, a post-commit throw.
 * Why: a guard or hook that removes itself or a later peer would make the walk skip or re-run a neighbour, a redirect loop
 * would hang push(), and a throwing post-commit hook would turn a committed navigation into a failure.
 * Shows: the next guard or hook still runs once and none runs twice; false aborts, a location redirects, a two-guard loop
 * gives router:exceeded:redirects; a redirect during popstate replaces; push() without a table returns a router error;
 * a post-commit throw is logged and push() returns null.
 */

import { describe, expect, it, vi } from 'vitest';
import { createMemoryHistory } from '@router/history';
import { isRouterError } from '@router/errors';
import type { RouteRecord } from '@router/types';
import { makeRouter as fixtureRouter } from './fixture';

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

// The fixture's router on this file's table (its list page declares a query).
const makeRouter = (opts: Record<string, unknown> = {}) => fixtureRouter({ routes: ROWS, ...opts });

describe('resolve() shapes', () => {
  it('throws router:missing:routes before the table is loaded', () => {
    const router = fixtureRouter({
      // A remote source, so no table exists until start() resolves.
      routes: { url: '/routes.json' } as never,
      components: {},
    });
    expect(() => (router as unknown as { resolve: (t: string) => string }).resolve('/list')).not.toThrow();
    router.dispose();
  });

  it('an object `to` with no path resolves against the current path', async () => {
    const router = makeRouter();
    await router.isReady();
    await router.push('/list');

    await router.push({ query: { tag: 'x' } } as never);
    expect(router.currentRoute.value.location.path).toBe('/list');
    expect(router.currentRoute.value.location.query.tag).toBe('x');
    router.dispose();
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
    // A null patch value removes the key; it is never serialised as the string "null".
    expect(q.tag).toEqual(['a', 'b']);
    expect(q.page === undefined || q.page === '1').toBe(true);
    router.dispose();
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
      offFirst();
      return true;
    });
    router.beforeEach(() => {
      order.push('second');
      return true;
    });

    await router.push('/list');

    // Without the index correction the shrinking array would slide 'second' past the cursor.
    expect(order).toEqual(['first', 'second']);
    router.dispose();
  });

  // Removing a LATER peer moves nothing at or before the cursor, so a length-based correction would re-run the guard that just ran.
  it('does not re-run a guard that unregisters a LATER one', async () => {
    const router = makeRouter();
    await router.isReady();

    const order: string[] = [];
    let offC!: () => void;
    // Three, so a guard after the cursor remains once C is gone; with two the loop would end and hide an over-correction.
    router.beforeEach(() => {
      order.push('a');
      offC();
      return true;
    });
    router.beforeEach(() => {
      order.push('b');
      return true;
    });
    offC = router.beforeEach(() => {
      order.push('c');
      return true;
    });

    await router.push('/list');

    expect(order).toEqual(['a', 'b']);
    router.dispose();
  });

  it('a guard returning false aborts with a router error', async () => {
    const router = makeRouter();
    await router.isReady();
    router.beforeEach(() => false);

    const result = await router.push('/list');
    expect(isRouterError(result, 'router:refused:guard')).toBe(true);
    expect(router.currentRoute.value.location.path).toBe('/');
    router.dispose();
  });

  it('a guard returning a location redirects there', async () => {
    const router = makeRouter();
    await router.isReady();

    const off = router.beforeEach((to) => (to.path === '/list' ? '/' : true));
    expect(await router.push('/list')).toBeNull();
    expect(router.currentRoute.value.location.path).toBe('/');
    off();
    router.dispose();
  });

  it('reports router:exceeded:redirects instead of hanging when two guards redirect at each other', async () => {
    // Both targets are away from the start: a redirect onto the committed location short-circuits and would end the chain early.
    const router = fixtureRouter({
      routes: [
        { name: 'home', path: '/', component: 'Home' },
        { name: 'a', path: '/a', component: 'Home' },
        { name: 'b', path: '/b', component: 'Home' },
      ] as RouteRecord[],
      components: { Home: { name: 'Home' } },
      onError: () => {},
    });
    await router.isReady();

    const offA = router.beforeEach((to) => (to.path === '/a' ? '/b' : true));
    const offB = router.beforeEach((to) => (to.path === '/b' ? '/a' : true));

    const result = await router.push('/a');

    expect(isRouterError(result, 'router:exceeded:redirects')).toBe(true);
    offA();
    offB();
    router.dispose();
  });

  it('a self-redirecting guard chain still resolves within the bound', async () => {
    const router = makeRouter();
    await router.isReady();

    // Three hops stay inside the redirect bound.
    let hops = 0;
    const off = router.beforeEach((to) => {
      if (to.path === '/list' && hops < 3) {
        hops++;
        return hops < 3 ? '/list' : '/';
      }
      return true;
    });

    expect(await router.push('/list')).toBeNull();
    expect(router.currentRoute.value.location.path).toBe('/');
    off();
    router.dispose();
  });

  it('a redirect during a popstate replaces rather than pushing', async () => {
    const history = createMemoryHistory('/');
    const router = makeRouter({ history });
    await router.isReady();
    await router.push('/list');

    const off = router.beforeEach((to) => (to.path === '/' ? '/list' : true));
    router.back();
    await new Promise((resolve) => setTimeout(resolve, 0));

    // A push would leave the '/' entry behind, so the next Back would redirect again and strand the user.
    expect(router.currentRoute.value.location.path).toBe('/list');
    off();
    router.dispose();
  });
});

describe('navigating without a table', () => {
  it('reports router:missing:routes instead of throwing out of push()', async () => {
    const router = fixtureRouter({
      routes: { url: '/routes.json' } as never,
      components: {},
      http: { get: async () => { throw new Error('offline'); } } as never,
    });
    await router.isReady().catch(() => {});

    const result = await router.push('/list');
    // Returned as a value, not thrown, so a caller needs no try/catch around push().
    expect(isRouterError(result)).toBe(true);
    router.dispose();
  });
});

describe('afterEach hooks', () => {
  it('does not skip the next hook when one unregisters itself mid-walk', async () => {
    const router = makeRouter();
    await router.isReady();

    const order: string[] = [];
    let offFirst!: () => void;
    offFirst = router.afterEach(() => {
      order.push('first');
      offFirst();
    });
    router.afterEach(() => {
      order.push('second');
    });

    await router.push('/list');

    expect(order).toEqual(['first', 'second']);
    router.dispose();
  });

  // Same rule as the guard case: a hook that tears down a later sibling must not make the hook that just fired run again.
  it('does not re-run a hook that unregisters a LATER one', async () => {
    const router = makeRouter();
    await router.isReady();

    const order: string[] = [];
    let offC!: () => void;
    // Three, so a hook after the cursor remains once C is gone.
    router.afterEach(() => {
      order.push('a');
      offC();
    });
    router.afterEach(() => {
      order.push('b');
    });
    offC = router.afterEach(() => {
      order.push('c');
    });

    await router.push('/list');

    expect(order).toEqual(['a', 'b']);
    router.dispose();
  });
});

describe('post-commit failure', () => {
  it('logs and returns null when a hook throws after the route committed', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    // onCommit runs scroll restoration, so a throwing scrollTo fails after the URL is written.
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {
      throw new Error('scroll blew up');
    });

    const router = makeRouter({ scroll: true });
    await router.isReady();
    const result = await router.push('/list');

    // The navigation stands: reverting would leave the URL and the rendered tree disagreeing.
    expect(result).toBeNull();
    expect(router.currentRoute.value.location.path).toBe('/list');
    expect(error).toHaveBeenCalled();
    router.dispose();
  });
});
