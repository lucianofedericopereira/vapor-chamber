// @vitest-environment happy-dom
/** router.destroy() while start() is still running leaves nothing behind. The long note is at the end. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory } from '@router/history';
import { createRouter } from '@router/index';
import { isRouterError } from '@router/errors';
import type { RouteRecord } from '@router/types';
import { ROWS } from './fixture';

const tick = () => new Promise((r) => setTimeout(r, 0));
const COMPONENTS = { Home: { name: 'Home' }, List: { name: 'List' } };

function gate() {
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  return { held, release };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('router.destroy() during start()', () => {
  it('while the remote table loads: no commit, no history listener, no link interception', async () => {
    const history = createMemoryHistory('/');
    const { held, release } = gate();
    const http = { get: vi.fn(async () => { await held; return { data: { routes: ROWS } }; }) };
    const router = createRouter({ history, routes: { url: '/routes' }, components: COMPONENTS, scroll: false, announce: false, http: http as never });
    const starting = router.start();
    router.destroy();
    release();
    await starting;

    expect(router.currentRoute.value.location.matched.length).toBe(0);
    // A history listener registered after the teardowns would navigate on this step.
    history.push('/list');
    history.go(-1);
    await tick();
    expect(router.currentRoute.value.location.matched.length).toBe(0);
    // A document click listener registered after the teardowns would intercept this link.
    const link = document.createElement('a');
    link.href = '/list';
    document.body.appendChild(link);
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(click);
    await tick();
    expect(click.defaultPrevented).toBe(false);
    expect(router.currentRoute.value.location.matched.length).toBe(0);
  });

  it('during the first navigation: the idle preheat is never armed', async () => {
    const routes: RouteRecord[] = [
      ...ROWS,
      { name: 'later', path: '/later', parent: 'shell', component: 'Later', meta: { preheat: true } },
    ];
    const later = vi.fn(async () => ({ name: 'Later' }));
    const router = createRouter({
      history: createMemoryHistory('/'),
      routes,
      components: { ...COMPONENTS, Later: later },
      scroll: false,
      announce: false,
    });
    const { held, release } = gate();
    router.beforeEach(async () => { await held; });
    const add = vi.spyOn(window, 'addEventListener');
    const starting = router.start();
    await tick();
    router.destroy();
    add.mockClear();
    release();
    await starting;
    expect(isRouterError(router.lastError.value)).toBe(false);
    // preheatIdle's first act is its abort listeners; none may appear after destroy().
    expect(add.mock.calls.map((call) => call[0])).not.toContain('pointerdown');
  });

  it('control: without destroy() the same start arms the idle preheat', async () => {
    const routes: RouteRecord[] = [
      ...ROWS,
      { name: 'later', path: '/later', parent: 'shell', component: 'Later', meta: { preheat: true } },
    ];
    const router = createRouter({
      history: createMemoryHistory('/'),
      routes,
      components: { ...COMPONENTS, Later: async () => ({ name: 'Later' }) },
      scroll: false,
      announce: false,
    });
    const add = vi.spyOn(window, 'addEventListener');
    await router.start();
    expect(add.mock.calls.map((call) => call[0])).toContain('pointerdown');
    router.destroy();
  });
});

/*
 * Router re-review, 1.26 (log 35.92). `destroy()` runs the teardowns start()
 * has registered so far and destroys the history. start() is async: with a
 * `{ url }` table it awaits the load, and it always awaits the first
 * navigation. A destroy() inside either wait left start() to carry on
 * afterwards. After the table load it registered a history listener, installed
 * the document click / hover listeners and the route announcer, and committed
 * the first navigation, all on a router nobody held: a link click navigated
 * it. After the first navigation (which destroy() does cancel, see
 * tests/router/destroy-cancels-navigation.test.ts) it armed the idle preheat,
 * whose window listeners no teardown would ever remove.
 *
 * start() now checks a `destroyed` flag at both points. The control shows the
 * preheat probe does see the listeners when nothing is destroyed, so the
 * second test's "none" is evidence.
 */
