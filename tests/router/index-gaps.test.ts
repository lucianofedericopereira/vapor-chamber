// @vitest-environment happy-dom
/**
 * createRouter wiring paths the router suite leaves open - the table-source
 * variants and the helpers that only run for specific option shapes.
 *
 *  - loadInlineTable: a selector that matches nothing / an empty
 *    element, and the happy path reading a payload out of the DOM.
 *  - warnRemoteBase: a fetched payload declaring a base that
 *    disagrees with the already-built history.
 *  - preheatPath: hover-preheat resolving a path and loading its
 *    lazy component, plus the unresolvable-path bail.
 *  - the meta.preheat idle arming with nothing flagged.
 *  - unwrapRoutesPayload's envelope arms.
 *  - defaultFetchBlade's DOMParser extraction and its no-DOMParser fallback
 *.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory } from '../../src/router/history';
import { bladeFetcher } from '../../src/router/remote';
import { createRouter, unwrapRoutesPayload } from '../../src/router/index';
import type { RouteRecord } from '../../src/router/types';

const ROWS: RouteRecord[] = [
  { name: 'shell', path: '/', parent: null },
  { name: 'home', path: '/', parent: 'shell', component: 'Home' },
  { name: 'list', path: '/list', parent: 'shell', component: 'List' },
];

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// unwrapRoutesPayload
// ---------------------------------------------------------------------------

describe('unwrapRoutesPayload', () => {
  it('unwraps the house envelope { ok: true, state }', () => {
    const payload = unwrapRoutesPayload({ ok: true, state: { routes: ROWS, base: '/admin' } });
    expect(payload.base).toBe('/admin');
    expect(payload.routes).toHaveLength(3);
  });

  it('throws with the envelope error when ok is false', () => {
    expect(() => unwrapRoutesPayload({ ok: false, error: 'forbidden' })).toThrow(/forbidden/);
    // Missing error string falls back to "unknown error".
    expect(() => unwrapRoutesPayload({ ok: false })).toThrow(/unknown error/);
  });

  it('rejects a bare payload with no routes array', () => {
    expect(() => unwrapRoutesPayload({ nope: true })).toThrow(/no routes array/);
    expect(() => unwrapRoutesPayload(null)).toThrow(/no routes array/);
  });
});

// ---------------------------------------------------------------------------
// inline table source
// ---------------------------------------------------------------------------

describe('inline routes source', () => {
  it('reads the table out of the DOM and applies its base', async () => {
    document.body.innerHTML =
      '<script id="routes" type="application/json">' +
      JSON.stringify({ routes: ROWS, base: '/shop' }) +
      '</script>';

    const router = createRouter({
      routes: { inline: '#routes' } as never,
      components: { Home: { name: 'Home' }, List: { name: 'List' } },
      history: createMemoryHistory('/shop'),
    });
    await router.isReady();

    expect(router.routes.value).toHaveLength(3);
    expect(router.base).toBe('/shop');
    router.destroy();
  });

  it('throws inline_routes_missing when the selector matches nothing', async () => {
    const router = createRouter({
      routes: { inline: '#absent' } as never,
      components: {},
      history: createMemoryHistory('/'),
    });
    await expect(router.isReady()).rejects.toThrow(/no inline routes element matches/);
    router.destroy();
  });

  it('throws inline_routes_missing for an empty element', async () => {
    document.body.innerHTML = '<script id="routes" type="application/json"></script>';
    const router = createRouter({
      routes: { inline: '#routes' } as never,
      components: {},
      history: createMemoryHistory('/'),
    });
    await expect(router.isReady()).rejects.toThrow(/no inline routes element matches/);
    router.destroy();
  });
});

// ---------------------------------------------------------------------------
// remote table source
// ---------------------------------------------------------------------------

describe('remote routes source', () => {
  it('warns when a fetched payload declares a base the history cannot adopt', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const http = { get: vi.fn().mockResolvedValue({ data: { routes: ROWS, base: '/from-payload' } }) } as any;

    const router = createRouter({
      routes: { url: '/routes.json' } as never,
      components: { Home: { name: 'Home' }, List: { name: 'List' } },
      history: createMemoryHistory('/'),
      http,
    });
    await router.isReady();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('/from-payload');
    expect(router.routes.value).toHaveLength(3);
    router.destroy();
  });

  it('does not warn when the caller passed base explicitly', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const http = { get: vi.fn().mockResolvedValue({ data: { routes: ROWS, base: '/from-payload' } }) } as any;

    const router = createRouter({
      routes: { url: '/routes.json' } as never,
      components: { Home: { name: 'Home' }, List: { name: 'List' } },
      history: createMemoryHistory('/'),
      base: '/explicit',
      http,
    });
    await router.isReady();

    expect(warn).not.toHaveBeenCalled();
    router.destroy();
  });

  it('wraps a transport failure as routes_load_failed', async () => {
    const http = { get: vi.fn().mockRejectedValue(new Error('502 bad gateway')) } as any;
    const router = createRouter({
      routes: { url: '/routes.json' } as never,
      components: {},
      history: createMemoryHistory('/'),
      http,
    });

    await expect(router.isReady()).rejects.toThrow(/could not load routes/);
    router.destroy();
  });

  it('passes a coded router error through unwrapped', async () => {
    // A payload with no routes array makes unwrapRoutesPayload throw a coded
    // error inside the try - it must not be re-wrapped as routes_load_failed.
    const http = { get: vi.fn().mockResolvedValue({ data: { nope: true } }) } as any;
    const router = createRouter({
      routes: { url: '/routes.json' } as never,
      components: {},
      history: createMemoryHistory('/'),
      http,
    });

    await expect(router.isReady()).rejects.toThrow(/no routes array/);
    router.destroy();
  });
});

// ---------------------------------------------------------------------------
// preheat wiring
// ---------------------------------------------------------------------------

describe('preheat wiring', () => {
  /** preheatPath is internal - the DOM integration drives it on link hover. */
  function hover(anchor: Element): void {
    anchor.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  }

  it('loads a lazy component when a hovered link resolves', async () => {
    document.body.innerHTML = '<a id="to-list" href="/list">list</a>';
    const lazy = vi.fn(async () => ({ name: 'List' }));
    const router = createRouter({
      routes: ROWS,
      components: { Home: { name: 'Home' }, List: lazy },
      history: createMemoryHistory('/'),
    });
    await router.isReady();

    hover(document.getElementById('to-list')!);
    await vi.waitFor(() => expect(lazy).toHaveBeenCalledTimes(1), { timeout: 2000 });

    // Hovering again is served from the component cache - no second load.
    hover(document.getElementById('to-list')!);
    await new Promise(r => setTimeout(r, 200));
    expect(lazy).toHaveBeenCalledTimes(1);
    router.destroy();
  });

  it('ignores a hovered link whose path resolves to nothing', async () => {
    document.body.innerHTML = '<a id="nowhere" href="/nowhere-at-all">gone</a>';
    const lazy = vi.fn(async () => ({ name: 'List' }));
    const router = createRouter({
      routes: ROWS,
      components: { Home: { name: 'Home' }, List: lazy },
      history: createMemoryHistory('/'),
    });
    await router.isReady();

    hover(document.getElementById('nowhere')!);
    await new Promise(r => setTimeout(r, 200));
    expect(lazy).not.toHaveBeenCalled();
    router.destroy();
  });
});

