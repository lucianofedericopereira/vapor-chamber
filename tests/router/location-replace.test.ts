/**
 * A location's own `replace: true` makes `push()` replace the current history entry, as `router.replace()` does.
 * Why: `RouteLocationRaw` declares `replace?: boolean`, and nothing read it: `push({ path, replace: true })` pushed, so Back landed on the page the app meant to replace, and a guard redirecting with `{ replace: true }` pushed too.
 * Shows: by path, by name and on the query-only path the history is replaced and Back lands before it; a guard's redirect with `replace: true` replaces; controls: `router.replace()` replaces, a location without `replace` pushes.
 * See: log 36.F58 (probe #13), src/router/types.ts RouteLocationRaw
 */
import { describe, expect, it, vi } from 'vitest';
import { createMemoryHistory } from '@router/history';
import { createRouter } from '@router/index';
import type { RouteRecord } from '@router/types';

const ROWS: RouteRecord[] = [
  { name: 'shell', path: '/', parent: null },
  { name: 'home', path: '/', parent: 'shell', component: 'Home' },
  { name: 'list', path: '/list', parent: 'shell', component: 'List' },
  { name: 'other', path: '/other', parent: 'shell', component: 'Other' },
];

/** A started router on `/`, with the history's push and replace counted from here on. */
async function started() {
  const history = createMemoryHistory('/');
  const router = createRouter({
    history,
    routes: ROWS,
    components: { Home: { name: 'Home' }, List: { name: 'List' }, Other: { name: 'Other' } },
    scroll: false,
    links: false,
    announce: false,
  });
  await router.isReady();
  const push = vi.spyOn(history, 'push');
  const replace = vi.spyOn(history, 'replace');
  return { history, router, push, replace };
}

describe('RouteLocationRaw.replace', () => {
  it('control: router.replace() replaces the entry', async () => {
    const { router, push, replace } = await started();
    expect(await router.push('/other')).toBeNull();
    expect(await router.replace('/list')).toBeNull();
    expect([push.mock.calls.length, replace.mock.calls.length]).toEqual([1, 1]);
    router.dispose();
  });

  it('control: a location without replace pushes', async () => {
    const { router, push, replace } = await started();
    expect(await router.push({ path: '/list' })).toBeNull();
    expect([push.mock.calls.length, replace.mock.calls.length]).toEqual([1, 0]);
    router.dispose();
  });

  it('push({ path, replace: true }) replaces, so the entry before it is what Back finds', async () => {
    const { history, router, push, replace } = await started();
    expect(await router.push('/other')).toBeNull();
    expect(await router.push({ path: '/list', replace: true })).toBeNull();
    expect(router.currentRoute.value.location.fullPath).toBe('/list');
    expect([push.mock.calls.length, replace.mock.calls.length]).toEqual([1, 1]);
    // The memory history's own stack: /other was replaced, so one step back is /.
    history.go(-1);
    expect(history.location()).toBe('/');
    router.dispose();
  });

  it('push({ name, replace: true }) replaces', async () => {
    const { router, push, replace } = await started();
    expect(await router.push({ name: 'list', replace: true })).toBeNull();
    expect([push.mock.calls.length, replace.mock.calls.length]).toEqual([0, 1]);
    router.dispose();
  });

  it('a query-only push with replace: true replaces', async () => {
    const { router, push, replace } = await started();
    expect(await router.push('/list')).toBeNull();
    expect(await router.push({ path: '/list', query: { page: '2' }, replace: true })).toBeNull();
    expect(router.currentRoute.value.location.fullPath).toBe('/list?page=2');
    expect([push.mock.calls.length, replace.mock.calls.length]).toEqual([1, 1]);
    router.dispose();
  });

  it("a guard's redirect with replace: true replaces the entry the push would have added", async () => {
    const { router, push, replace } = await started();
    router.beforeEach((to) => (to.path === '/other' ? { path: '/list', replace: true } : undefined));
    expect(await router.push('/other')).toBeNull();
    expect(router.currentRoute.value.location.fullPath).toBe('/list');
    expect([push.mock.calls.length, replace.mock.calls.length]).toEqual([0, 1]);
    router.dispose();
  });
});
