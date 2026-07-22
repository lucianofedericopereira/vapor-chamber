/**
 * Tests for router/composables.ts — useRouter/useRoute/useQueryParam/
 * useRouteData/useRouteError/useMenu/useBreadcrumbs/onBeforeLeave.
 *
 * Composables read through inject(ROUTER_KEY), so each call runs inside an app
 * context via app.runWithContext() — no component mount needed.
 */

import { describe, expect, it, vi } from 'vitest';
import { computed, createApp, effectScope, isRef, unref } from 'vue';
import { createMemoryHistory } from '../../src/router/history';
import { createRouter } from '../../src/router/index';
import {
  onBeforeLeave,
  useBreadcrumbs,
  useMenu,
  useQueryParam,
  useRoute,
  useRouteData,
  useRouteError,
  useRouter,
  usePagination,
} from '../../src/router/composables';
import { ROUTER_KEY } from '../../src/router/keys';
import type { RouteRecord } from '../../src/router/types';

const ROWS: RouteRecord[] = [
  { name: 'shell', path: '/', parent: null },
  { name: 'home', path: '/', parent: 'shell', component: 'Home', meta: { menu: 0, title: 'nav.home' } },
  {
    name: 'list',
    path: '/list',
    parent: 'shell',
    component: 'List',
    query: { page: { type: 'int', default: 1 }, q: {} },
    meta: { menu: 1, title: 'nav.list' },
  },
];

function makeRouter() {
  return createRouter({
    base: '/admin',
    history: createMemoryHistory('/admin'),
    routes: ROWS,
    components: { Home: { name: 'Home' }, List: { name: 'List' } },
  });
}

/** Run a composable inside an app context so inject(ROUTER_KEY) resolves. */
function withRouter<T>(router: ReturnType<typeof makeRouter>, fn: () => T): T {
  const app = createApp({});
  app.provide(ROUTER_KEY, router);
  return app.runWithContext(fn);
}

describe('router composables', () => {
  it('useRouter throws when no router is provided', () => {
    const app = createApp({});
    expect(() => app.runWithContext(() => useRouter())).toThrow(/no router provided/);
  });

  it('useRouter returns the router; useRoute tracks the current location', async () => {
    const router = makeRouter();
    await router.isReady();
    expect(withRouter(router, () => useRouter())).toBe(router);

    const route = withRouter(router, () => useRoute());
    expect(route.value.name).toBe('home');
    await router.push('/list');
    expect(route.value.name).toBe('list');
  });

  it('useQueryParam reads declared defaults and writes through the query fast path', async () => {
    const router = makeRouter();
    await router.isReady();
    await router.push('/list');

    const page = withRouter(router, () => useQueryParam<number>('page'));
    expect(page.value).toBe(1); // declared default, not present in URL

    page.value = 2; // setter → setQuery(default history policy)
    expect(router.currentRoute.value.location.query.page).toBe('2');
    expect(page.value).toBe(2); // decoded back to int

    page.push(3);
    expect(page.value).toBe(3);
    page.replace(4);
    expect(page.value).toBe(4);
    page.clear();
    expect(page.value).toBe(1); // key removed → falls back to declared default
  });

  it('useQueryParam honors an explicit definition arg', async () => {
    const router = makeRouter();
    await router.isReady();
    await router.push('/list');

    const q = withRouter(router, () => useQueryParam<string>('q', {}));
    q.value = 'hello';
    expect(router.currentRoute.value.location.query.q).toBe('hello');
    expect(q.value).toBe('hello');
  });

  it('useRouteData returns undefined when no loader data is committed', async () => {
    const router = makeRouter();
    await router.isReady();
    await router.push('/list');

    expect(withRouter(router, () => useRouteData()).value).toBeUndefined();
    expect(withRouter(router, () => useRouteData('list')).value).toBeUndefined();
  });

  it('useRouteError exposes latestError and clears it', async () => {
    const router = makeRouter();
    await router.isReady();

    const { latestError, clear } = withRouter(router, () => useRouteError());
    router.lastError.value = new Error('boom');
    expect((latestError.value as Error).message).toBe('boom');
    clear();
    expect(latestError.value).toBeNull();
  });

  it('useMenu and useBreadcrumbs project the table', async () => {
    const router = makeRouter();
    await router.isReady();
    await router.push('/list');

    const menu = withRouter(router, () => useMenu());
    expect(Array.isArray(menu.value)).toBe(true);
    expect(menu.value.length).toBeGreaterThan(0);

    const crumbs = withRouter(router, () => useBreadcrumbs());
    expect(Array.isArray(crumbs.value)).toBe(true);
  });

  it('onBeforeLeave guards PATH navigation, can refuse, and auto-disposes with the scope', async () => {
    const router = makeRouter();
    await router.isReady();

    const guard = vi.fn(() => false as const);
    const scope = effectScope();
    scope.run(() => {
      withRouter(router, () => onBeforeLeave(guard));
    });

    await router.push('/list');
    expect(guard).toHaveBeenCalled();
    expect(router.currentRoute.value.location.name).toBe('home'); // refused → stayed

    scope.stop(); // onScopeDispose → guard removed
    await router.push('/list');
    expect(router.currentRoute.value.location.name).toBe('list');
  });
});