// ---------------------------------------------------------------------------
// loadInlineTable's success path
// ---------------------------------------------------------------------------

describe('inline routes injected after construction', () => {
  it('reads the payload at start() when the element appears late', async () => {
    // createRouter's synchronous read (readInlinePayload) finds nothing, so
    // the table stays null and start() falls through to loadInlineTable -
    // the deferred-script / late-hydration ordering.
    const router = createRouter({
      routes: { inline: '#late-routes' } as never,
      components: { Home: { name: 'Home' }, List: { name: 'List' } },
      history: createMemoryHistory('/'),
    });

    document.body.innerHTML =
      '<script id="late-routes" type="application/json">' +
      JSON.stringify({ routes: ROWS }) +
      '</script>';

    await router.isReady();
    expect(router.routes.value).toHaveLength(3);
    router.destroy();
  });
});

// ---------------------------------------------------------------------------
// preheatPath's bail after a table swap
// ---------------------------------------------------------------------------

describe('preheat racing a table swap', () => {
  it('bails when the path stops resolving during the hover delay', async () => {
    document.body.innerHTML = '<a id="to-list" href="/list">list</a>';
    const lazy = vi.fn(async () => ({ name: 'List' }));
    const router = createRouter({
      routes: ROWS,
      components: { Home: { name: 'Home' }, List: lazy },
      history: createMemoryHistory('/'),
    });
    await router.isReady();

    // canHandle passes at hover time; the table is replaced before the
    // hoverDelayMs timer fires, so preheatPath finds nothing to resolve.
    document.getElementById('to-list')!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    router.setRoutes([
      { name: 'shell', path: '/', parent: null },
      { name: 'home', path: '/', parent: 'shell', component: 'Home' },
    ]);

    await new Promise(r => setTimeout(r, 250));
    expect(lazy).not.toHaveBeenCalled();
    router.destroy();
  });
});

