/** A query change while a page navigation is pending: the query wins, the navigation is superseded and told. Log s35.120. */
import { describe, expect, it } from 'vitest';
import { createMemoryHistory } from '@router/history';
import { isRouterError } from '@router/errors';
import { makeRouter } from './fixture';

function held() {
  let release!: () => void;
  const gate = new Promise<boolean>((r) => { release = () => r(true); });
  const history = createMemoryHistory('/');
  const router = makeRouter({ history, links: false, announce: false });
  router.beforeEach((to) => (to.path === '/list' ? gate : true));
  return { router, history, release };
}

describe('a query change during a pending page navigation', () => {
  it('setQuery: the query commits on the page on screen; the push answers aborted:navigation', async () => {
    const { router, history, release } = held();
    await router.isReady();
    const going = router.push('/list');
    await Promise.resolve();
    router.setQuery({ q: 'x' });
    release();
    expect(isRouterError(await going, 'router:aborted:navigation')).toBe(true);
    expect(router.currentRoute.value.location.fullPath).toBe('/?q=x');
    expect(history.location()).toBe('/?q=x');
    router.destroy();
  });

  it('a query-only push takes the same path', async () => {
    const { router, history, release } = held();
    await router.isReady();
    const going = router.push('/list');
    await Promise.resolve();
    await router.push('/?q=y');
    release();
    expect(isRouterError(await going, 'router:aborted:navigation')).toBe(true);
    expect(router.currentRoute.value.location.fullPath).toBe('/?q=y');
    expect(history.location()).toBe('/?q=y');
    router.destroy();
  });

  it('control: with nothing pending, a query change does not touch the next navigation', async () => {
    const { router, release } = held();
    await router.isReady();
    router.setQuery({ q: 'x' });
    release();
    expect(await router.push('/list')).toBeNull();
    expect(router.currentRoute.value.location.path).toBe('/list');
    router.destroy();
  });
});
