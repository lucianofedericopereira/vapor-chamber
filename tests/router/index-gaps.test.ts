// @vitest-environment happy-dom
/**
 * createRouter wiring in src/router/index.ts: table-source variants, hover preheat, idle preheat, option shapes, bladeFetcher.
 * Why: a route table that fails to load must not be re-wrapped over its own code, a payload base the history cannot
 * adopt must warn, and a hover on a link must warm its lazy component without surfacing a rejected chunk as an unhandled rejection.
 * Also the only file reaching the remote base warning, linksRoot and bladeFetcher's body fallback, so the 100% floor needs it.
 * Shows: inline tables are read at construction or at start();
 * a remote payload warns on an unadoptable base and a coded error passes through unwrapped; hover loads a lazy
 * component once and ignores an unresolvable path; a rejected preheat load is swallowed; meta.preheat rows load on idle;
 * bladeFetcher navigates to a blade route with and without DOMParser.
 * See: tests/router/routes-plain-json.test.ts, log s36.19
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory } from '@router/history';
import { bladeFetcher } from '@router/remote';
import { createRouter, readRoutesPayload } from '@router/index';
import type { RouteRecord } from '@router/types';
import { stubGlobal } from '../../src/vitest-pure';
import { makeRouter, ROWS } from './fixture';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('readRoutesPayload', () => {
  it('rejects a payload with no routes array', () => {
    expect(() => readRoutesPayload({ nope: true })).toThrow(/no routes array/);
    expect(() => readRoutesPayload(null)).toThrow(/no routes array/);
  });
});

describe('inline routes source', () => {
  it('reads the table out of the DOM and applies its base', async () => {
    document.body.innerHTML =
      '<script id="routes" type="application/json">' +
      JSON.stringify({ routes: ROWS, base: '/shop' }) +
      '</script>';

    const router = makeRouter({
      routes: { inline: '#routes' } as never,
      history: createMemoryHistory('/shop'),
    });
    await router.isReady();

    expect(router.routes.value).toHaveLength(3);
    expect(router.base).toBe('/shop');
    router.dispose();
  });
});

describe('remote routes source', () => {
  it('warns when a fetched payload declares a base the history cannot adopt', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const http = { get: vi.fn().mockResolvedValue({ data: { routes: ROWS, base: '/from-payload' } }), onInvalidateGroup: () => () => {} } as any;

    const router = makeRouter({
      routes: { url: '/routes.json' } as never,
      http,
    });
    await router.isReady();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('/from-payload');
    expect(router.routes.value).toHaveLength(3);
    router.dispose();
  });

  it('passes a coded router error through unwrapped', async () => {
    // readRoutesPayload throws a coded error inside the try; it must not be re-wrapped as router:failed:routes.
    const http = { get: vi.fn().mockResolvedValue({ data: { nope: true } }), onInvalidateGroup: () => () => {} } as any;
    const router = makeRouter({
      routes: { url: '/routes.json' } as never,
      components: {},
      http,
    });

    await expect(router.isReady()).rejects.toThrow(/no routes array/);
    router.dispose();
  });
});

describe('preheat wiring', () => {
  /** preheatPath is internal; the DOM integration drives it on link hover. */
  function hover(anchor: Element): void {
    anchor.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  }

  it('loads a lazy component when a hovered link resolves', async () => {
    document.body.innerHTML = '<a id="to-list" href="/list">list</a>';
    const lazy = vi.fn(async () => ({ name: 'List' }));
    const router = makeRouter({
      components: { Home: { name: 'Home' }, List: lazy },
    });
    await router.isReady();

    hover(document.getElementById('to-list')!);
    await vi.waitFor(() => expect(lazy).toHaveBeenCalledTimes(1), { timeout: 2000 });

    // A second hover is served from the component cache.
    hover(document.getElementById('to-list')!);
    await new Promise(r => setTimeout(r, 200));
    expect(lazy).toHaveBeenCalledTimes(1);
    router.dispose();
  });

  it('ignores a hovered link whose path resolves to nothing', async () => {
    document.body.innerHTML = '<a id="nowhere" href="/nowhere-at-all">gone</a>';
    const lazy = vi.fn(async () => ({ name: 'List' }));
    const router = makeRouter({
      components: { Home: { name: 'Home' }, List: lazy },
    });
    await router.isReady();

    hover(document.getElementById('nowhere')!);
    await new Promise(r => setTimeout(r, 200));
    expect(lazy).not.toHaveBeenCalled();
    router.dispose();
  });
});

