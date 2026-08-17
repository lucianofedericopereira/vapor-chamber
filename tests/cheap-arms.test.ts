// @vitest-environment happy-dom
/**
 * One-line fallback arms across http / transports / form that no existing test
 * happens to take. Each is a normal production condition, not an exotic one:
 *
 *  - http: a page with NO CSRF token (300, 561) — the common case
 *    for a read-only app; an empty JSON body (534); an unparsable
 *    content-disposition (825); a Retry-After beyond the sanity ceiling (181);
 *    interceptors registered with onRejected only (685, 748); eject() of an
 *    already-ejected id (480).
 *  - transports: backend failure bodies carrying `error` but no `message`, or
 *    neither (202, 207, 344, 354); an error with no `status` (222); a batch
 *    containing a noRetry action (314).
 *  - form: a rules object with a falsy entry (112, 132).
 *
 * NOT here: http 327/585 (`if (fresh)` after a CSRF refresh). refreshCsrfOnce
 * throws when the refresh finds no token, so the re-read immediately after it
 * can never be empty — unreachable by construction, not untested.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { postCommand, createHttpClient, invalidateCsrfCache } from '../src/http';
import { createHttpBridge, createBatchingHttpBridge } from '../src/transports';
import { createAsyncCommandBus } from '../src/index';
import { createFormBus } from '../src/form';

function mockResponse(status: number, body: unknown = null, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: {
      entries: () => Object.entries(headers),
      get: (k: string) => headers[k.toLowerCase()] ?? null,
    },
    json: async () => body,
    text: async () => (body === null ? '' : typeof body === 'string' ? body : JSON.stringify(body)),
    blob: async () => new Blob([typeof body === 'string' ? body : JSON.stringify(body)]),
  };
}

const jsonResponse = (status: number, body: unknown) =>
  mockResponse(status, body, { 'content-type': 'application/json' });

beforeEach(() => {
  invalidateCsrfCache();
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  invalidateCsrfCache();
  document.head.innerHTML = '';
});

// ---------------------------------------------------------------------------
// http — no CSRF token on the page (300, 327, 561, 585)
// ---------------------------------------------------------------------------

describe('http without a CSRF token', () => {
  it('postCommand omits the header when no token exists (300)', async () => {
    (globalThis.fetch as any).mockResolvedValue(jsonResponse(200, { ok: true }));

    await postCommand('/api/vc', { command: 'save' }, { csrf: true });

    const [, init] = (globalThis.fetch as any).mock.calls[0];
    expect(init.headers['X-CSRF-TOKEN']).toBeUndefined();
    expect(init.headers['X-XSRF-TOKEN']).toBeUndefined();
  });

  it('clientRequest omits the header when no token exists (561)', async () => {
    (globalThis.fetch as any).mockResolvedValue(jsonResponse(200, { ok: true }));
    const http = createHttpClient();

    await http.post('/api/data', { a: 1 }, { csrf: true });

    const [, init] = (globalThis.fetch as any).mock.calls[0];
    expect(Object.keys(init.headers).some(k => /csrf|xsrf/i.test(k))).toBe(false);
  });

});

// ---------------------------------------------------------------------------
// http — response-shape fallbacks
// ---------------------------------------------------------------------------

describe('http response fallbacks', () => {
  it('treats an empty JSON body as null data (534)', async () => {
    (globalThis.fetch as any).mockResolvedValue(mockResponse(204, null, { 'content-type': 'application/json' }));
    const http = createHttpClient();

    const res = await http.get('/api/empty');
    expect(res.status).toBe(204);
    expect(res.data).toBeNull();
  });

  it("falls back to 'download' when content-disposition has no filename= (825)", async () => {
    (globalThis.fetch as any).mockResolvedValue(
      mockResponse(200, 'bytes', { 'content-disposition': 'attachment' }),
    );
    const http = createHttpClient();

    const result = await http.download('/api/export');
    expect(result.filename).toBe('download');
  });

  it('ignores a Retry-After beyond the sanity ceiling (181)', async () => {
    const fetchMock = globalThis.fetch as any;
    // 7 days in seconds — must NOT be honoured as a wait; backoff applies.
    fetchMock
      .mockResolvedValueOnce(mockResponse(429, { e: 1 }, { 'content-type': 'application/json', 'retry-after': '604800' }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    const started = Date.now();
    const res = await createHttpClient().get('/api/data', { retry: 1 });
    expect(res.status).toBe(200);
    // Backoff, not a week.
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

// ---------------------------------------------------------------------------
// http — interceptor registry arms (480, 685, 748)
// ---------------------------------------------------------------------------

describe('http interceptor registry', () => {
  it('skips a request interceptor registered with onRejected only (685)', async () => {
    (globalThis.fetch as any).mockResolvedValue(jsonResponse(200, { ok: 1 }));
    const onRejected = vi.fn();
    const http = createHttpClient();
    http.interceptors.request.use(undefined, onRejected);

    const res = await http.get('/api/data');
    expect(res.status).toBe(200);
    expect(onRejected).not.toHaveBeenCalled();
  });

  it('skips a response interceptor registered with onRejected only (748)', async () => {
    (globalThis.fetch as any).mockResolvedValue(jsonResponse(200, { ok: 1 }));
    const http = createHttpClient();
    http.interceptors.response.use(undefined, vi.fn());

    const res = await http.get('/api/data');
    expect(res.data).toEqual({ ok: 1 });
  });

  it('eject() is idempotent for an already-ejected id (480)', async () => {
    (globalThis.fetch as any).mockResolvedValue(jsonResponse(200, { ok: 1 }));
    const http = createHttpClient();
    const onFulfilled = vi.fn((c: any) => c);
    const id = http.interceptors.request.use(onFulfilled);

    http.interceptors.request.eject(id);
    http.interceptors.request.eject(id); // second eject finds a null slot

    await http.get('/api/data');
    expect(onFulfilled).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// transports — error-body fallbacks (202, 207, 222, 314, 344, 354)
// ---------------------------------------------------------------------------

describe('transport error-body fallbacks', () => {
  it('falls back to the HTTP status when the body has neither message nor error (202)', async () => {
    const httpClient = { post: vi.fn().mockResolvedValue({ ok: false, status: 503, headers: {}, data: {} }) } as any;
    const bus = createAsyncCommandBus();
    bus.use(createHttpBridge({ endpoint: '/api/vc', httpClient }));

    const result = await bus.dispatch('save', {});
    expect(result.error?.message).toBe('HTTP 503');
  });

  it("falls back to 'Backend error' when ok:false carries no error string (207)", async () => {
    const httpClient = { post: vi.fn().mockResolvedValue({ ok: true, status: 200, headers: {}, data: { ok: false } }) } as any;
    const bus = createAsyncCommandBus();
    bus.use(createHttpBridge({ endpoint: '/api/vc', httpClient }));

    const result = await bus.dispatch('save', {});
    expect(result.error?.message).toBe('Backend error');
  });

  it('rewraps an error that carries no status (222)', async () => {
    const thrown = Object.assign(new Error('nope'), { response: { data: { error: 'bad input' } } });
    const httpClient = { post: vi.fn().mockRejectedValue(thrown) } as any;
    const bus = createAsyncCommandBus();
    bus.use(createHttpBridge({ endpoint: '/api/vc', httpClient }));

    const result = await bus.dispatch('save', {});
    const err = result.error as Error & { status?: number };
    expect(err.message).toBe('bad input');
    expect(err.status).toBeUndefined();
  });

  it("batch: falls back to 'Backend error' for a result with no error string (344)", async () => {
    const httpClient = {
      post: vi.fn().mockImplementation((_u, body: any) => Promise.resolve({
        ok: true, status: 200, headers: {},
        data: { results: body.commands.map((c: any) => ({ id: c.id, ok: false })) },
      })),
    } as any;
    const bus = createAsyncCommandBus();
    bus.use(createBatchingHttpBridge({ endpoint: '/api/vc/batch', httpClient }));

    const result = await bus.dispatch('save', {});
    expect(result.error?.message).toBe('Backend error');
  });

  it('batch: surfaces the raw error when the body has no message (354)', async () => {
    const thrown = Object.assign(new Error('transport died'), { response: { data: {} } });
    const httpClient = { post: vi.fn().mockRejectedValue(thrown) } as any;
    const bus = createAsyncCommandBus();
    bus.use(createBatchingHttpBridge({ endpoint: '/api/vc/batch', httpClient }));

    const result = await bus.dispatch('save', {});
    expect(result.error).toBe(thrown);
  });

  it('batch: a noRetry action forces retry 0 for the whole batch (314)', async () => {
    const httpClient = {
      post: vi.fn().mockImplementation((_u, body: any) => Promise.resolve({
        ok: true, status: 200, headers: {},
        data: { results: body.commands.map((c: any) => ({ id: c.id, ok: true, state: 1 })) },
      })),
    } as any;
    const bus = createAsyncCommandBus();
    bus.use(createBatchingHttpBridge({ endpoint: '/api/vc/batch', httpClient, retry: 3, noRetry: ['pay'] }));

    await Promise.all([bus.dispatch('pay', {}), bus.dispatch('look', {})]);
    // One batch containing a non-retryable command → retry budget 0 for all.
    expect(httpClient.post.mock.calls[0]![2].retry).toBe(0);
  });

  it('keeps the configured retry when no batched action is on the noRetry list (314)', async () => {
    const httpClient = {
      post: vi.fn().mockImplementation((_u, body: any) => Promise.resolve({
        ok: true, status: 200, headers: {},
        data: { results: body.commands.map((c: any) => ({ id: c.id, ok: true })) },
      })),
    } as any;
    const bus = createAsyncCommandBus();
    bus.use(createBatchingHttpBridge({ endpoint: '/api/vc/batch', httpClient, retry: 3, noRetry: ['pay'] }));

    await bus.dispatch('look', {});
    expect(httpClient.post.mock.calls[0]![2].retry).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// form — falsy rule entries (112, 132)
// ---------------------------------------------------------------------------

describe('form rules with a falsy entry', () => {
  it('skips a falsy rule during live per-field validation (112)', () => {
    const form = createFormBus({
      fields: { email: 'a@b.com', name: 'Ada' },
      rules: { email: null as any, name: (v: string) => (v ? null : 'required') },
      onSubmit: async () => {},
    });

    form.set('email', 'still-fine');   // null rule must be skipped, not called
    expect(form.errors.value.email).toBeUndefined();

    form.set('name', '');
    expect(form.errors.value.name).toBe('required');
  });

  it('skips a falsy rule during full submit validation (132)', async () => {
    const onSubmit = vi.fn(async () => {});
    const form = createFormBus({
      fields: { email: 'a@b.com', name: '' },
      rules: { email: null as any, name: (v: string) => (v ? null : 'required') },
      onSubmit,
    });

    expect(await form.submit()).toBe(false);
    expect(form.errors.value.email).toBeUndefined();
    expect(form.errors.value.name).toBe('required');
    expect(onSubmit).not.toHaveBeenCalled();

    form.set('name', 'Ada');
    expect(await form.submit()).toBe(true);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});
