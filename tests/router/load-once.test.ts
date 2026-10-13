// @vitest-environment happy-dom
// A page's loader runs once while its code is loading, whoever asked for it first. The long note is at the end.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isRouterError } from '@router/errors';
import { stubGlobal } from '../../src/vitest-pure';
import { makeRouter, ROWS } from './fixture';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A loader whose loads settle only when the test says so. */
function held() {
  const releases: Array<(v: unknown) => void> = [];
  const rejects: Array<(e: unknown) => void> = [];
  const loader = vi.fn(
    () =>
      new Promise((resolve, reject) => {
        releases.push(resolve);
        rejects.push(reject);
      }),
  );
  return {
    loader,
    release: (v: unknown) => {
      for (const r of releases) r(v);
    },
    reject: (e: unknown) => {
      for (const r of rejects) r(e);
    },
  };
}

function link(): HTMLAnchorElement {
  document.body.innerHTML = '<a id="to-list" href="/list">list</a>';
  return document.getElementById('to-list') as HTMLAnchorElement;
}

const hover = (a: Element) => a.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));

/** A real click through the router's document listener. The window then cancels happy-dom's own link navigation. */
function click(a: Element): void {
  window.addEventListener('click', (e) => e.preventDefault(), { once: true });
  a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('a lazy page loads once', () => {
  it('a click while the hover warm-up is loading the page', async () => {
    const { loader, release } = held();
    const router = makeRouter({ components: { Home: { name: 'Home' }, List: loader } });
    try {
      await router.isReady();
      const a = link();
      hover(a);
      await sleep(150);
      expect(loader).toHaveBeenCalledTimes(1); // the warm-up's load is in flight
      click(a);
      await sleep(10);
      expect(loader).toHaveBeenCalledTimes(1);
      release({ name: 'List' });
      await vi.waitFor(() => expect(router.currentRoute.value.location.name).toBe('list'));
    } finally {
      router.dispose();
    }
  });

  it('a click inside the hover delay: the warm-up fires while the page loads', async () => {
    const { loader, release } = held();
    const router = makeRouter({ components: { Home: { name: 'Home' }, List: loader } });
    try {
      await router.isReady();
      const a = link();
      hover(a);
      await sleep(20);
      click(a);
      await sleep(150);
      expect(loader).toHaveBeenCalledTimes(1);
      release({ name: 'List' });
      await vi.waitFor(() => expect(router.currentRoute.value.location.name).toBe('list'));
    } finally {
      router.dispose();
    }
  });

  it('two navigations to the page while it loads', async () => {
    const { loader, release } = held();
    const router = makeRouter({ components: { Home: { name: 'Home' }, List: loader } });
    try {
      await router.isReady();
      const first = router.push('/list');
      await sleep(5);
      const second = router.push('/list?x=1');
      await sleep(5);
      expect(loader).toHaveBeenCalledTimes(1);
      release({ name: 'List' });
      await Promise.all([first, second]);
      expect(router.currentRoute.value.location.fullPath).toBe('/list?x=1');
    } finally {
      router.dispose();
    }
  });

  it('a navigation while the idle warm-up is loading the page', async () => {
    Object.defineProperty(document, 'readyState', { value: 'complete', configurable: true });
    using _requestIdleCallback = stubGlobal('requestIdleCallback', (cb: () => void) => { cb(); });
    const { loader, release } = held();
    const router = makeRouter({
      routes: [...ROWS, { name: 'heavy', path: '/heavy', parent: 'shell', component: 'Heavy', meta: { preheat: true } }],
      components: { Home: { name: 'Home' }, List: { name: 'List' }, Heavy: loader },
    });
    try {
      await router.isReady();
      await sleep(0);
      expect(loader).toHaveBeenCalledTimes(1); // the idle warm-up's load is in flight
      const going = router.push('/heavy');
      await sleep(10);
      expect(loader).toHaveBeenCalledTimes(1);
      release({ name: 'Heavy' });
      expect(await going).toBeNull();
    } finally {
      router.dispose();
    }
  });
});

describe('what a shared load keeps', () => {
  it("a failed load joined by a click reports the click's page, not the page on screen", async () => {
    const { loader, reject } = held();
    const onError = vi.fn();
    const router = makeRouter({ onError, components: { Home: { name: 'Home' }, List: loader } });
    try {
      await router.isReady();
      const a = link();
      hover(a);
      await sleep(150);
      expect(loader).toHaveBeenCalledTimes(1); // the warm-up started the load, so the click joins it
      click(a);
      await sleep(10);
      reject(new Error('Failed to fetch dynamically imported module'));
      await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
      const [error] = onError.mock.calls[0]!;
      expect(isRouterError(error, 'router:failed:component')).toBe(true);
      expect((error as { context: { to: { fullPath: string } } }).context.to.fullPath).toBe('/list');
    } finally {
      router.dispose();
    }
  });

  it('a failed warm-up is loaded again by the next navigation', async () => {
    let n = 0;
    const loader = vi.fn(async () => {
      n++;
      if (n === 1) throw new Error('Failed to fetch dynamically imported module');
      return { name: 'List' };
    });
    const router = makeRouter({ components: { Home: { name: 'Home' }, List: loader } });
    try {
      await router.isReady();
      hover(link());
      await vi.waitFor(() => expect(loader).toHaveBeenCalledTimes(1));
      await sleep(0);
      expect(await router.push('/list')).toBeNull();
      expect(loader).toHaveBeenCalledTimes(2);
    } finally {
      router.dispose();
    }
  });
});

// The note.
//
// Log 36.19 item 1. A lazy component was cached only once its load resolved,
// and nothing recorded a load in flight. So a second caller while the first
// load ran called the app's loader again: a click during a hover or idle
// warm-up, or two navigations to the page. Now the promise the app's loader
// returned is shared, by component key, until it settles.
//
// Red before: the first four tests, each read 2 loader calls for 1.
// Pins, green before and after. A failed shared load reports each caller's own
// target in `context.to`: sharing loadComponent's own promise instead would
// report the warm-up's target, the page on screen. That shape was seeded once
// and turned the first pin red. The pin waits past the hover delay and checks
// the warm-up started the load: a click inside the delay creates the load
// itself, and then every shape answers its own page. A failed load leaves the
// map, so the next navigation calls the loader again.
