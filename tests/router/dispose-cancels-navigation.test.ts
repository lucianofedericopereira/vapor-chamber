// @vitest-environment happy-dom
/** router.dispose() during a held navigation cancels it. The long note is at the end. */
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

/*
 * External item 1 of the 1.26 evaluation (log s35.41). `dispose()` ran the
 * teardowns and `history.dispose()` and nothing else, while the engine checks
 * only its own navigation id (`cancelled()`) between the awaits of a
 * navigation. A navigation held on a lazy component therefore carried on after
 * the router was disposed: it resolved null, wrote the history and replaced
 * the snapshot of a router nobody held any more.
 *
 * The fix reuses the path supersession already takes: the engine's `cancel()`
 * bumps the navigation id and aborts both lanes' controllers, so the held
 * navigation answers `cancelled` at its next check, exactly as when a newer
 * push supersedes it (the control). Superseding never had to clear the
 * loading flag, because the successor sets it; a dispose has no successor, so
 * `cancel()` clears it too. The third test pins that.
 */
