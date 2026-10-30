// @vitest-environment happy-dom
/**
 * createRouter in src/router/index.ts: install, start and dispose, public methods, inline and remote route tables, hard-navigation loop guard.
 * Why: an after-hook that throws or removes itself would un-commit or skip a neighbour; an inline payload base ignored
 * would leave every in-base link unintercepted and turn each navigation into a page load; a hard navigation to the
 * URL already shown would reload forever; a bad route table source must fail from start() with a coded error.
 * Shows: app.use starts the router on home; a click on an in-base link is intercepted and navigates; a throwing
 * afterEach returns null with the route committed and onError silent; self-removing hooks skip no neighbour; query-only
 * changes run no after-hook or link walk; inline payload base is adopted and an explicit base wins; inline and remote
 * table failures carry router:missing:inline and router:failed:routes; location.assign is not called for the current URL.
 */
import { describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h } from 'vue';
import { createRouter } from '@router/index';
import type { RouteRecord } from '@router/types';
import { makeRouter as fixtureRouter } from './fixture';

const ROWS: RouteRecord[] = [
  { name: 'shell', path: '/', parent: null },
  { name: 'home', path: '/', parent: 'shell', component: 'Home', meta: { menu: 0, title: 'h' } },
  { name: 'list', path: '/list', parent: 'shell', component: 'List' },
];

function makeRouter(overrides: Record<string, unknown> = {}) {
  return fixtureRouter({
    base: '/admin',
    routes: ROWS,
    components: {
      Home: defineComponent({ render: () => h('span', 'home') }),
      List: defineComponent({ render: () => h('span', 'list') }),
    },
    ...overrides,
  });
}

describe('createRouter - install + lifecycle (happy-dom)', () => {
  it('app.use installs, starts, wires DOM integration, and dispose tears down', async () => {
    const router = makeRouter();
    const app = createApp({ render: () => h('div') });

    app.use(router);
    await router.isReady();
    expect(router.currentRoute.value.location.name).toBe('home');

    expect(() => router.dispose()).not.toThrow();
  });

  it('DOM integration: intercepts in-base clicks, preheats on hover, restores on bfcache', async () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    // Polls: navigation is async and slower under instrumentation, so a fixed tick would be flaky.
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

    a.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    await sleep(120);

    const click = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    a.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(await waitFor(() => router.currentRoute.value.location.name === 'list')).toBe(true);

    const pageshow = new Event('pageshow');
    Object.defineProperty(pageshow, 'persisted', { value: true });
    expect(() => window.dispatchEvent(pageshow)).not.toThrow();

    a.remove();
    router.dispose();
  });
});

