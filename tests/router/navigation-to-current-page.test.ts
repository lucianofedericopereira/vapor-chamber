// @vitest-environment happy-dom
/**
 * Asking for the page on screen while another navigation is pending supersedes the pending one.
 * Why: a click on a slow link followed by a click on the current page would otherwise end on the slow page, and a Forward during a held Back would commit a page that disagrees with the address bar.
 * Shows: a push to the committed page answers null and aborts the older navigation, its loader signal and its loading state; a Forward to the page during a held Back leaves page and address bar on it; with nothing in flight a repeat push answers null and changes nothing.
 * See: log 35.91, tests/router/superseded-navigation-history.test.ts
 */
import { describe, expect, it, vi } from 'vitest';
import { createMemoryHistory } from '@router/history';
import { createRouter } from '@router/index';
import { isRouterError } from '@router/errors';
import type { RouteRecord } from '@router/types';
import { ROWS } from './fixture';

const tick = () => new Promise((r) => setTimeout(r, 0));

async function build(routes: RouteRecord[] = ROWS, loader?: (signal: AbortSignal) => unknown) {
  const history = createMemoryHistory('/');
  const router = createRouter({
    history,
    routes,
    components: { Home: { name: 'Home' }, List: { name: 'List' } },
    loaders: loader ? { prefixes: { 'rows:': (_ref, _loc, _rec, signal) => loader(signal) } } : undefined,
    scroll: false,
    links: false,
    announce: false,
  });
  await router.isReady();
  return { history, router };
}

/** A guard that holds the next navigation until released. */
function holdNext(router: { beforeEach: (g: () => Promise<void>) => () => void }) {
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let first = true;
  router.beforeEach(async () => {
    if (first) {
      first = false;
      await held;
    }
  });
  return release;
}

describe('a navigation to the page on screen', () => {
  it('push: supersedes the navigation in flight', async () => {
    const { history, router } = await build();
    const release = holdNext(router);
    const going = router.push('/list');
    expect(await router.push('/')).toBeNull();
    release();
    expect(isRouterError(await going, 'router:aborted:navigation')).toBe(true);
    expect(router.currentRoute.value.location.fullPath).toBe('/');
    expect(history.location()).toBe('/');
    router.dispose();
  });

  it('pop: Forward back to the page during a held Back keeps the page and the address bar together', async () => {
    const { history, router } = await build();
    await router.push('/list');
    const release = holdNext(router);
    const go = vi.spyOn(history, 'go');
    history.go(-1); // Back: to /, held
    history.go(1); // Forward: to /list, the page on screen
    release();
    for (let i = 0; i < 5; i++) await tick();
    expect(router.currentRoute.value.location.fullPath).toBe('/list');
    expect(history.location()).toBe('/list');
    expect(go.mock.calls).toEqual([[-1], [1]]);
    router.dispose();
  });

  it('push: the superseded navigation loses its loading state and its loaders', async () => {
    const routes: RouteRecord[] = [
      { name: 'shell', path: '/', parent: null },
      { name: 'home', path: '/', parent: 'shell', component: 'Home' },
      { name: 'list', path: '/list', parent: 'shell', component: 'List', load: 'rows:list' },
    ];
    let seen: AbortSignal | null = null;
    let release!: () => void;
    const { router } = await build(routes, (signal) => {
      seen = signal;
      return new Promise((r) => (release = () => r('rows')));
    });
    const going = router.push('/list');
    await tick();
    expect(router.isLoading.value).toBe(true);
    await router.push('/');
    expect(router.isLoading.value).toBe(false);
    expect((seen as AbortSignal | null)?.aborted).toBe(true);
    release();
    expect(isRouterError(await going, 'router:aborted:navigation')).toBe(true);
    expect(router.currentRoute.value.location.fullPath).toBe('/');
    router.dispose();
  });

  it('control: with nothing in flight it answers null and changes nothing', async () => {
    const { history, router } = await build();
    await router.push('/list');
    const before = router.currentRoute.value;
    expect(await router.push('/list')).toBeNull();
    expect(router.currentRoute.value).toBe(before);
    expect(history.location()).toBe('/list');
    router.dispose();
  });
});
