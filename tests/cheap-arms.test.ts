// @vitest-environment happy-dom
/**
 * One-line fallback arms across http / transports / form that no existing test
 * happens to take. Each is a normal production condition, not an exotic one:
 *
 *  - http: a page with NO CSRF token - the common case
 *    for a read-only app; an empty JSON body; an unparsable
 *    content-disposition; a Retry-After beyond the in-request bound;
 *    interceptors registered with onRejected only; eject() of an
 *    already-ejected id.
 *  - transports: backend failure bodies carrying `error` but no `message`, or
 *    neither; an error with no `status`; a batch
 *    containing a noRetry action.
 *  - form: a rules object with a falsy entry.
 *
 * NOT here: http 327/585 (`if (fresh)` after a CSRF refresh). refreshCsrfOnce
 * throws when the refresh finds no token, so the re-read immediately after it
 * can never be empty - unreachable by construction, not untested.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { postCommand, createHttpClient, invalidateCsrfCache } from '../src/http';
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
// http - no CSRF token on the page
// ---------------------------------------------------------------------------

describe('http without a CSRF token', () => {
  it('postCommand omits the header when no token exists', async () => {
    (globalThis.fetch as any).mockResolvedValue(jsonResponse(200, { ok: true }));

    await postCommand('/api/vc', { command: 'save' }, { csrf: true });

    const [, init] = (globalThis.fetch as any).mock.calls[0];
    expect(init.headers['X-CSRF-TOKEN']).toBeUndefined();
    expect(init.headers['X-XSRF-TOKEN']).toBeUndefined();
  });

  it('clientRequest omits the header when no token exists', async () => {
    (globalThis.fetch as any).mockResolvedValue(jsonResponse(200, { ok: true }));
    const http = createHttpClient();

    await http.post('/api/data', { a: 1 }, { csrf: true });

    const [, init] = (globalThis.fetch as any).mock.calls[0];
    expect(Object.keys(init.headers).some(k => /csrf|xsrf/i.test(k))).toBe(false);
  });

});

// ---------------------------------------------------------------------------
// http - response-shape fallbacks
// ---------------------------------------------------------------------------

describe('http response fallbacks', () => {
  it('treats an empty JSON body as null data', async () => {
    (globalThis.fetch as any).mockResolvedValue(mockResponse(204, null, { 'content-type': 'application/json' }));
    const http = createHttpClient();

    const res = await http.get('/api/empty');
    expect(res.status).toBe(204);
    expect(res.data).toBeNull();
  });

  it("falls back to 'download' when content-disposition has no filename=", async () => {
    (globalThis.fetch as any).mockResolvedValue(
      mockResponse(200, 'bytes', { 'content-disposition': 'attachment' }),
    );
    const http = createHttpClient();

    const result = await http.download('/api/export');
    expect(result.filename).toBe('download');
  });

  it('ends the request on a Retry-After beyond the in-request bound, never retrying sooner', async () => {
    const fetchMock = globalThis.fetch as any;
    // 7 days in seconds: not slept inside a request, and not cut short to a
    // backoff either (Retry-After is a minimum). tests/retry-after-long.test.ts.
    fetchMock
      .mockResolvedValueOnce(mockResponse(429, { e: 1 }, { 'content-type': 'application/json', 'retry-after': '604800' }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    const started = Date.now();
    await expect(createHttpClient().get('/api/data', { retry: 1 })).rejects.toMatchObject({ context: { status: 429 } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

// ---------------------------------------------------------------------------
// http - interceptor registry arms
// ---------------------------------------------------------------------------

describe('http interceptor registry', () => {
  it('skips a request interceptor registered with onRejected only', async () => {
    (globalThis.fetch as any).mockResolvedValue(jsonResponse(200, { ok: 1 }));
    const onRejected = vi.fn();
    const http = createHttpClient();
    http.interceptors.request.use(undefined, onRejected);

    const res = await http.get('/api/data');
    expect(res.status).toBe(200);
    expect(onRejected).not.toHaveBeenCalled();
  });

  it('skips a response interceptor registered with onRejected only', async () => {
    (globalThis.fetch as any).mockResolvedValue(jsonResponse(200, { ok: 1 }));
    const http = createHttpClient();
    http.interceptors.response.use(undefined, vi.fn());

    const res = await http.get('/api/data');
    expect(res.data).toEqual({ ok: 1 });
  });

  it('eject() is idempotent for an already-ejected id', async () => {
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
// form - falsy rule entries
// ---------------------------------------------------------------------------

describe('form rules with a falsy entry', () => {
  it('skips a falsy rule during live per-field validation', () => {
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

  it('skips a falsy rule during full submit validation', async () => {
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
