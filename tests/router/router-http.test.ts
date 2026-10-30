// @vitest-environment happy-dom
/**
 * `routerHttp()`, the router's HTTP client in `vapor-chamber/router/remote`, and `bladeFetcher()` without a client.
 * Why: other suites inject a stub client, so a broken real client would reach users unnoticed: the backend could not tell router traffic from command traffic, and a `{ url }` table with no client would crash instead of failing with a code.
 * Shows: against a stubbed `fetch`, the marker header reaches the request, the payload becomes the route table, one client serves a reload, a caller header overrides the marker, `bladeFetcher()` builds its own client and extracts the blade root, and a `{ url }` table with no client reports `router:missing:http`.
 * See: remote-boundary.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isRouterError } from '@router/errors';
import { createMemoryHistory } from '@router/history';
import { bladeFetcher, routerHttp } from '@router/remote';
import { makeRouter } from './fixture';

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

    const router = makeRouter({
      history: createMemoryHistory(''),
      routes: { url: '/api/vc/routes' } as never,
      components: { Home: { name: 'Home' } },
      http: routerHttp(),
      links: false,
      onError: () => {},
    });
    await router.isReady();

    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toContain('/api/vc/routes');
    // The marker lets a backend tell router traffic from command traffic.
    expect(JSON.stringify(seen[0]?.headers)).toContain('X-Vapor-Router');

    expect(router.currentRoute.value.location.path).toBe('/');
    expect(router.routes.value.map((r) => r.name)).toEqual(['home']);
    router.dispose();
  });

  it('serves a reload from the same client', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse()) as never;

    const router = makeRouter({
      history: createMemoryHistory(''),
      routes: { url: '/api/vc/routes' } as never,
      components: { Home: { name: 'Home' } },
      http: routerHttp(),
      links: false,
      onError: () => {},
    });
    await router.isReady();
    await router.reload();

    expect((globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(2);
    router.dispose();
  });

  it('lets a caller override the marker header', async () => {
    const seen: unknown[] = [];
    globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      seen.push(init?.headers);
      return jsonResponse();
    }) as never;

    const router = makeRouter({
      history: createMemoryHistory(''),
      routes: { url: '/api/vc/routes' } as never,
      components: { Home: { name: 'Home' } },
      // Caller headers win over the preset marker.
      http: routerHttp({ headers: { 'X-Vapor-Router': '0', 'X-Tenant': 'acme' } }),
      links: false,
      onError: () => {},
    });
    await router.isReady();

    const headers = JSON.stringify(seen[0]);
    expect(headers).toContain('X-Tenant');
    expect(headers).toContain('"X-Vapor-Router":"0"');
    router.dispose();
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

    // No options at all: the zero-config path.
    const html = await bladeFetcher()('/legacy');

    expect(html).toContain('<h1>Hi</h1>');
    expect(html).not.toContain('skip');
  });
});

describe('a { url } table with no client', () => {
  it('is a coded router:missing:http, not a crash', async () => {
    const errors: unknown[] = [];
    const router = makeRouter({
      history: createMemoryHistory(''),
      routes: { url: '/api/vc/routes' } as never,
      components: { Home: { name: 'Home' } },
      links: false,
      onError: (error) => errors.push(error),
    });
    await router.isReady().catch(() => {});

    // The router never builds a client; a code replaces a TypeError.
    const coded = errors.find((error) => isRouterError(error, 'router:missing:http'));
    expect(coded).toBeDefined();
    expect(String((coded as Error).message)).toContain('router/remote');
    router.dispose();
  });
});
