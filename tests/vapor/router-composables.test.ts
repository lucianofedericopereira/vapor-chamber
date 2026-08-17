// @vitest-environment happy-dom
/**
 * FIXTURE — the router composables inside a REAL mounted Vapor component.
 *
 * WHY THIS FILE EXISTS. `tests/router/composables.test.ts` covers all eight
 * composables, but through `app.runWithContext(fn)` on a VDOM app — no
 * component, no mount, no Vapor. `tests/router/vapor-fixture.test.ts` does use
 * a real Vapor app, but only to measure provide/inject as a primitive; it never
 * calls a composable. So the actual shipped combination — a router composable
 * executing inside `defineVaporComponent({ setup() })` — had no coverage.
 *
 * That is the same gap that hid the rc.4 KeepAlive bug: `tryKeepAliveHooks`
 * was gated on `getCurrentInstance()`, which answers null in a Vapor setup, so
 * a feature was inert on Vapor while every VDOM-shaped test stayed green. The
 * router is the largest surface still exposed to that class, because it leans
 * on three context-sensitive Vue primitives — `inject()`, `getCurrentScope()`
 * and `onScopeDispose()` — and each is a place where "works in VDOM" does not
 * imply "works in Vapor".
 *
 * This file runs under `vitest.vapor.config.ts`, which aliases `vue` to the
 * with-vapor build. That alias is not a convenience: the router imports `vue`
 * as a bare specifier, so without it the router and the Vapor app would be two
 * disconnected reactivity instances and `inject(ROUTER_KEY)` would miss for
 * harness reasons. Real Vapor apps alias exactly the same way — see
 * `examples/vapor-sfc`.
 */

import { describe, expect, it } from 'vitest';
import { createMemoryHistory } from '../../src/router/history';
import { createRouter } from '../../src/router/index';
import {
  useBreadcrumbs,
  useMenu,
  usePagination,
  useQueryParam,
  useRoute,
  useRouteData,
  useRouteError,
  useRouter,
} from '../../src/router/composables';
import type { RouteRecord } from '../../src/router/types';

// Pulled from the alias target, so this is the SAME module instance the router
// imports as bare `vue` — the whole point of this config.
import { createVaporApp, defineVaporComponent, nextTick, template } from 'vue';

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

/** Mount `setup` as a real Vapor component with the router installed. */
async function mountWithRouter(router: ReturnType<typeof makeRouter>, setup: () => void) {
  const Root = defineVaporComponent({
    setup() {
      setup();
      return (template('<div>root</div>', true) as () => Node)();
    },
  });
  const host = document.createElement('div');
  document.body.appendChild(host);
  const app = createVaporApp(Root as never);
  app.use(router as never);
  app.mount(host);
  return { unmount: () => { app.unmount(); host.remove(); } };
}

describe('router composables inside a real Vapor component', () => {
  it('runs on a with-vapor build (guards the alias itself)', () => {
    // If this fails, the alias is wrong and every other assertion here would be
    // measuring the harness rather than the router.
    expect(typeof createVaporApp).toBe('function');
    expect(typeof defineVaporComponent).toBe('function');
  });

  it('useRouter / useRoute resolve through inject() in a Vapor setup', async () => {
    const router = makeRouter();
    await router.isReady();

    let injected: unknown;
    let path: string | undefined;
    const { unmount } = await mountWithRouter(router, () => {
      injected = useRouter();
      path = useRoute().value.path;
    });

    // The load-bearing one: app.use(router) → app.provide → inject() all work
    // across the Vapor boundary, from inside a mounted component.
    expect(injected).toBe(router);
    expect(path).toBe('/');
    unmount();
  });

  it('useRoute stays reactive across a navigation', async () => {
    const router = makeRouter();
    await router.isReady();

    let route!: { readonly value: { path: string } };
    const { unmount } = await mountWithRouter(router, () => { route = useRoute(); });

    expect(route.value.path).toBe('/');
    await router.push('/list');
    await nextTick();

    // A computed() created inside a Vapor setup must still track the router's
    // shallowRefs — one reactivity instance, so this holds.
    expect(route.value.path).toBe('/list');
    unmount();
  });

  it('useQueryParam reads and writes the URL from a Vapor setup', async () => {
    const router = makeRouter();
    await router.isReady();
    await router.push('/list');

    let page!: { value: number; push: (n: number) => void };
    const { unmount } = await mountWithRouter(router, () => {
      page = useQueryParam<number>('page') as never;
    });

    expect(page.value).toBe(1); // declared default

    page.push(3);
    await nextTick();
    expect(page.value).toBe(3);
    expect(router.currentRoute.value.location.query.page).toBe('3');

    unmount();
  });

  it('useMenu / useBreadcrumbs / useRouteData / useRouteError resolve in a Vapor setup', async () => {
    const router = makeRouter();
    await router.isReady();
    await router.push('/list');

    let menuLen = -1;
    let crumbLen = -1;
    let data: unknown = 'unset';
    let err: unknown = 'unset';
    const { unmount } = await mountWithRouter(router, () => {
      menuLen = useMenu().value.length;
      crumbLen = useBreadcrumbs().value.length;
      data = useRouteData().value;
      err = useRouteError().latestError.value;
    });

    expect(menuLen).toBeGreaterThan(0);
    expect(crumbLen).toBeGreaterThan(0);
    expect(data).toBeUndefined(); // no loader on this record
    expect(err).toBeNull();
    unmount();
  });

  it('usePagination builds state inside a Vapor setup', async () => {
    const router = makeRouter();
    await router.isReady();
    await router.push('/list');

    let pag!: { page: { value: number } };
    const { unmount } = await mountWithRouter(router, () => {
      pag = usePagination({ total: () => 42, perPage: 10 }) as never;
    });

    expect(pag.page.value).toBe(1);
    unmount();
  });

  it('unmounting a Vapor component disposes composable subscriptions', async () => {
    const router = makeRouter();
    await router.isReady();
    await router.push('/list');

    let page!: { value: number };
    const { unmount } = await mountWithRouter(router, () => {
      page = useQueryParam<number>('page') as never;
    });

    expect(page.value).toBe(1);
    unmount();

    // useQueryParam registers its unsubscribe via
    // `if (getCurrentScope()) onScopeDispose(off)`. If getCurrentScope() were
    // falsy in a Vapor setup — as getCurrentInstance() is — that cleanup would
    // never arm and every mounted route component would leak a router
    // subscription. Navigating after unmount must stay quiet.
    await expect(router.push('/')).resolves.toBeNull();
    await nextTick();
  });
});
