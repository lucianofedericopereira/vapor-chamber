// @vitest-environment happy-dom
/**
 * The router composables (`useRouter`, `useRoute`, `useQueryParam`, `useMenu`, `useBreadcrumbs`, `useRouteData`, `useRouteError`, `usePagination`) running inside a real mounted `defineVaporComponent({ setup() })`.
 * Why: the router leans on three context-sensitive Vue primitives, `inject()`, `getCurrentScope()` and `onScopeDispose()`, and "works in VDOM" does not imply "works in Vapor"; if `getCurrentScope()` were falsy in a Vapor setup, every mounted route component would leak a router subscription.
 * Shows: `useRouter`/`useRoute` resolve through `inject()`; `useRoute` tracks a navigation; `useQueryParam` reads its default and writes the URL; the menu, breadcrumbs, route data, route error and pagination composables return values in a Vapor setup; navigating after unmount stays quiet. Run under `vitest.vapor.config.ts`, which aliases `vue` to the with-vapor build so the router and the app share one reactivity instance.
 * See: tests/router/composables.test.ts, tests/router/vapor-fixture.test.ts, vitest.vapor.config.ts
 */

import { describe, expect, it } from 'vitest';
import { createMemoryHistory } from '@router/history';
import { createRouter } from '@router/index';
import {
  useBreadcrumbs,
  useMenu,
  usePagination,
  useQueryParam,
  useRoute,
  useRouteData,
  useRouteError,
  useRouter,
} from '@router/composables';
import type { RouteRecord } from '@router/types';

// The alias target: the same module instance the router imports as bare `vue`.
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
      return (template('<div>root</div>', 1) as () => Node)();
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

    expect(page.value).toBe(1);

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
    expect(data).toBeUndefined();
    expect(err).toBeNull();
    unmount();
  });

  it('usePagination builds state inside a Vapor setup', async () => {
    const router = makeRouter();
    await router.isReady();
    await router.push('/list');

    let pag!: { page: { value: number } };
    const { unmount } = await mountWithRouter(router, () => {
      pag = usePagination({ total: () => 42, perPage: () => 10 }) as never;
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

    // useQueryParam arms its unsubscribe with `onScopeDispose`; navigating after unmount must stay quiet.
    await expect(router.push('/')).resolves.toBeNull();
    await nextTick();
  });
});