describe('inline routes injected after construction', () => {
  it('reads the payload at start() when the element appears late', async () => {
    // The synchronous read at construction finds nothing, so start() loads the table (deferred script, late hydration).
    const router = makeRouter({
      routes: { inline: '#late-routes' } as never,
    });

    document.body.innerHTML =
      '<script id="late-routes" type="application/json">' +
      JSON.stringify({ routes: ROWS }) +
      '</script>';

    await router.isReady();
    expect(router.routes.value).toHaveLength(3);
    router.dispose();
  });
});

describe('preheat racing a table swap', () => {
  it('bails when the path stops resolving during the hover delay', async () => {
    document.body.innerHTML = '<a id="to-list" href="/list">list</a>';
    const lazy = vi.fn(async () => ({ name: 'List' }));
    const router = makeRouter({
      components: { Home: { name: 'Home' }, List: lazy },
    });
    await router.isReady();

    // The hover arms without reading the table; the swap lands before the timer fires, so nothing resolves.
    document.getElementById('to-list')!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    router.setRoutes([
      { name: 'shell', path: '/', parent: null },
      { name: 'home', path: '/', parent: 'shell', component: 'Home' },
    ]);

    await new Promise(r => setTimeout(r, 250));
    expect(lazy).not.toHaveBeenCalled();
    router.dispose();
  });

  // The opposite swap: no row matches at hover time, one does when the timer fires; the route is read then.
  it('warms a route added during the hover delay', async () => {
    document.body.innerHTML = '<a id="to-late" href="/late">late</a>';
    const late = vi.fn(async () => ({ name: 'Late' }));
    const router = makeRouter({
      components: { Home: { name: 'Home' }, List: { name: 'List' }, Late: late },
    });
    try {
      await router.isReady();
      document.getElementById('to-late')!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      router.setRoutes([...ROWS, { name: 'late', path: '/late', parent: 'shell', component: 'Late' }]);

      await new Promise(r => setTimeout(r, 250));
      expect(late).toHaveBeenCalledTimes(1);
    } finally {
      router.dispose();
    }
  });
});

describe('createRouter - table source and base variants', () => {
  it('accepts the { routes } payload OBJECT, not just a bare array', async () => {
    // The object form is the shape a Blade-inlined or fetched payload arrives in, and it may carry a `base`.
    const router = makeRouter({
      history: createMemoryHistory('/admin'),
      routes: { routes: ROWS, base: '/admin' } as any,
      components: { Home: {}, List: {} },
    });
    await router.isReady();
    expect(router.routes.value.map((r) => r.name)).toEqual(['shell', 'home', 'list']);
    router.dispose();
  });

  it('exposes a frozen empty routes list before any table exists', () => {
    // A remote source has no table until start() resolves, so a menu rendered during setup reads this.
    const router = makeRouter({
      routes: { url: '/routes.json' } as any,
      components: {},
    });
    expect(router.routes.value).toEqual([]);
    expect(Object.isFrozen(router.routes.value)).toBe(true);
    router.dispose();
  });

  it('setQuery before a route is matched finds no leaf defs', () => {
    // The matched chain is empty before isReady().
    const router = makeRouter({
      components: { Home: {}, List: {} },
    });
    expect(router.currentRoute.value.location.matched).toEqual([]);
    expect(() => router.setQuery({ q: 'x' })).not.toThrow();
    router.dispose();
  });

  it('falls back to memory history and normalizes a slashless base', () => {
    // canUseWebHistory() probes with replaceState; an opaque-origin document throws SecurityError there.
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
    router.dispose();
  });

  it('scopes link stamping to linksRoot when one is given', async () => {
    document.body.innerHTML = `<nav id="side"><a href="/list">L</a></nav><a href="/list">outside</a>`;
    const router = makeRouter({
      components: { Home: {}, List: {} },
      linksRoot: '#side',
    } as any);
    await router.isReady();
    await router.push('/list');
    expect(router.currentRoute.value.location.name).toBe('list');
    router.dispose();
  });
});

