// @vitest-environment happy-dom
/**
 * Fallback arms of http and form that ordinary conditions take: no CSRF token, an empty body, no filename, onRejected-only interceptors, a falsy rule.
 * Why: coverage: without this file form.ts's falsy-rule skips and four http.ts branches go uncovered; each is a normal production condition, not an exotic one.
 * Shows: no CSRF header without a token; an empty body is null data; a nameless download is 'download'; a long Retry-After ends the request; such interceptors and a re-eject are skipped.
 * See: tests/retry-after-long.test.ts.
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
    // 7 days: not slept inside a request, nor cut short to a backoff (Retry-After is a minimum).
    fetchMock
      .mockResolvedValueOnce(mockResponse(429, { e: 1 }, { 'content-type': 'application/json', 'retry-after': '604800' }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    const started = Date.now();
    await expect(createHttpClient().get('/api/data', { retry: { maxAttempts: 2 } })).rejects.toMatchObject({ context: { status: 429 } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

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