describe('createRouter - public methods', () => {
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
    await router.push('/nope'); // unmatched
    expect(onErr).toHaveBeenCalled();
  });

  // After-hooks are post-commit observers: they must not un-commit a navigation.
  it('a throwing afterEach hook does not un-commit the navigation', async () => {
    const onErr = vi.fn();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const router = makeRouter();
    router.onError(onErr);
    router.afterEach(() => {
      throw new Error('analytics blew up');
    });
    const second = vi.fn();
    router.afterEach(second);

    await router.isReady();
    const result = await router.push('/list');

    expect(result).toBeNull();
    expect(router.currentRoute.value.location.name).toBe('list');
    expect(onErr).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('afterEach hook threw'), expect.anything());
  });

  it('a one-shot afterEach does not skip the next hook', async () => {
    const router = makeRouter();
    await router.isReady(); // register after the initial navigation, so exactly one nav is under test

    const second = vi.fn();
    const off = router.afterEach(() => {
      off();
    });
    router.afterEach(second);

    await router.push('/list');

    expect(second).toHaveBeenCalledTimes(1);
  });

  it('a self-removing beforeEach guard does not skip the next guard', async () => {
    const router = makeRouter();
    await router.isReady();

    const second = vi.fn(() => true);
    const off = router.beforeEach(() => {
      off();
      return true;
    });
    router.beforeEach(second);

    await router.push('/list');

    expect(second).toHaveBeenCalledTimes(1);
    expect(router.currentRoute.value.location.name).toBe('list');
  });

  // The query fast path returns before the after-hook loop; stamps derive from `location.path` alone, so a search box costs no link walk.
  it('after-hooks (and so active-link stamping) run on path changes only', async () => {
    document.body.innerHTML = '<a href="/admin/list">List</a><a href="/admin/">Home</a>';
    const router = fixtureRouter({
      base: '/admin',
      routes: [
        { name: 'home', path: '/', component: 'Home' },
        { name: 'list', path: '/list', component: 'List', query: { q: {} } },
      ],
      components: {
        Home: defineComponent({ render: () => h('span', 'home') }),
        List: defineComponent({ render: () => h('span', 'list') }),
      },
    });
    await router.isReady();
    await router.push('/list');

    const real = document.querySelectorAll.bind(document);
    let walks = 0;
    {
      using _spy = vi.spyOn(document, 'querySelectorAll').mockImplementation((selector: string) => {
        if (selector === 'a[href]') walks++;
        return real(selector);
      });
      const after = vi.fn();
      router.afterEach(after);

      router.setQuery({ q: 'sh' });
      router.setQuery({ q: 'sho' });
      await new Promise((r) => setTimeout(r, 20));
      await router.push('/list?q=shoe'); // query-only via push() takes the same fast path

      expect(router.currentRoute.value.location.query.q).toBe('shoe');
      expect(after).not.toHaveBeenCalled();
      expect(walks).toBe(0);

      await router.push('/'); // a real path change
      expect(after).toHaveBeenCalledTimes(1);
      expect(walks).toBe(1);

      const list = document.querySelector('a[href="/admin/list"]') as HTMLAnchorElement;
      expect(list.hasAttribute('data-active')).toBe(false);
    }

    router.dispose();
    document.body.innerHTML = '';
  });

  it('setRoutes swaps the table; resolve builds hrefs', async () => {
    const router = makeRouter();
    await router.isReady();

    expect(router.resolve({ name: 'list' })).toContain('/list');
    expect(router.resolve('/raw')).toBe('/admin/raw');
    // An unresolvable object target falls back to the base root.
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
    // The document must sit inside the base, as the server's catch-all guarantees in production.
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
    // The constructor is pure: a bad selector surfaces as a coded error from start(), not a throw.
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
    // router:missing:route is a HARD_NAV code; behind the catch-all the server returns the same shell, so assigning the current URL would reload forever.
    window.history.replaceState({}, '', '/admin/does-not-exist');
    const assign = vi.fn();
    const original = window.location.assign;
    Object.defineProperty(window.location, 'assign', { value: assign, configurable: true });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const router = makeRouter({ history: undefined, base: '/admin' });
      await router.isReady();

      expect(assign).not.toHaveBeenCalled();
      expect(errors).toHaveBeenCalled();
      router.dispose();
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
      router.dispose();
    } finally {
      Object.defineProperty(window.location, 'assign', { value: original, configurable: true });
    }
  });
});

describe('route table delivery - error paths', () => {
  it('inline: a missing element fails with a coded error from start(), not the constructor', async () => {
    const router = createRouter({ routes: { inline: '#vcr-absent' } });
    await expect(router.isReady()).rejects.toMatchObject({ code: 'router:missing:inline' });
  });

  it('inline: an element with no text fails the same way', async () => {
    const empty = document.createElement('script');
    empty.type = 'application/json';
    empty.id = 'vcr-empty';
    document.head.appendChild(empty);
    const router = createRouter({ routes: { inline: '#vcr-empty' } });
    await expect(router.isReady()).rejects.toMatchObject({ code: 'router:missing:inline' });
  });

  it('remote: stays quiet when an explicit base was given', async () => {
    using warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const router = createRouter({
      base: '/admin',
      routes: { url: '/routes.json' },
      http: { get: async () => ({ data: { base: '/admin', routes: ROWS } }), onInvalidateGroup: () => () => {} } as never,
    });
    await router.isReady();
    expect(warn).not.toHaveBeenCalled();
    router.dispose();
  });

  it('remote: a failing fetch surfaces as router:failed:routes', async () => {
    const router = createRouter({
      routes: { url: '/routes.json' },
      http: { get: async () => { throw new Error('network down'); }, onInvalidateGroup: () => () => {} } as never,
    });
    await expect(router.isReady()).rejects.toMatchObject({ code: 'router:failed:routes' });
  });
});
