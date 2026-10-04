/** problemOf(error): the backend's RFC 9457 problem, read through the cause chain once (plan 8d.2, log s35.121). */
import { afterEach, describe, expect, vi } from 'vitest';
import { createAsyncCommandBus, problemOf } from '../src/index';
import { createHttpClient } from '../src/http';
import { createHttpBridge } from '../src/transports';
import { fetchLoaders } from '../src/router-fetch/index';
import { it } from '../src/vitest';
import { ROWS, makeRouter } from './router/fixture';

afterEach(() => { vi.unstubAllGlobals(); });

const problemResponse = (status: number, body: unknown) => ({
  ok: false, status, statusText: 'x',
  headers: new Headers({ 'content-type': 'application/problem+json' }),
  json: async () => body, text: async () => JSON.stringify(body), clone() { return this; },
});

describe('problemOf', () => {
  it("reads a loader failure's backend problem through the router failure's cause", async () => {
    vi.stubGlobal('fetch', vi.fn(async () => problemResponse(404, { status: 404, code: 'order_not_found', detail: 'No such order', id: 7 })));
    const routes = [...ROWS, { name: 'order', path: '/order', parent: 'shell', component: 'Home', load: '/api/order' }];
    const router = makeRouter({ routes, loaders: fetchLoaders({ http: createHttpClient({ retry: 0 }) }), links: false, announce: false, onError: () => {} });
    await router.start();
    const error = await router.push('/order');
    expect(error?.code).toBe('router:failed:loader');
    expect(problemOf(error)).toEqual({ status: 404, code: 'order_not_found', detail: 'No such order', id: 7 });
    router.destroy();
  });

  it("reads a bridge's remote failure", async () => {
    vi.stubGlobal('fetch', vi.fn(async () => problemResponse(409, { status: 409, code: 'stale', detail: 'Changed meanwhile', version: 3 })));
    const bus = createAsyncCommandBus({ retry: false });
    bus.use(createHttpBridge({ endpoint: '/api/vc' }));
    const result = await bus.dispatch('orderSave', {});
    expect(problemOf(result.error)).toEqual({ status: 409, code: 'stale', detail: 'Changed meanwhile', version: 3 });
  });

  it('a non-problem body is the status and HTTP <status>, as the safe helpers read it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => problemResponse(502, 'bad gateway')));
    const http = createHttpClient({ retry: 0 });
    const error = await http.get('/x').then(() => null, (e: unknown) => e);
    expect(problemOf(error)).toEqual({ status: 502, detail: 'HTTP 502' });
    expect(problemOf((await http.safe.get('/x')).error)).toEqual(problemOf(error));
  });

  it('undefined when no backend answered, and for anything else; a cyclic cause chain ends', () => {
    expect(problemOf(new Error('local'))).toBeUndefined();
    expect(problemOf(undefined)).toBeUndefined();
    const a = new Error('a') as Error & { cause?: unknown };
    const b = new Error('b', { cause: a });
    a.cause = b;
    expect(problemOf(a)).toBeUndefined();
  });
});
