// @vitest-environment happy-dom
/** A read answers plain JSON: the routes table is the bare payload, a failure a non-2xx problem. Log s35.115. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isRouterError } from '@router/errors';
import { readRoutesPayload } from '@router/index';
import { makeRouter, ROWS } from './fixture';

afterEach(() => { document.body.innerHTML = ''; });

const table = { routes: ROWS, base: '/admin' };

describe('readRoutesPayload', () => {
  it('reads the bare payload', () => {
    expect(readRoutesPayload(table)).toBe(table);
  });

  it('an envelope is off-protocol: { state } and a 2xx { problem } are router:unexpected:routes', () => {
    for (const body of [{ state: table }, { problem: { status: 403, code: 'forbidden', detail: 'Not yours' } }]) {
      let error: unknown;
      try { readRoutesPayload(body); } catch (e) { error = e; }
      expect(isRouterError(error, 'router:unexpected:routes')).toBe(true);
    }
  });
});

describe('the { url } table', () => {
  it('a 2xx { state } answer fails start() as router:unexpected:routes', async () => {
    const http = { get: vi.fn().mockResolvedValue({ data: { state: table } }) } as never;
    const router = makeRouter({ routes: { url: '/routes.json' } as never, components: {}, http, links: false, announce: false, onError: () => {} });
    const error = await router.isReady().then(() => null, (e: unknown) => e);
    expect(isRouterError(error, 'router:unexpected:routes')).toBe(true);
    router.dispose();
  });

  it('a non-2xx problem is router:failed:routes, the client error (with the problem) its cause', async () => {
    const problem = { status: 503, code: 'maintenance', detail: 'Back soon' };
    const clientError = Object.assign(new Error('HTTP 503'), { response: { status: 503, data: problem } });
    const http = { get: vi.fn().mockRejectedValue(clientError) } as never;
    const router = makeRouter({ routes: { url: '/routes.json' } as never, components: {}, http, links: false, announce: false, onError: () => {} });
    const error = await router.isReady().then(() => null, (e: unknown) => e);
    expect(isRouterError(error, 'router:failed:routes')).toBe(true);
    expect((error as Error).cause).toBe(clientError);
    router.dispose();
  });
});

describe('the inline table', () => {
  it('an inline { state } is router:unexpected:routes', async () => {
    const el = document.createElement('script');
    el.id = 'vcr-routes';
    el.type = 'application/json';
    el.textContent = JSON.stringify({ state: table });
    document.body.appendChild(el);
    const router = makeRouter({ routes: { inline: '#vcr-routes' } as never, links: false, announce: false, onError: () => {} });
    const error = await router.start().then(() => null, (e: unknown) => e);
    expect(isRouterError(error, 'router:unexpected:routes')).toBe(true);
    router.dispose();
  });
});
