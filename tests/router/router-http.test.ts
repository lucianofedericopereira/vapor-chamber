// @vitest-environment happy-dom
/**
 * `routerHttp()` - the client the router used to build for itself.
 *
 * Every other suite injects a stub client, so the REAL one was only ever
 * covered incidentally, back when `createRouter` constructed it for every
 * router whether or not anything used it. It now lives in
 * `vapor-chamber/router/remote` and is passed in like any other option, which
 * means nothing exercises it unless a test does so deliberately.
 *
 * Driven end to end against a stubbed `fetch`: the marker header reaches the
 * request, the payload becomes a usable table, and one client serves a reload.
 * The other half of the boundary - that the router core can no longer reach
 * this code at all - is remote-boundary.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isRouterError } from '../../src/router/errors';
import { createMemoryHistory } from '../../src/router/history';
import { createRouter } from '../../src/router/index';
import { bladeFetcher, routerHttp } from '../../src/router/remote';

const PAYLOAD = { routes: [{ name: 'home', path: '/', component: 'Home' }] };

const jsonResponse = () =>
  new Response(JSON.stringify(PAYLOAD), { status: 200, headers: { 'content-type': 'application/json' } });

describe('routerHttp', () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('loads a { url } route table and carries the router marker header', async () => {
    const seen: Array<{ url: string; headers: unknown }> = [];
    globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      seen.push({ url: String(url), headers: init?.headers });
      return jsonResponse();
    }) as never;

    const router = createRouter({
      history: createMemoryHistory(''),
      routes: { url: '/api/vc/routes' } as never,
      components: { Home: { name: 'Home' } },
      http: routerHttp(),
      links: false,
      scroll: false,
      onError: () => {},
    });
    await router.isReady();

    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toContain('/api/vc/routes');
    // The marker a backend uses to tell router traffic from command traffic.
    expect(JSON.stringify(seen[0]?.headers)).toContain('X-Vapor-Router');

    expect(router.currentRoute.value.location.path).toBe('/');
    expect(router.routes.value.map((r) => r.name)).toEqual(['home']);
    router.destroy();
  });

  it('serves a reload from the same client', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse()) as never;

    const router = createRouter({
      history: createMemoryHistory(''),
      routes: { url: '/api/vc/routes' } as never,
      components: { Home: { name: 'Home' } },
      http: routerHttp(),
      links: false,
      scroll: false,
      onError: () => {},
    });
    await router.isReady();
    await router.reload();

    expect((globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(2);
    router.destroy();
  });

  it('lets a caller override the marker header', async () => {
    const seen: unknown[] = [];
    globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      seen.push(init?.headers);
      return jsonResponse();
    }) as never;

    const router = createRouter({
      history: createMemoryHistory(''),
      routes: { url: '/api/vc/routes' } as never,
      components: { Home: { name: 'Home' } },
      // Caller options win over the preset marker - it is a default, not a lock.
      http: routerHttp({ headers: { 'X-Vapor-Router': '0', 'X-Tenant': 'acme' } }),
      links: false,
      scroll: false,
      onError: () => {},
    });
    await router.isReady();

    const headers = JSON.stringify(seen[0]);
    expect(headers).toContain('X-Tenant');
    expect(headers).toContain('"X-Vapor-Router":"0"');
    router.destroy();
  });
});

describe('bladeFetcher with no client of its own', () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('builds one and extracts the blade root', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response('<html><body><main><h1>Hi</h1></main><footer>skip</footer></body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
    ) as never;

    // No options at all: the zero-config path a consumer reaches for first.
    const html = await bladeFetcher()('/legacy');

    expect(html).toContain('<h1>Hi</h1>');
    expect(html).not.toContain('skip');
  });
});

describe('a { url } table with no client', () => {
  it('is a coded http_unconfigured, not a crash', async () => {
    const errors: unknown[] = [];
    const router = createRouter({
      history: createMemoryHistory(''),
      routes: { url: '/api/vc/routes' } as never,
      components: { Home: { name: 'Home' } },
      links: false,
      scroll: false,
      onError: (error) => errors.push(error),
    });
    await router.isReady().catch(() => {});

    // The router deliberately does not build a client for you; saying so with a
    // code beats a TypeError from a null dereference.
    const coded = errors.find((error) => isRouterError(error, 'http_unconfigured'));
    expect(coded).toBeDefined();
    expect(String((coded as Error).message)).toContain('router/remote');
    router.destroy();
  });
});
