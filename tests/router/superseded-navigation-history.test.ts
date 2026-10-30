// @vitest-environment happy-dom
/**
 * A navigation the user supersedes walks no history of its own, so the history stays where the user put it.
 * Why: if a cancelled popstate navigation stepped the history back by its delta, two quick Backs during a slow page would end on the wrong page with the address bar on another; a refused one must still roll back.
 * Shows: two quick Backs land on the second target with only the user's two `go(-1)` calls; a push that supersedes a held Back adds no step and lands on the push target; a guard that refuses a Back still calls `go(-1)` then `go(1)`; the superseded navigation answers router:aborted:navigation.
 * See: log s35.90, dispose-cancels-navigation.test.ts
 */
import { describe, expect, it, vi } from 'vitest';
import { createMemoryHistory } from '@router/history';
import { createRouter } from '@router/index';
import { isRouterError } from '@router/errors';
import { ROWS } from './fixture';

const tick = () => new Promise((r) => setTimeout(r, 0));

/** Three pages, a memory history, and `holdNext()` to arm a guard that holds the first navigation after it. */
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
    router.dispose();
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
    router.dispose();
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
    router.dispose();
  });

  it('control: the superseded navigation still answers cancelled', async () => {
    const { router, holdNext, release } = await threePages();
    holdNext();
    const first = router.push('/list');
    const second = router.push('/other');
    release();
    expect(isRouterError(await first, 'router:aborted:navigation')).toBe(true);
    expect(await second).toBeNull();
    router.dispose();
  });
});
