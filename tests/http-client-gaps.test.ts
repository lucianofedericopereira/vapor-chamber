/**
 * createHttpClient edge cases: download(), safe fallbacks, interceptor arms, request() default method, stale cache arms.
 * Why: a wrong filename, a thrown interceptor bug, a missing method or an unhandled background refresh failure would break a user's download, request or cached read. Also the only file reaching download()'s filename arms, the interceptor arms without a return or onRejected, request()'s default method and the stale-error arm with nothing retained, so the 100% floor needs it.
 * Shows: download() reads a quoted, unquoted or absent content-disposition filename ('download') and prefers an explicit one; safe.get turns a non-problem body into { status, detail } and a network error into status 0 with transport:lost:reply; interceptors returning undefined keep the original config or response, a request-interceptor throw without onRejected is swallowed, and a response interceptor without onRejected is skipped on failure; request() defaults to GET; a failing background refresh is absorbed while stale data is served, and serveStaleOnError with nothing retained surfaces the error.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHttpClient, invalidateCsrfCache } from '../src/http';
import { problemOf } from '../src/http-errors';

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
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    blob: async () => new Blob([typeof body === 'string' ? body : JSON.stringify(body)]),
  };
}

function jsonResponse(status: number, body: unknown) {
  return mockResponse(status, body, { 'content-type': 'application/json' });
}

beforeEach(() => {
  invalidateCsrfCache();
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  invalidateCsrfCache();
});

describe('createHttpClient - download', () => {
  it('parses a quoted content-disposition filename', async () => {
    (globalThis.fetch as any).mockResolvedValue(
      mockResponse(200, 'file-bytes', { 'content-disposition': 'attachment; filename="report Q3.pdf"' }),
    );
    const http = createHttpClient();

    const result = await http.download('/api/export');
    expect(result.filename).toBe('report Q3.pdf');
    expect(result.status).toBe(200);
  });

  it('parses an unquoted filename', async () => {
    (globalThis.fetch as any).mockResolvedValue(
      mockResponse(200, 'file-bytes', { 'content-disposition': 'attachment; filename=export.csv' }),
    );
    const http = createHttpClient();

    const result = await http.download('/api/export');
    expect(result.filename).toBe('export.csv');
  });

  it("falls back to 'download' when the header is absent", async () => {
    (globalThis.fetch as any).mockResolvedValue(mockResponse(200, 'file-bytes'));
    const http = createHttpClient();

    const result = await http.download('/api/export');
    expect(result.filename).toBe('download');
  });

  it('prefers an explicit filename over the header', async () => {
    (globalThis.fetch as any).mockResolvedValue(
      mockResponse(200, 'file-bytes', { 'content-disposition': 'attachment; filename=server-name.bin' }),
    );
    const http = createHttpClient();

    const result = await http.download('/api/export', 'mine.bin');
    expect(result.filename).toBe('mine.bin');
  });
});

describe('createHttpClient - safe fallbacks', () => {
  it('a body that is not a problem reads as { status, detail: HTTP <status> }', async () => {
    (globalThis.fetch as any).mockResolvedValue(
      mockResponse(500, 'plain text failure', { 'content-type': 'text/plain' }),
    );
    const http = createHttpClient();

    const result = await http.safe.get('/api/data', { retry: false });
    expect(result.data).toBeNull();
    expect(result.error?.code).toBe('remote:failed:http');
    expect(problemOf(result.error)).toEqual({ status: 500, detail: 'HTTP 500' });
    expect(result.status).toBe(500);
  });

  it('with no response, status 0, transport:lost:reply and no problem', async () => {
    (globalThis.fetch as any).mockRejectedValue(Object.assign(new TypeError('fetch failed'), { name: 'TypeError' }));
    const http = createHttpClient();

    const result = await http.safe.get('/api/data', { retry: false });
    expect(result.data).toBeNull();
    expect(result.status).toBe(0);
    expect(result.error?.code).toBe('transport:lost:reply');
    expect(problemOf(result.error)).toBeUndefined();
  });
});

describe('createHttpClient - interceptor arms', () => {
  it('keeps the original config when a request interceptor returns undefined', async () => {
    (globalThis.fetch as any).mockResolvedValue(jsonResponse(200, { ok: 1 }));
    const http = createHttpClient();
    http.interceptors.request.use(() => undefined as any);

    const res = await http.get('/api/data');
    expect(res.status).toBe(200);
  });

  it('swallows a request-interceptor throw when no onRejected is registered', async () => {
    (globalThis.fetch as any).mockResolvedValue(jsonResponse(200, { ok: 1 }));
    const http = createHttpClient();
    http.interceptors.request.use(() => { throw new Error('interceptor bug'); });

    const res = await http.get('/api/data');
    expect(res.status).toBe(200);
  });

  it('keeps the original response when a response interceptor returns undefined', async () => {
    (globalThis.fetch as any).mockResolvedValue(jsonResponse(200, { ok: 1 }));
    const http = createHttpClient();
    http.interceptors.response.use(() => undefined as any);

    const res = await http.get('/api/data');
    expect(res.data).toEqual({ ok: 1 });
  });

  it('skips absent onRejected handlers on failure', async () => {
    (globalThis.fetch as any).mockResolvedValue(jsonResponse(500, { error: 'x' }));
    const http = createHttpClient();
    http.interceptors.response.use((r) => r);

    await expect(http.get('/api/data', { retry: false })).rejects.toMatchObject({ context: { status: 500 } });
  });

  it('request() without a method defaults to GET', async () => {
    (globalThis.fetch as any).mockResolvedValue(jsonResponse(200, { ok: 1 }));
    const http = createHttpClient();

    await http.request('/api/data');
    expect((globalThis.fetch as any).mock.calls[0]![1].method).toBe('GET');
  });
});

describe('createHttpClient - stale cache arms', () => {
  it('serves stale data and absorbs the failing background refresh', async () => {
    vi.setSystemTime(5_000_000);
    (globalThis.fetch as any).mockResolvedValue(jsonResponse(200, { v: 1 }));
    const http = createHttpClient();

    const first = await http.get('/api/data', { retry: false, cache: { ttl: 1000, staleTtl: 60_000 } });
    expect(first.data).toEqual({ v: 1 });

    // Past ttl, within staleTtl: the entry is stale and the revalidation fetch fails.
    vi.setSystemTime(5_002_000);
    (globalThis.fetch as any).mockRejectedValue(new TypeError('network down'));

    const second = await http.get('/api/data', { retry: false, cache: { ttl: 1000, staleTtl: 60_000 } });
    expect(second.stale).toBe(true);
    expect(second.data).toEqual({ v: 1 });
    // The background failure is not an unhandled rejection; the revalidation promise still reports it.
    await expect(second.revalidation).rejects.toThrow();
  });

  it('surfaces the error when serveStaleOnError finds nothing retained', async () => {
    (globalThis.fetch as any).mockRejectedValue(new TypeError('network down'));
    const http = createHttpClient();

    await expect(
      http.get('/api/never-cached', { retry: false, cache: { serveStaleOnError: true } }),
    ).rejects.toThrow();
  });
});