describe('useQueryParam is a real ref', () => {
  it('reports as a ref, so templates auto-unwrap it', async () => {
    const router = makeRouter();
    await router.isReady();
    withRouter(router, () => {
      const page = useQueryParam<number>('page');
      // Regression: this used to be a plain object with a `value` accessor.
      // isRef() false meant Vue did NOT unwrap it in templates, so this was
      // the one composable whose templates needed `.value` — inconsistent with
      // useRoute/useRouteData/useMenu, and a silent papercut.
      expect(isRef(page)).toBe(true);
      expect(unref(page)).toBe(page.value);
      expect(typeof page.push).toBe('function');
      expect(typeof page.replace).toBe('function');
      expect(typeof page.clear).toBe('function');
    });
    router.destroy();
  });

  it('reads the URL and writes back through it', async () => {
    const router = makeRouter();
    await router.isReady();
    await router.push('/list?page=2');
    withRouter(router, () => {
      const page = useQueryParam<number>('page');
      expect(page.value).toBe(2);
      page.value = 5;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(router.currentRoute.value.location.query.page).toBe('5');
    router.destroy();
  });

  it('tracks navigation: a computed over it re-evaluates when the URL changes', async () => {
    const router = makeRouter();
    await router.isReady();
    const doubled = withRouter(router, () => {
      const page = useQueryParam<number>('page');
      return computed(() => (Number(page.value) || 1) * 2);
    });
    expect(doubled.value).toBe(2); // default page 1
    await router.push('/list?page=4');
    await new Promise((r) => setTimeout(r, 20));
    expect(doubled.value).toBe(8);
    router.destroy();
  });
});

describe('usePagination', () => {
  const PAGED: RouteRecord[] = [
    {
      name: 'items',
      path: '/items',
      component: 'List',
      load: '/api/items?page={page}',
      query: { page: { type: 'int', default: 1, history: 'push' } },
    },
  ];

  /** A router whose loader returns a fixed paginated envelope. */
  function pagedRouter(payload: unknown, template = '/api/items?page={page}') {
    return createRouter({
      base: '/admin',
      history: createMemoryHistory('/admin'),
      routes: PAGED.map((row) => ({ ...row, load: template })),
      components: { List: { name: 'List' } },
      loaders: { url: async () => payload },
    });
  }

  it('reads the plain-JSON envelope: items / total / per_page / last_page', async () => {
    const router = pagedRouter({ items: [{ id: 1 }, { id: 2 }], total: 47, per_page: 10, last_page: 5 });
    await router.isReady();
    await router.push('/items?page=2');

    withRouter(router, () => {
      const p = usePagination<{ id: number }>();
      expect(p.items.value).toHaveLength(2);
      expect(p.total.value).toBe(47);
      expect(p.perPage.value).toBe(10);
      expect(p.lastPage.value).toBe(5);
      expect(p.page.value).toBe(2);
      expect(p.hasPrev.value).toBe(true);
      expect(p.hasNext.value).toBe(true);
    });
    router.destroy();
  });

  it('reads a Laravel-style { data, meta } envelope with no configuration', async () => {
    const router = pagedRouter({ data: [{ id: 9 }], meta: { total: 3, per_page: 1, last_page: 3 } });
    await router.isReady();
    await router.push('/items');

    withRouter(router, () => {
      const p = usePagination<{ id: number }>();
      expect(p.items.value).toEqual([{ id: 9 }]);
      expect(p.total.value).toBe(3);
      expect(p.lastPage.value).toBe(3);
    });
    router.destroy();
  });

  it('derives lastPage when the backend omits it', async () => {
    const router = pagedRouter({ items: [1, 2], total: 25, per_page: 10 });
    await router.isReady();
    await router.push('/items');
    withRouter(router, () => {
      expect(usePagination().lastPage.value).toBe(3); // ceil(25/10)
    });
    router.destroy();
  });

  it('next/prev/go write the URL and clamp to the valid range', async () => {
    const router = pagedRouter({ items: [], total: 30, per_page: 10, last_page: 3 });
    await router.isReady();
    await router.push('/items?page=2');

    const p = withRouter(router, () => usePagination());
    p.next();
    await new Promise((r) => setTimeout(r, 20));
    expect(router.currentRoute.value.location.query.page).toBe('3');

    p.next(); // already last — clamped, stays 3
    await new Promise((r) => setTimeout(r, 20));
    expect(router.currentRoute.value.location.query.page).toBe('3');

    p.prev(); // 4 → 3
    await new Promise((r) => setTimeout(r, 20));
    expect(router.currentRoute.value.location.query.page).toBe('2');

    p.go(-5); // clamped to 1
    await new Promise((r) => setTimeout(r, 20));
    expect(Number(router.currentRoute.value.location.query.page ?? 1)).toBe(1);

    p.prev(); // already first — clamped, stays 1
    await new Promise((r) => setTimeout(r, 20));
    expect(Number(router.currentRoute.value.location.query.page ?? 1)).toBe(1);
    router.destroy();
  });

  it('hasNext/hasPrev bound the ends', async () => {
    const router = pagedRouter({ items: [], total: 10, per_page: 10, last_page: 1 });
    await router.isReady();
    await router.push('/items');
    withRouter(router, () => {
      const p = usePagination();
      expect(p.hasPrev.value).toBe(false);
      expect(p.hasNext.value).toBe(false);
    });
    router.destroy();
  });

  it('pageRange windows long ranges with 0 marking an elision', async () => {
    const router = pagedRouter({ items: [], total: 200, per_page: 10, last_page: 20 });
    await router.isReady();
    await router.push('/items?page=10');
    withRouter(router, () => {
      const range = usePagination({ window: 7 }).pageRange.value;
      expect(range[0]).toBe(1); // first page always present
      expect(range.at(-1)).toBe(20); // last page always present
      expect(range).toContain(10); // the current page
      expect(range).toContain(0); // elision marker
      expect(range.length).toBeLessThanOrEqual(9);
    });
    router.destroy();
  });

  it('lists every page when the range fits inside the window', async () => {
    const router = pagedRouter({ items: [], total: 30, per_page: 10, last_page: 3 });
    await router.isReady();
    await router.push('/items');
    withRouter(router, () => {
      expect(usePagination({ window: 7 }).pageRange.value).toEqual([1, 2, 3]);
    });
    router.destroy();
  });

  it('custom extractors override the defaults', async () => {
    const router = pagedRouter({ rows: [{ id: 1 }], count: 99 });
    await router.isReady();
    await router.push('/items');
    withRouter(router, () => {
      const p = usePagination<{ id: number }>({
        items: (d) => d.rows,
        total: (d) => d.count,
        perPage: () => 25,
      });
      expect(p.items.value).toEqual([{ id: 1 }]);
      expect(p.total.value).toBe(99);
      expect(p.lastPage.value).toBe(4); // ceil(99/25)
    });
    router.destroy();
  });

  it('survives a route with no loader data at all', async () => {
    const router = pagedRouter(undefined);
    await router.isReady();
    await router.push('/items');
    withRouter(router, () => {
      const p = usePagination();
      expect(p.items.value).toEqual([]);
      expect(p.total.value).toBe(0);
      expect(p.lastPage.value).toBe(1);
      expect(p.hasNext.value).toBe(false);
    });
    router.destroy();
  });
});
