// @vitest-environment happy-dom
/**
 * Scroll on commit and on back/forward, inline routes payload errors, idle preheat teardown, and resolve() before the table is ready.
 * Why: a hash link would land on the top instead of its anchor, a hash that is not a valid CSS selector (`#2024`) would break navigation itself, back/forward would fight the browser's own scroll restoration, and links would render no href while a remote table loads. Also the only file reaching the hash-anchor scroll and the no-DOM inline rejection, so the 100% floor needs it.
 * Shows: a matching anchor is scrolled into view and the top is not; a missing anchor or an invalid selector falls back to the top; scroll:false never scrolls; an inline JSON table loads, and a missing DOM or element rejects with a message; arming and disposing preheat does not throw; resolve() degrades to the raw string or `path`; a popstate does not scroll.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWebHistory } from '@router/history';
import { createRouter } from '@router/index';
import type { RouteRecord } from '@router/types';
import { stubGlobal } from '../../src/vitest-pure';
import { makeRouter, ROWS } from './fixture';



afterEach(() => {
  document.body.innerHTML = '';
});

describe('scroll on commit', () => {
  it('scrolls a matching hash anchor into view instead of the top', async () => {
    const anchor = document.createElement('div');
    anchor.id = 'section';
    const scrollIntoView = vi.fn();
    (anchor as unknown as { scrollIntoView: () => void }).scrollIntoView = scrollIntoView;
    document.body.appendChild(anchor);
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});

    const router = makeRouter({ scroll: true });
    await router.isReady();
    // The initial commit scrolls to the top; clear it so the assertion is about the push.
    scrollTo.mockClear();
    await router.push('/list#section');

    expect(scrollIntoView).toHaveBeenCalled();
    // A hit must not also jump to the top.
    expect(scrollTo).not.toHaveBeenCalled();
    router.dispose();
  });

  it('falls back to the top when the hash matches nothing', async () => {
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    const router = makeRouter({ scroll: true });
    await router.isReady();
    await router.push('/list#nothing-here');

    expect(scrollTo).toHaveBeenCalled();
    router.dispose();
  });

  it('survives a hash that is not a valid CSS selector', async () => {
    // `#2024` is a legal fragment and an illegal selector: querySelector throws.
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    const router = makeRouter({ scroll: true });
    await router.isReady();

    await expect(router.push('/list#2024')).resolves.toBeNull();
    expect(scrollTo).toHaveBeenCalled(); // fell through to the top-scroll
    router.dispose();
  });

  it('does nothing at all when scroll is disabled', async () => {
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    const router = makeRouter({ scroll: false });
    await router.isReady();
    await router.push('/list');

    expect(scrollTo).not.toHaveBeenCalled();
    router.dispose();
  });
});

describe('inline routes payload', () => {
  it('builds the table from a JSON script element', async () => {
    // Read synchronously in the constructor: `base` must be known before the history is built.
    const el = document.createElement('script');
    el.type = 'application/json';
    el.id = 'vcr-routes';
    el.textContent = JSON.stringify({ routes: ROWS });
    document.body.appendChild(el);

    const router = makeRouter({
      routes: { inline: '#vcr-routes' } as never,
    });
    await router.isReady();

    expect(await router.push('/list')).toBeNull();
    expect(router.currentRoute.value.location.path).toBe('/list');
    router.dispose();
  });

  it('reports a missing DOM rather than crashing on `document`', async () => {
    // Inline routes need a DOM: an SSR render must get a message, not a ReferenceError.
    using _document = stubGlobal('document', undefined);
    const router = makeRouter({
      routes: { inline: '#routes' } as never,
      components: {},
    });
    await expect(router.isReady()).rejects.toThrow(/inline routes need a DOM/);
    router.dispose();
  });

  it('surfaces router:missing:inline at start(), not at construction', async () => {
    // The constructor's read swallows a missing element (it only needs `base`); loadInlineTable at start() reports it.
    const router = makeRouter({
      routes: { inline: '#not-present' } as never,
      components: {},
    });
    await expect(router.isReady()).rejects.toThrow(/no inline routes element/);
    router.dispose();
  });
});

describe('idle preheat', () => {
  it('arms for records flagged meta.preheat and tears down cleanly', async () => {
    // preheatIdle() only engages when a flagged record is still uncached.
    const loaded: string[] = [];
    const router = makeRouter({
      routes: [
        { name: 'shell', path: '/', parent: null },
        { name: 'home', path: '/', parent: 'shell', component: 'Home' },
        { name: 'heavy', path: '/heavy', parent: 'shell', component: 'Heavy', meta: { preheat: true } },
      ] as RouteRecord[],
      components: {
        Home: { name: 'Home' },
        Heavy: async () => {
          loaded.push('Heavy');
          return { name: 'Heavy' };
        },
      },
    });

    await router.isReady();
    // When the idle callback fires is the browser's call; asserting it would be flaky.
    expect(() => router.dispose()).not.toThrow();
  });
});

describe('resolve() before the table is ready', () => {
  it('degrades to the raw string when the location cannot be resolved', () => {
    // No isReady() on purpose: links render before a remote table has loaded.
    const router = makeRouter({ scroll: true });
    expect(router.resolve('/definitely-not-a-route')).toContain('/definitely-not-a-route');
    router.dispose();
  });

  it('degrades to `path` for the object form, and to / when it has none', () => {
    const router = makeRouter({ scroll: true });
    expect(router.resolve({ path: '/raw-object' } as never)).toContain('/raw-object');
    expect(router.resolve({ name: 'nope' } as never)).toContain('/');
    router.dispose();
  });
});

describe('scroll restoration on back/forward', () => {
  it('does NOT scroll to top on a popstate navigation', () => {
    // On back/forward the browser restores scroll itself; scrolling to top would fight it.
    window.history.replaceState({ __vr: 0 }, '', '/');
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});

    const router = createRouter({
      history: createWebHistory(''),
      routes: [
        { name: 'home', path: '/', component: 'Home' },
        { name: 'list', path: '/list', component: 'List' },
      ],
      components: { Home: { name: 'Home' }, List: { name: 'List' } },
    });

    return router.isReady().then(async () => {
      await router.push('/list');
      expect(scrollTo).toHaveBeenCalled(); // ordinary navigation scrolls
      scrollTo.mockClear();

      // Drive a real popstate through the router's own history listener.
      window.history.replaceState({ __vr: 0 }, '', '/');
      window.dispatchEvent(new PopStateEvent('popstate', { state: { __vr: 0 } }));
      await new Promise((r) => setTimeout(r, 0));

      expect(router.currentRoute.value.location.path).toBe('/');
      expect(scrollTo).not.toHaveBeenCalled(); // back/forward leaves scroll alone
      scrollTo.mockRestore();
      router.dispose();
    });
  });
});
