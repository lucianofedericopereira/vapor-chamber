/**
 * The smallest real router the router tests need: two pages under one shell,
 * a memory history at the router's `base`, no scrolling. Shared so a test
 * states only what it is about (its options), not the setup it runs on: a test
 * with its own table passes `routes`, one under a base passes `base` and gets
 * the history there.
 */
import { createMemoryHistory } from '../../src/router/history';
import { createRouter, type RouterOptions } from '../../src/router/index';
import type { RouteRecord } from '../../src/router/types';

export const ROWS: RouteRecord[] = [
  { name: 'shell', path: '/', parent: null },
  { name: 'home', path: '/', parent: 'shell', component: 'Home' },
  { name: 'list', path: '/list', parent: 'shell', component: 'List' },
];

export function makeRouter(opts: Partial<RouterOptions> = {}) {
  return createRouter({
    history: createMemoryHistory(typeof opts.base === 'string' ? opts.base : '/'),
    routes: ROWS,
    components: { Home: { name: 'Home' }, List: { name: 'List' } },
    scroll: false,
    ...opts,
  });
}

/**
 * Until an announcement is heard: the router reads the new page one frame
 * after the commit (after the render), and the shared live region (src/a11y.ts)
 * sets the text one frame after clearing it. Two frames.
 */
export const frame = () =>
  new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
