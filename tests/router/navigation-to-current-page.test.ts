// @vitest-environment happy-dom
/** Asking for the page on screen while another navigation is pending supersedes it. The long note is at the end. */
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

/*
 * Router re-review, 1.26 (log 35.91). The duplicate check in `navigate()`
 * answered null for the page on screen and stopped there, leaving a navigation
 * still in flight to commit after it: on `/`, a click to a slow `/list` and
 * then a click on the link to `/` ended on `/list`, with `push('/')` having
 * answered null. vue-router supersedes there (its pending location moves to
 * the duplicate before the duplicate check, so the older navigation fails its
 * cancellation check).
 *
 * The pop side was the same bug behind a special case: `handlePop` dropped any
 * pop that landed on the committed page as "our own compensating go()". A
 * Forward back to the page during a held Back is such a pop, and the Back's
 * navigation then committed `/` with the address bar on `/list`.
 *
 * Now a duplicate supersedes the navigation in flight exactly as a newer
 * navigation does (pending id moved, its loaders aborted, its loading state
 * cleared), and every pop goes through `navigate()`. The router's own
 * compensating step after a refused Back lands on the committed page with
 * nothing in flight: a duplicate, answered null, as before
 * (tests/router/superseded-navigation-history.test.ts, its refusal control).
 * With nothing in flight a duplicate still changes nothing (the control here):
 * the committed navigation's controller is not aborted, so a loader's
 * background work tied to its signal is left alone.
 */