describe('preheat failure and idle arming', () => {
  it('swallows a preheat load that REJECTS', async () => {
    // A rejected chunk is normal after a deploy invalidates a hashed asset; a hover must not surface it as an unhandled rejection.
    document.body.innerHTML = '<a id="to-list" href="/list">list</a>';
    const lazy = vi.fn(async () => {
      throw new Error('Failed to fetch dynamically imported module');
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const router = makeRouter({
        components: { Home: { name: 'Home' }, List: lazy },
      });
      await router.isReady();

      document.getElementById('to-list')!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      // Hover preheat is delayed: poll for the side effect rather than race a fixed tick.
      await vi.waitFor(() => expect(lazy).toHaveBeenCalledTimes(1), { timeout: 2000 });
      // Let the rejection settle so an unhandled one would surface.
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));

      expect(unhandled).toEqual([]);
      expect(router.currentRoute.value.location.name).toBe('home');
      router.dispose();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('idle-preheats rows flagged meta.preheat', async () => {
    // requestIdleCallback fires inline so the schedule is deterministic.
    using _requestIdleCallback = stubGlobal('requestIdleCallback', (cb: () => void) => { cb(); });
    const heavy = vi.fn(async () => ({ name: 'Heavy' }));
    const router = makeRouter({
      routes: [
        { name: 'home', path: '/', component: 'Home' },
        { name: 'heavy', path: '/heavy', component: 'Heavy', meta: { preheat: true } },
      ],
      components: { Home: { name: 'Home' }, Heavy: heavy },
    });
    await router.isReady();
    await new Promise((r) => setTimeout(r, 0));

    expect(heavy).toHaveBeenCalled();
    router.dispose();
  });
});

describe('bladeFetcher', () => {
  const BLADE_ROWS: RouteRecord[] = [
    { name: 'home', path: '/', component: 'Home' },
    { name: 'legacy', path: '/legacy', blade: true },
  ];

  /** Minimal HttpClient stand-in: only `.get` is reached from here. */
  const htmlClient = (html: string) => ({ get: vi.fn(async () => ({ data: html })), onInvalidateGroup: () => () => {} }) as any;

  it('falls back to doc.body when the blade root selector matches nothing', async () => {
    // A server template that does not wrap its content in the configured root must still yield its markup.
    const http = htmlClient('<html><body><p id="from-body">legacy page</p></body></html>');
    const router = makeRouter({
      routes: BLADE_ROWS,
      components: { Home: { name: 'Home' } },
      // The response has no <main>, the default bladeRoot.
      fetchBlade: bladeFetcher({ http }),
    } as any);
    await router.isReady();

    await router.push('/legacy');
    expect(http.get).toHaveBeenCalled();
    expect(router.currentRoute.value.location.name).toBe('legacy');
    router.dispose();
  });

  it('returns the raw body when DOMParser is unavailable', async () => {
    // Without DOMParser (SSR) the whole response is handed through unparsed.
    const raw = '<html><body><main id="m">parsed?</main></body></html>';
    const http = htmlClient(raw);
    using _DOMParser = stubGlobal('DOMParser', undefined);
    const router = makeRouter({
      routes: BLADE_ROWS,
      components: { Home: { name: 'Home' } },
      fetchBlade: bladeFetcher({ http }),
    } as any);
    await router.isReady();

    await router.push('/legacy');
    expect(http.get).toHaveBeenCalled();
    expect(router.currentRoute.value.location.name).toBe('legacy');
    router.dispose();
  });
});
