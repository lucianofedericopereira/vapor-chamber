/**
 * createRouter in the default `node` environment, where there is no `window`.
 * Why: a router that needed `window` would throw during server-side rendering instead of starting on a memory history. Also the only file reaching the no-window start path, so the 100% floor needs it.
 * Shows: with no history passed and no window, the router starts at `/` on home and still navigates to `/list`.
 */
import { describe, expect, it } from 'vitest';
import { createRouter } from '@router/index';
import type { RouteRecord } from '@router/types';

const ROWS: RouteRecord[] = [
  { name: 'home', path: '/', component: 'Home' },
  { name: 'list', path: '/list', component: 'List' },
];

describe('createRouter without a window (SSR)', () => {
  it('falls back to memory history rooted at "/" when no history is passed', async () => {
    expect(typeof window).toBe('undefined');

    const router = createRouter({
      routes: ROWS,
      components: { Home: { name: 'Home' }, List: { name: 'List' } },
    });
    await router.isReady();

    // With no window there is no location to derive a start from.
    expect(router.currentRoute.value.location.fullPath).toBe('/');
    expect(router.currentRoute.value.location.name).toBe('home');

    await router.push('/list');
    expect(router.currentRoute.value.location.name).toBe('list');
    router.dispose();
  });
});
