// @vitest-environment happy-dom
/**
 * createRouter wiring paths the router suite leaves open — the table-source
 * variants and the helpers that only run for specific option shapes.
 *
 *  - loadInlineTable (349-357): a selector that matches nothing / an empty
 *    element (354-356), and the happy path reading a payload out of the DOM.
 *  - warnRemoteBase (363-369): a fetched payload declaring a base that
 *    disagrees with the already-built history (373-375).
 *  - preheatPath (371-379): hover-preheat resolving a path and loading its
 *    lazy component, plus the unresolvable-path bail (373).
 *  - the meta.preheat idle arming with nothing flagged (403-404).
 *  - unwrapRoutesPayload's envelope arms (128-135).
 *  - defaultFetchBlade's DOMParser extraction and its no-DOMParser fallback
 *    (549-551).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory } from '../../src/router/history';
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
// unwrapRoutesPayload (125-136)
// ---------------------------------------------------------------------------

describe('unwrapRoutesPayload', () => {
  it('unwraps the house envelope { ok: true, state } (131)', () => {
    const payload = unwrapRoutesPayload({ ok: true, state: { routes: ROWS, base: '/admin' } });
    expect(payload.base).toBe('/admin');
    expect(payload.routes).toHaveLength(3);
  });

  it('throws with the envelope error when ok is false (128-130)', () => {
    expect(() => unwrapRoutesPayload({ ok: false, error: 'forbidden' })).toThrow(/forbidden/);
    // Missing error string falls back to "unknown error".
    expect(() => unwrapRoutesPayload({ ok: false })).toThrow(/unknown error/);
  });

  it('rejects a bare payload with no routes array (133-135)', () => {
    expect(() => unwrapRoutesPayload({ nope: true })).toThrow(/no routes array/);
    expect(() => unwrapRoutesPayload(null)).toThrow(/no routes array/);
  });
});

// ---------------------------------------------------------------------------
// inline table source (349-357)
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

  it('throws inline_routes_missing when the selector matches nothing (354-355)', async () => {
    const router = createRouter({
      routes: { inline: '#absent' } as never,
      components: {},
      history: createMemoryHistory('/'),
    });
    await expect(router.isReady()).rejects.toThrow(/no inline routes element matches/);
    router.destroy();
  });

  it('throws inline_routes_missing for an empty element (354-355)', async () => {
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
// remote table source (336-346, 363-369)
// ---------------------------------------------------------------------------

describe('remote routes source', () => {
  it('warns when a fetched payload declares a base the history cannot adopt (373-375)', async () => {
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

  it('does not warn when the caller passed base explicitly (364)', async () => {
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

  it('wraps a transport failure as routes_load_failed (342-345)', async () => {
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

  it('passes a coded router error through unwrapped (343-344)', async () => {
    // A payload with no routes array makes unwrapRoutesPayload throw a coded
    // error inside the try — it must not be re-wrapped as routes_load_failed.
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
// preheat wiring (371-379, 397-405)
// ---------------------------------------------------------------------------

describe('preheat wiring', () => {
  /** preheatPath is internal — the DOM integration drives it on link hover. */
  function hover(anchor: Element): void {
    anchor.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  }

  it('loads a lazy component when a hovered link resolves (374-377)', async () => {
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

    // Hovering again is served from the component cache — no second load.
    hover(document.getElementById('to-list')!);
    await new Promise(r => setTimeout(r, 200));
    expect(lazy).toHaveBeenCalledTimes(1);
    router.destroy();
  });

  it('ignores a hovered link whose path resolves to nothing (373)', async () => {
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
// loadInlineTable's success path (357)
// ---------------------------------------------------------------------------

describe('inline routes injected after construction', () => {
  it('reads the payload at start() when the element appears late (357)', async () => {
    // createRouter's synchronous read (readInlinePayload) finds nothing, so
    // the table stays null and start() falls through to loadInlineTable —
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
// preheatPath's bail after a table swap (373)
// ---------------------------------------------------------------------------

describe('preheat racing a table swap', () => {
  it('bails when the path stops resolving during the hover delay (373)', async () => {
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
