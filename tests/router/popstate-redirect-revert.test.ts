/**
 * A Back or Forward whose guard redirects, and whose redirect then fails, walks the address bar back to the page on screen.
 * Why: only the popstate frame holds the history delta, so a failed redirect would leave the address bar on the entry Back moved to while the page stays on the one before it.
 * Shows: when the redirect is refused by a guard, matches no route, leads back to the page on screen or fails its component, history ends on the page on screen; a refused Back walks back and a redirect that commits stays put.
 * See: log 36.13
 */
import { describe, expect, it, vi } from 'vitest';
import { createMemoryHistory } from '@router/history';
import { isRouterError } from '@router/errors';
import type { RouteRecord } from '@router/types';
import { makeRouter } from './fixture';

const ROUTES: RouteRecord[] = [
  { name: 'home', path: '/', component: 'Home' },
  { name: 'a', path: '/a', component: 'Home' },
  { name: 'b', path: '/b', component: 'Home' },
  { name: 'broken', path: '/broken', component: 'Broken' },
];

/** On /b after /a, with `guard` installed: Back to /a, then the address bar and the page. */
async function backFromB(guard: (to: { path: string }) => boolean | string) {
  const history = createMemoryHistory('/');
  const onError = vi.fn();
  const router = makeRouter({
    history,
    routes: ROUTES,
    components: { Home: { name: 'Home' }, Broken: () => Promise.reject(new Error('chunk 404')) },
    onError,
  });
  await router.isReady();
  await router.push('/a');
  await router.push('/b');
  router.beforeEach(guard);
  history.go(-1);
  await vi.waitFor(() => expect(history.location()).toBe('/b'));
  const page = router.currentRoute.value.location.path;
  router.dispose();
  return { url: history.location(), page, onError };
}

describe('a Back whose guard redirects', () => {
  it('to a page another guard refuses: the address bar returns to the page on screen', async () => {
    const r = await backFromB((to) => (to.path === '/a' ? '/' : to.path !== '/'));
    expect([r.url, r.page]).toEqual(['/b', '/b']);
  });

  it('to a path no route matches: the address bar returns to the page on screen', async () => {
    const r = await backFromB((to) => (to.path === '/a' ? '/nowhere' : true));
    expect([r.url, r.page]).toEqual(['/b', '/b']);
    expect(isRouterError(r.onError.mock.calls[0][0], 'router:missing:route')).toBe(true);
  });

  it('to the page on screen: the address bar returns to it', async () => {
    const r = await backFromB((to) => (to.path === '/a' ? '/b' : true));
    expect([r.url, r.page]).toEqual(['/b', '/b']);
  });

  it('to a page whose component fails: the address bar returns to the page on screen', async () => {
    const r = await backFromB((to) => (to.path === '/a' ? '/broken' : true));
    expect([r.url, r.page]).toEqual(['/b', '/b']);
    expect(isRouterError(r.onError.mock.calls[0][0], 'router:failed:component')).toBe(true);
  });
});

describe('control', () => {
  it('a Back the guard refuses outright walks back, as released', async () => {
    const r = await backFromB((to) => to.path !== '/a');
    expect([r.url, r.page]).toEqual(['/b', '/b']);
  });

  it('a Back whose redirect commits stays where the redirect put it', async () => {
    const history = createMemoryHistory('/');
    const router = makeRouter({ history, routes: ROUTES, components: { Home: { name: 'Home' } } });
    await router.isReady();
    await router.push('/a');
    await router.push('/b');
    router.beforeEach((to) => (to.path === '/a' ? '/' : true));
    history.go(-1);
    await vi.waitFor(() => expect(router.currentRoute.value.location.path).toBe('/'));
    expect(history.location()).toBe('/');
    router.dispose();
  });
});
