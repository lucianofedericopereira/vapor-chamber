// @vitest-environment happy-dom
/** A navigation the user supersedes leaves the history where the user put it. The long note is at the end. */
import { describe, expect, it, vi } from 'vitest';
import { createMemoryHistory } from '@router/history';
import { createRouter } from '@router/index';
import { isRouterError } from '@router/errors';
import { ROWS } from './fixture';

const tick = () => new Promise((r) => setTimeout(r, 0));

/** Three pages, a memory history, and a guard that holds the FIRST navigation after it is armed. */
async function threePages() {
  const history = createMemoryHistory('/');
  const router = createRouter({
    history,
    routes: [...ROWS, { name: 'other', path: '/other', parent: 'shell', component: 'Other' }],
    components: { Home: { name: 'Home' }, List: { name: 'List' }, Other: { name: 'Other' } },
    scroll: false,
    links: false,
    announce: false,
  });
  await router.isReady();
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const holdNext = () => {
    let first = true;
    router.beforeEach(async () => {
      if (first) {
        first = false;
        await held;
      }
    });
  };
  return { history, router, holdNext, release };
}

describe('a superseded navigation walks no history', () => {
  it('two quick Backs during a held navigation land on the second one', async () => {
    const { history, router, holdNext, release } = await threePages();
    await router.push('/list');
    await router.push('/other');
    holdNext();
    const go = vi.spyOn(history, 'go');
    history.go(-1); // Back: to /list, held by the guard
    history.go(-1); // Back again: to /
    release();
    for (let i = 0; i < 5; i++) await tick();
    expect(router.currentRoute.value.location.fullPath).toBe('/');
    expect(history.location()).toBe('/');
    // Only the user's two steps: the router walked nothing of its own.
    expect(go.mock.calls).toEqual([[-1], [-1]]);
    router.destroy();
  });

  it('a push that supersedes a held Back leaves no step of its own', async () => {
    const { history, router, holdNext, release } = await threePages();
    await router.push('/list');
    holdNext();
    const go = vi.spyOn(history, 'go');
    history.go(-1); // Back: to /, held
    const pushed = router.push('/other');
    release();
    await pushed;
    for (let i = 0; i < 5; i++) await tick();
    expect(go.mock.calls).toEqual([[-1]]);
    expect(router.currentRoute.value.location.fullPath).toBe('/other');
    expect(history.location()).toBe('/other');
    router.destroy();
  });

  it('control: a guard that refuses a Back still walks the history back', async () => {
    const { history, router } = await threePages();
    await router.push('/list');
    router.beforeEach(() => false);
    const go = vi.spyOn(history, 'go');
    history.go(-1);
    for (let i = 0; i < 5; i++) await tick();
    expect(go.mock.calls).toEqual([[-1], [1]]);
    expect(history.location()).toBe('/list');
    expect(router.currentRoute.value.location.fullPath).toBe('/list');
    router.destroy();
  });

  it('control: the superseded navigation still answers cancelled', async () => {
    const { router, holdNext, release } = await threePages();
    holdNext();
    const first = router.push('/list');
    const second = router.push('/other');
    release();
    expect(isRouterError(await first, 'router:aborted:navigation')).toBe(true);
    expect(await second).toBeNull();
    router.destroy();
  });
});

/*
 * Router re-review, 1.26 (log 35.90). A popstate navigation that failed walked
 * the history back by its own delta (`revert`), so the address bar returned to
 * the page still on screen. It did the same when it was CANCELLED, and a
 * cancelled navigation is one the user replaced with a newer one: the browser
 * is already where the newer one put it. Two quick Backs during a slow page
 * therefore ran: the first Back's navigation, cancelled, stepped forward one
 * entry; the router read that step as a third navigation, which cancelled the
 * second Back's and stepped forward again. The page ended on /list with the
 * address bar on /other, where the user had pressed Back twice from /other.
 *
 * Now a cancelled navigation returns `cancelled` and walks nothing; vue-router
 * does the same (its popstate handler skips `go(-delta)` for
 * NAVIGATION_CANCELLED). A refused one (a guard's `false`, an unmatched URL, a
 * failure) still walks back: the third test is that control. The second test
 * is the push case: a push from the entry the Back reached, so the entries
 * after it are dropped, as after any Back and click.
 *
 * `router.destroy()` cancelling a held Back walks no history either
 * (tests/router/destroy-cancels-navigation.test.ts), which before this needed a
 * `stopped` flag of its own; the cancelled path is now the reason, and the flag
 * is gone. That test is its pin.
 */
