// @vitest-environment happy-dom
/**
 * Two router behaviours that had no coverage, both of the kind that only shows
 * up in a browser and therefore never in a unit test written against the
 * engine: scroll restoration on commit, and `resolve()` degrading gracefully
 * before the route table exists.
 *
 * Neither is defensive filler. Scroll-on-commit is what makes a hash link land
 * on its anchor instead of the top of the page, and its `catch` exists because
 * a location hash is user-controlled text that is NOT guaranteed to be a valid
 * CSS selector — `#2024` throws in `querySelector`. `resolve()`'s fallback is
 * what keeps `<RouterLink :to>` rendering an href during the window before
 * `start()` has loaded a remote table, which is exactly when a server-rendered
 * page is being hydrated.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory } from '../../src/router/history';
import { createRouter } from '../../src/router/index';
import type { RouteRecord } from '../../src/router/types';

const ROWS: RouteRecord[] = [
  { name: 'shell', path: '/', parent: null },
  { name: 'home', path: '/', parent: 'shell', component: 'Home' },
  { name: 'list', path: '/list', parent: 'shell', component: 'List' },
];

function makeRouter(opts: Record<string, unknown> = {}) {
  return createRouter({
    history: createMemoryHistory('/'),
    routes: ROWS,
    components: { Home: { name: 'Home' }, List: { name: 'List' } },
    ...opts,
  });
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('scroll on commit', () => {
  it('scrolls a matching hash anchor into view instead of the top', async () => {
    const anchor = document.createElement('div');
    anchor.id = 'section';
    const scrollIntoView = vi.fn();
    (anchor as unknown as { scrollIntoView: () => void }).scrollIntoView = scrollIntoView;
    document.body.appendChild(anchor);
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});

    const router = makeRouter();
    await router.isReady();
    // start() commits the initial route, which legitimately scrolls to the top
    // (no hash). Clear that first so the assertion below is about the push.
    scrollTo.mockClear();
    await router.push('/list#section');

    expect(scrollIntoView).toHaveBeenCalled();
    // The early `return` after a hit is the point — landing on the anchor and
    // ALSO jumping to the top would put the user somewhere they did not ask for.
    expect(scrollTo).not.toHaveBeenCalled();
    router.destroy();
  });

  it('falls back to the top when the hash matches nothing', async () => {
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    const router = makeRouter();
    await router.isReady();
    await router.push('/list#nothing-here');

    expect(scrollTo).toHaveBeenCalled();
    router.destroy();
  });

  it('survives a hash that is not a valid CSS selector', async () => {
    // `#2024` is a legal URL fragment and an illegal selector — querySelector
    // throws. Without the catch, any such link would break navigation itself,
    // not merely fail to scroll.
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    const router = makeRouter();
    await router.isReady();

    await expect(router.push('/list#2024')).resolves.toBeNull();
    expect(scrollTo).toHaveBeenCalled(); // fell through to the top-scroll
    router.destroy();
  });

  it('does nothing at all when scroll is disabled', async () => {
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    const router = makeRouter({ scroll: false });
    await router.isReady();
    await router.push('/list');

    expect(scrollTo).not.toHaveBeenCalled();
    router.destroy();
  });
});

describe('inline routes payload', () => {
  it('builds the table from a JSON script element', async () => {
    // The shape `examples/router-demo` ships: routes embedded in the page as
    // `<script type="application/json">`, read synchronously in the
    // constructor because `base` must be known before the history is built.
    const el = document.createElement('script');
    el.type = 'application/json';
    el.id = 'vcr-routes';
    el.textContent = JSON.stringify({ routes: ROWS });
    document.body.appendChild(el);

    const router = createRouter({
      history: createMemoryHistory('/'),
      routes: { inline: '#vcr-routes' } as never,
      components: { Home: { name: 'Home' }, List: { name: 'List' } },
    });
    await router.isReady();

    expect(await router.push('/list')).toBeNull();
    expect(router.currentRoute.value.location.path).toBe('/list');
    router.destroy();
  });

  it('reports a missing DOM rather than crashing on `document`', async () => {
    // Inline routes are the one routes source that cannot work without a DOM,
    // so an SSR render that reaches it must say why. Without the guard this is
    // a ReferenceError from deep inside the constructor.
    vi.stubGlobal('document', undefined);
    const router = createRouter({
      history: createMemoryHistory('/'),
      routes: { inline: '#routes' } as never,
      components: {},
    });
    await expect(router.isReady()).rejects.toThrow(/inline routes need a DOM/);
    router.destroy();
    vi.unstubAllGlobals();
  });

  it('surfaces inline_routes_missing at start(), not at construction', async () => {
    // Two different readers touch the same selector, and only one throws.
    // The constructor calls `readInlinePayload`, which swallows and returns
    // null — it runs only to learn `base` before the history is built, and a
    // missing element there is not yet fatal. `loadInlineTable` at start() is
    // where the absence actually matters, so that is where it reports.
    const router = createRouter({
      history: createMemoryHistory('/'),
      routes: { inline: '#not-present' } as never,
      components: {},
    });
    await expect(router.isReady()).rejects.toThrow(/no inline routes element/);
    router.destroy();
  });
});

describe('idle preheat', () => {
  it('arms for records flagged meta.preheat and tears down cleanly', async () => {
    // preheatIdle() only engages when at least one flagged record is still
    // uncached; with none flagged the whole path is skipped, which is what the
    // existing tests exercised.
    const loaded: string[] = [];
    const router = createRouter({
      history: createMemoryHistory('/'),
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
    // No assertion on WHEN the idle callback fires — that is the browser's
    // call and racing it would make this flaky. What matters is that arming
    // and tearing down the idle queue is exercised and does not throw.
    expect(() => router.destroy()).not.toThrow();
  });
});

describe('resolve() before the table is ready', () => {
  it('degrades to the raw string when the location cannot be resolved', () => {
    // No isReady() on purpose: a remote-table router renders links during the
    // window before start() resolves, and an href of `undefined` there is a
    // broken page.
    const router = makeRouter();
    expect(router.resolve('/definitely-not-a-route')).toContain('/definitely-not-a-route');
    router.destroy();
  });

  it('degrades to `path` for the object form, and to / when it has none', () => {
    const router = makeRouter();
    expect(router.resolve({ path: '/raw-object' } as never)).toContain('/raw-object');
    expect(router.resolve({ name: 'nope' } as never)).toContain('/');
    router.destroy();
  });
});
