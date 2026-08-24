/**
 * The no-`window` arms. Nearly every router test opts into happy-dom because
 * the router needs a DOM — which left the SSR shape (default `node`
 * environment, no window at all) unexercised. No docblock here on purpose.
 */
import { describe, expect, it } from 'vitest';
import { createRouter } from '../../src/router/index';
import type { RouteRecord } from '../../src/router/types';

const ROWS: RouteRecord[] = [
  { name: 'home', path: '/', component: 'Home' },
  { name: 'list', path: '/list', component: 'List' },
];

describe('createRouter without a window (SSR)', () => {
  it('falls back to memory history rooted at "/" when no history is passed', async () => {
    expect(typeof window).toBe('undefined'); // pin the precondition

    const router = createRouter({
      routes: ROWS,
      components: { Home: { name: 'Home' }, List: { name: 'List' } },
    });
    await router.isReady();

    // The `: '/'` arm — with no window there is no location to derive from.
    expect(router.currentRoute.value.location.fullPath).toBe('/');
    expect(router.currentRoute.value.location.name).toBe('home');

    // ...and it is a working router, not a stub.
    await router.push('/list');
    expect(router.currentRoute.value.location.name).toBe('list');
    router.destroy();
  });
});
