// @vitest-environment happy-dom
/**
 * router.dispose() during a held navigation cancels it.
 * Why: a navigation held on a lazy component or loader that outlived dispose() would resolve, write the history and replace the snapshot of a router nobody holds; a dispose has no successor navigation, so it must also clear isLoading.
 * Shows: a superseding push answers router:aborted:navigation (control); push, dispose, release answers router:aborted:navigation and leaves history and the snapshot at '/'; a loading navigation cancelled by dispose leaves isLoading false; a held popstate navigation cancelled by dispose calls history.go no further.
 * See: log s35.41
 */
import { describe, expect, it, vi } from 'vitest';
import { createMemoryHistory } from '@router/history';
import { createRouter } from '@router/index';
import { isRouterError } from '@router/errors';
import type { RouteRecord } from '@router/types';
import { ROWS } from './fixture';

function gate() {
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  return { held, release };
}

function build(lazy: () => Promise<unknown>, routes: RouteRecord[] = ROWS, loader?: () => Promise<unknown>) {
  const history = createMemoryHistory('/');
  const router = createRouter({
    history,
    routes: [...routes, { name: 'other', path: '/other', parent: 'shell', component: 'Other' }],
    components: { Home: { name: 'Home' }, List: lazy, Other: { name: 'Other' } },
    loaders: loader ? { prefixes: { 'rows:': loader } } : undefined,
    scroll: false,
  });
  return { router, history };
}

describe('router.dispose() cancels the navigation in flight', () => {
  it('control: a superseding push answers cancelled', async () => {
    const { held, release } = gate();
    const { router, history } = build(async () => { await held; return { name: 'List' }; });
    await router.isReady();
    const going = router.push('/list');
    const other = router.push('/other');
    release();
    expect(isRouterError(await going, 'router:aborted:navigation')).toBe(true);
    await other;
    expect(history.location()).toBe('/other');
    router.dispose();
  });

  it('push, dispose, release: cancelled, and the history is not written', async () => {
    const { held, release } = gate();
    const { router, history } = build(async () => { await held; return { name: 'List' }; });
    await router.isReady();
    const going = router.push('/list');
    router.dispose();
    release();
    expect(isRouterError(await going, 'router:aborted:navigation')).toBe(true);
    expect(history.location()).toBe('/');
    expect(router.currentRoute.value.location.fullPath).toBe('/');
  });

  it('a loading navigation cancelled by dispose leaves isLoading false', async () => {
    const { held, release } = gate();
    const routes: RouteRecord[] = [
      { name: 'shell', path: '/', parent: null },
      { name: 'home', path: '/', parent: 'shell', component: 'Home' },
      { name: 'list', path: '/list', parent: 'shell', component: 'List', load: 'rows:list' },
    ];
    const { router } = build(async () => ({ name: 'List' }), routes, async () => { await held; return 'rows'; });
    await router.isReady();
    const going = router.push('/list');
    await Promise.resolve();
    expect(router.isLoading.value).toBe(true);
    router.dispose();
    release();
    expect(isRouterError(await going, 'router:aborted:navigation')).toBe(true);
    expect(router.isLoading.value).toBe(false);
  });

  it('a popstate navigation cancelled by dispose walks no history back', async () => {
    const history = createMemoryHistory('/');
    const router = createRouter({ history, routes: ROWS, components: { Home: { name: 'Home' }, List: { name: 'List' } }, scroll: false });
    await router.isReady();
    await router.push('/list');
    const { held, release } = gate();
    router.beforeEach(async () => {
      await held;
      return true;
    });
    const go = vi.spyOn(history, 'go');
    history.go(-1); // the user presses Back; the guard holds the navigation to '/'
    go.mockClear();
    router.dispose();
    release();
    await new Promise((r) => setTimeout(r, 0));
    expect(go.mock.calls).toEqual([]);
    expect(history.location()).toBe('/');
  });
});
