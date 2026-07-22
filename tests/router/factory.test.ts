// @vitest-environment happy-dom
/**
 * Tests for router/index.ts — createRouter install/start/destroy lifecycle
 * (DOM integration runs because happy-dom provides `window`) and the public
 * router methods node-env navigation tests don't reach.
 */

import { describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h } from 'vue';
import { createMemoryHistory } from '../../src/router/history';
import { createRouter } from '../../src/router/index';
import type { RouteRecord } from '../../src/router/types';

const ROWS: RouteRecord[] = [
  { name: 'shell', path: '/', parent: null },
  { name: 'home', path: '/', parent: 'shell', component: 'Home', meta: { menu: 0, title: 'h' } },
  { name: 'list', path: '/list', parent: 'shell', component: 'List' },
];

function makeRouter(overrides: Record<string, unknown> = {}) {
  return createRouter({
    base: '/admin',
    history: createMemoryHistory('/admin'),
    routes: ROWS,
    components: {
      Home: defineComponent({ render: () => h('span', 'home') }),
      List: defineComponent({ render: () => h('span', 'list') }),
    },
    ...overrides,
  });
}

describe('createRouter — install + lifecycle (happy-dom)', () => {
  it('app.use installs, starts, wires DOM integration, and destroy tears down', async () => {
    const router = makeRouter();
    const app = createApp({ render: () => h('div') });

    app.use(router); // install → provide + component + start() → DOM integration
    await router.isReady();
    expect(router.currentRoute.value.location.name).toBe('home');

    expect(() => router.destroy()).not.toThrow(); // teardowns + history.destroy
  });

  it('DOM integration: intercepts in-base clicks, preheats on hover, restores on bfcache', async () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    // Poll rather than sleep a fixed amount — navigation is async and slower
    // under coverage instrumentation, so a fixed tick would be flaky.
    const waitFor = async (predicate: () => boolean, timeout = 1000) => {
      const deadline = Date.now() + timeout;
      while (!predicate() && Date.now() < deadline) await sleep(10);
      return predicate();
    };
    const router = makeRouter();
    const app = createApp({ render: () => h('div') });
    app.use(router);
    await router.isReady();

    const a = document.createElement('a');
    a.href = '/admin/list';
    document.body.appendChild(a);

    // hover → the router's preheat callback (preheatPath)
    a.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    await sleep(120);

    // click → the router's navigate callback intercepts it
    const click = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    a.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(await waitFor(() => router.currentRoute.value.location.name === 'list')).toBe(true);

    // bfcache restore → the router's onRestore (re-stamp + re-arm preheat)
    const pageshow = new Event('pageshow');
    Object.defineProperty(pageshow, 'persisted', { value: true });
    expect(() => window.dispatchEvent(pageshow)).not.toThrow();

    a.remove();
    router.destroy();
  });
});

describe('createRouter — public methods', () => {
  it('replace / back / forward / go drive history', async () => {
    const router = makeRouter();
    await router.isReady();

    await router.push('/list');
    expect(router.currentRoute.value.location.name).toBe('list');
    await router.replace('/');
    expect(router.currentRoute.value.location.name).toBe('home');

    expect(() => {
      router.back();
      router.forward();
      router.go(0);
    }).not.toThrow();
  });

  it('afterEach + onError subscribe, fire, and dispose', async () => {
    const router = makeRouter();
    const after = vi.fn();
    const onErr = vi.fn();
    const offAfter = router.afterEach(after);
    router.onError(onErr);

    await router.isReady();
    await router.push('/list');
    expect(after).toHaveBeenCalled();

    offAfter();
    await router.push('/nope'); // unmatched → error dispatch
    expect(onErr).toHaveBeenCalled();
  });

  it('setRoutes swaps the table; resolve builds hrefs', async () => {
    const router = makeRouter();
    await router.isReady();

    expect(router.resolve({ name: 'list' })).toContain('/list');
    expect(router.resolve('/raw')).toBe('/admin/raw');
    // unresolvable object target → resolveLocation throws → catch fallback (to.path ?? '/')
    expect(router.resolve({ name: 'does-not-exist' })).toBe('/admin/');

    router.setRoutes(ROWS);
    expect(router.routes.value.length).toBeGreaterThan(0);
  });

  it('reload() without a { url } routes source throws', async () => {
    const router = makeRouter();
    await router.isReady();
    await expect(router.reload()).rejects.toThrow(/needs a \{ url \} routes source/);
  });
});

