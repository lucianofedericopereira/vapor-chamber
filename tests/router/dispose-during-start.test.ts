// @vitest-environment happy-dom
/**
 * router.dispose() while start() is still awaiting its table load or first navigation leaves nothing behind.
 * Why: if start() carried on after dispose(), it would register history, click and hover listeners, commit the first navigation, or arm the idle preheat on a router nobody holds, with listeners no teardown removes.
 * Shows: disposing during a remote table load leaves no matched route and no history or document click interception; disposing during the first navigation adds no pointerdown listener (the control shows the same start does add one when not disposed).
 * See: log 35.92, tests/router/dispose-cancels-navigation.test.ts
 */
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

describe('router.dispose() during start()', () => {
  it('while the remote table loads: no commit, no history listener, no link interception', async () => {
    const history = createMemoryHistory('/');
    const { held, release } = gate();
    const http = { get: vi.fn(async () => { await held; return { data: { routes: ROWS } }; }) };
    const router = createRouter({ history, routes: { url: '/routes' }, components: COMPONENTS, scroll: false, announce: false, http: http as never });
    const starting = router.start();
    router.dispose();
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
    router.dispose();
    add.mockClear();
    release();
    await starting;
    expect(isRouterError(router.lastError.value)).toBe(false);
    // preheatIdle's first act is its abort listeners; none may appear after dispose().
    expect(add.mock.calls.map((call) => call[0])).not.toContain('pointerdown');
  });

  it('control: without dispose() the same start arms the idle preheat', async () => {
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
    router.dispose();
  });
});