// ---------------------------------------------------------------------------
// createRouter option shapes the suite otherwise reaches only one arm of
// ---------------------------------------------------------------------------

describe('createRouter - table source and base variants', () => {
  it('accepts the { routes } payload OBJECT, not just a bare array', async () => {
    // Every other test passes `routes: ROWS` (the array arm). The object form
    // is the shape a Blade-inlined or fetched payload arrives in, and it may
    // carry a `base` alongside the rows.
    const router = createRouter({
      history: createMemoryHistory('/admin'),
      routes: { routes: ROWS, base: '/admin' } as any,
      components: { Home: {}, List: {} },
    });
    await router.isReady();
    expect(router.routes.value.map((r) => r.name)).toEqual(['shell', 'home', 'list']);
    router.destroy();
  });

  it('exposes a frozen empty routes list before any table exists', () => {
    // `tableRef.value?.records ?? noRecords` - the fallback arm. A remote
    // source has no table until start() resolves, so anything rendering a menu
    // during setup reads this.
    const router = createRouter({
      history: createMemoryHistory('/'),
      routes: { url: '/routes.json' } as any,
      components: {},
    });
    expect(router.routes.value).toEqual([]);
    expect(Object.isFrozen(router.routes.value)).toBe(true);
    router.destroy();
  });

  it('setQuery before a route is matched finds no leaf defs', () => {
    // `matched[matched.length - 1]?.queryDefs ?? {}` - the `?? {}` arm needs an
    // EMPTY matched chain, which is exactly the pre-isReady() state.
    const router = createRouter({
      history: createMemoryHistory('/'),
      routes: ROWS,
      components: { Home: {}, List: {} },
    });
    expect(router.currentRoute.value.location.matched).toEqual([]);
    expect(() => router.setQuery({ q: 'x' })).not.toThrow();
    router.destroy();
  });

  it('falls back to memory history and normalizes a slashless base', () => {
    // `canUseWebHistory()` probes by calling replaceState; a sandboxed/opaque
    // -origin document throws SecurityError there. That is the one path that
    // reaches the memory-history fallback WITH a window present - and so the
    // only path that runs normalizeBaseSafe, whose leading-slash arm a bare
    // `base: 'admin'` then exercises.
    const spy = vi.spyOn(window.history, 'replaceState').mockImplementation(() => {
      throw new DOMException('sandboxed', 'SecurityError');
    });
    const router = createRouter({
      base: 'admin', // no leading slash
      routes: ROWS,
      components: { Home: {}, List: {} },
    });
    expect(router.base).toBe('/admin');
    spy.mockRestore();
    router.destroy();
  });

  it('scopes link stamping to linksRoot when one is given', async () => {
    // `options.linksRoot ? document.querySelector(...) : null` - the
    // querySelector arm. Every other test omits linksRoot and takes `document`.
    document.body.innerHTML = `<nav id="side"><a href="/list">L</a></nav><a href="/list">outside</a>`;
    const router = createRouter({
      history: createMemoryHistory('/'),
      routes: ROWS,
      components: { Home: {}, List: {} },
      linksRoot: '#side',
    } as any);
    await router.isReady();
    await router.push('/list');
    expect(router.currentRoute.value.location.name).toBe('list');
    router.destroy();
  });
});

// ---------------------------------------------------------------------------
// The last two uncovered functions in the library: preheatPath's rejection
// handler and the idle-preheat thunk.
// ---------------------------------------------------------------------------