describe('inline route payloads inform `base` synchronously', () => {
  const payload = {
    base: '/admin',
    routes: [
      { name: 'home', path: '/', component: 'Home' },
      { name: 'products', path: '/products', component: 'Products' },
    ],
  };

  function inlineTable(id: string): void {
    const script = document.createElement('script');
    script.type = 'application/json';
    script.id = id;
    script.textContent = JSON.stringify(payload);
    document.head.appendChild(script);
  }

  it('adopts the payload base before the history is built', async () => {
    // Regression: `syncPayload` was only computed for array/{routes} sources,
    // so `{ inline }` + a payload base silently ran on base ''. Every in-base
    // link then failed `canHandle` (it was handed an unstripped path), no
    // anchor was ever intercepted, and every navigation became a full page
    // load — invisible to a suite that navigates through router.push().
    // The document must sit inside the base, as the server's catch-all
    // guarantees in production.
    window.history.replaceState({}, '', '/admin/');
    inlineTable('vcr-base-sync');
    const stub = (name: string) => defineComponent({ name, setup: () => () => h('div', name) });
    const router = createRouter({
      routes: { inline: '#vcr-base-sync' },
      components: { Home: stub('Home'), Products: stub('Products') },
    });

    expect(router.base).toBe('/admin');

    await router.isReady();
    await router.push('/products');
    expect(router.currentRoute.value.location.name).toBe('products');
    // The base is stripped from what the table sees, and re-applied in the URL.
    expect(router.currentRoute.value.location.path).toBe('/products');
    expect(window.location.pathname).toBe('/admin/products');
  });

  it('still lets an explicit base win over the payload', () => {
    inlineTable('vcr-base-override');
    const router = createRouter({ base: '/panel', routes: { inline: '#vcr-base-override' } });
    expect(router.base).toBe('/panel');
  });

  it('does not throw at construction when the inline element is missing', () => {
    // The constructor is documented as pure: a bad selector must surface as a
    // coded error from start(), not as a throw from createRouter().
    expect(() => createRouter({ routes: { inline: '#vcr-not-here' } })).not.toThrow();
  });

  it('does not throw at construction when the inline JSON is malformed', () => {
    const script = document.createElement('script');
    script.type = 'application/json';
    script.id = 'vcr-bad-json';
    script.textContent = '{ not json';
    document.head.appendChild(script);
    expect(() => createRouter({ routes: { inline: '#vcr-bad-json' } })).not.toThrow();
  });
});

describe('hard-navigation loop guard', () => {
  it('refuses to hard-navigate to the URL it is already on', async () => {
    // Regression: `unmatched` is a HARD_NAV code, so the router handed the URL
    // back to the server. Behind the catch-all this router targets, the server
    // returns the same shell, the router says `unmatched` again, and
    // location.assign() fires again — an endless reload storm that survives
    // refreshes, since the offending URL stays in the address bar.
    window.history.replaceState({}, '', '/admin/does-not-exist');
    const assign = vi.fn();
    const original = window.location.assign;
    Object.defineProperty(window.location, 'assign', { value: assign, configurable: true });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const router = makeRouter({ history: undefined, base: '/admin' });
      await router.isReady();

      expect(assign).not.toHaveBeenCalled();
      expect(errors).toHaveBeenCalled(); // diagnosed loudly instead
      router.destroy();
    } finally {
      errors.mockRestore();
      Object.defineProperty(window.location, 'assign', { value: original, configurable: true });
    }
  });

  it('still hard-navigates when the target is a DIFFERENT url', async () => {
    window.history.replaceState({}, '', '/admin/');
    const assign = vi.fn();
    const original = window.location.assign;
    Object.defineProperty(window.location, 'assign', { value: assign, configurable: true });

    try {
      const router = makeRouter({ history: undefined, base: '/admin' });
      await router.isReady();
      await router.push('/somewhere-else'); // unmatched, and not where we are
      expect(assign).toHaveBeenCalledWith('/admin/somewhere-else');
      router.destroy();
    } finally {
      Object.defineProperty(window.location, 'assign', { value: original, configurable: true });
    }
  });
});

describe('route table delivery — error paths', () => {
  it('inline: a missing element fails with a coded error from start(), not the constructor', async () => {
    const router = createRouter({ routes: { inline: '#vcr-absent' } });
    await expect(router.isReady()).rejects.toMatchObject({ code: 'inline_routes_missing' });
  });

  it('inline: an element with no text fails the same way', async () => {
    const empty = document.createElement('script');
    empty.type = 'application/json';
    empty.id = 'vcr-empty';
    document.head.appendChild(empty);
    const router = createRouter({ routes: { inline: '#vcr-empty' } });
    await expect(router.isReady()).rejects.toMatchObject({ code: 'inline_routes_missing' });
  });

  it('remote: warns when the payload declares a base the router cannot adopt', async () => {
    // A fetched payload arrives after the history exists, so its `base` can
    // never apply. Silence here is what made this class of bug invisible.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const router = createRouter({
        routes: { url: '/routes.json' },
        http: { get: async () => ({ data: { base: '/admin', routes: ROWS } }) } as never,
      });
      await router.isReady();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('declares base "/admin"'));
      router.destroy();
    } finally {
      warn.mockRestore();
    }
  });

  it('remote: stays quiet when an explicit base was given', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const router = createRouter({
        base: '/admin',
        routes: { url: '/routes.json' },
        http: { get: async () => ({ data: { base: '/admin', routes: ROWS } }) } as never,
      });
      await router.isReady();
      expect(warn).not.toHaveBeenCalled();
      router.destroy();
    } finally {
      warn.mockRestore();
    }
  });

  it('remote: a failing fetch surfaces as routes_load_failed', async () => {
    const router = createRouter({
      routes: { url: '/routes.json' },
      http: { get: async () => { throw new Error('network down'); } } as never,
    });
    await expect(router.isReady()).rejects.toMatchObject({ code: 'routes_load_failed' });
  });
});