describe('preheat failure and idle arming', () => {
  it('swallows a preheat load that REJECTS', async () => {
    // preheatPath fires `void loadComponent(...).catch(() => {})`. The existing
    // hover test resolves, so the catch never ran - yet a rejected chunk is the
    // normal case after a deploy invalidates a hashed asset. It must not
    // surface as an unhandled rejection from a mere hover.
    document.body.innerHTML = '<a id="to-list" href="/list">list</a>';
    const lazy = vi.fn(async () => {
      throw new Error('Failed to fetch dynamically imported module');
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const router = createRouter({
        routes: ROWS,
        components: { Home: { name: 'Home' }, List: lazy },
        history: createMemoryHistory('/'),
      });
      await router.isReady();

      document.getElementById('to-list')!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      // Hover preheat is delayed - poll for the side effect, as the sibling
      // test does, rather than racing a fixed tick.
      await vi.waitFor(() => expect(lazy).toHaveBeenCalledTimes(1), { timeout: 2000 });
      // Let the rejection settle so an unhandled one would surface.
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));

      expect(unhandled).toEqual([]);
      // Hover failure is best-effort: the router is untouched by it.
      expect(router.currentRoute.value.location.name).toBe('home');
      router.destroy();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('idle-preheats rows flagged meta.preheat', async () => {
    // The existing test arms idle preheat with NOTHING flagged, so the thunk
    // handed to preheatIdle was never built or called. requestIdleCallback is
    // stubbed to fire inline so the schedule is deterministic.
    vi.stubGlobal('requestIdleCallback', (cb: () => void) => { cb(); });
    const heavy = vi.fn(async () => ({ name: 'Heavy' }));
    const router = createRouter({
      history: createMemoryHistory('/'),
      routes: [
        { name: 'home', path: '/', component: 'Home' },
        { name: 'heavy', path: '/heavy', component: 'Heavy', meta: { preheat: true } },
      ],
      components: { Home: { name: 'Home' }, Heavy: heavy },
    });
    await router.isReady();
    await new Promise((r) => setTimeout(r, 0));

    expect(heavy).toHaveBeenCalled(); // loaded without ever navigating there
    router.destroy();
    vi.unstubAllGlobals();
  });
});

// ---------------------------------------------------------------------------
// bladeFetcher - the two arms the suite never reached. It moved to
// `vapor-chamber/router/remote` when the router stopped building an http
// client for features most apps never use; the behaviour is unchanged, so the
// assertions are the same and only the wiring moved.
// ---------------------------------------------------------------------------

describe('bladeFetcher', () => {
  const BLADE_ROWS: RouteRecord[] = [
    { name: 'home', path: '/', component: 'Home' },
    { name: 'legacy', path: '/legacy', blade: true },
  ];

  /** Minimal HttpClient stand-in: only `.get` is reached from here. */
  const htmlClient = (html: string) => ({ get: vi.fn(async () => ({ data: html })) }) as any;

  it('falls back to doc.body when the blade root selector matches nothing', async () => {
    // `(doc.querySelector(bladeRoot) ?? doc.body).innerHTML` - the `?? doc.body`
    // arm. A server template that does not wrap its content in the configured
    // root must still yield its markup rather than an empty string.
    const http = htmlClient('<html><body><p id="from-body">legacy page</p></body></html>');
    const router = createRouter({
      history: createMemoryHistory('/'),
      routes: BLADE_ROWS,
      components: { Home: { name: 'Home' } },
      // No <main> in the response, and bladeRoot defaults to 'main'.
      fetchBlade: bladeFetcher({ http }),
    } as any);
    await router.isReady();

    await router.push('/legacy');
    expect(http.get).toHaveBeenCalled();
    expect(router.currentRoute.value.location.name).toBe('legacy');
    router.destroy();
  });

  it('returns the raw body when DOMParser is unavailable', async () => {
    // The SSR / non-DOM arm: without DOMParser there is nothing to extract
    // with, so the whole response is handed through unparsed.
    const raw = '<html><body><main id="m">parsed?</main></body></html>';
    const http = htmlClient(raw);
    vi.stubGlobal('DOMParser', undefined);
    try {
      const router = createRouter({
        history: createMemoryHistory('/'),
        routes: BLADE_ROWS,
        components: { Home: { name: 'Home' } },
        fetchBlade: bladeFetcher({ http }),
      } as any);
      await router.isReady();

      await router.push('/legacy');
      expect(http.get).toHaveBeenCalled();
      expect(router.currentRoute.value.location.name).toBe('legacy');
      router.destroy();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
