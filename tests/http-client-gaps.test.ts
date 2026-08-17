/**
 * Supplemental coverage for src/http.ts — createHttpClient regions the other
 * http test files leave open:
 *
 *  - download(): content-disposition filename parsing (quoted / unquoted /
 *    absent → 'download'), the explicit-filename bypass, and the SSR guard
 *    (831 — node env has no document, so the anchor-click trigger is skipped).
 *  - safeRequest fallbacks: non-object error body → { message, code } (810),
 *    and the status chain down to 0 on a network error (811).
 *  - interceptor arms: request onFulfilled returning undefined (685), an
 *    onFulfilled throw with NO onRejected registered (686), response
 *    interceptor returning undefined (748), and a failing request with a
 *    fulfilled-only response interceptor (759 skip arm).
 *  - request() with no method → GET default (689).
 *  - stale-while-revalidate: background refresh failure absorbed (773), and
 *    serveStaleOnError with no retained entry → the error surfaces (787-791).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHttpClient, invalidateCsrfCache } from '../src/http';

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

// ---------------------------------------------------------------------------
// download (817-842)
// ---------------------------------------------------------------------------

describe('createHttpClient — download', () => {
  it('parses a quoted content-disposition filename (822-825)', async () => {
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

  it("falls back to 'download' when the header is absent (828)", async () => {
    (globalThis.fetch as any).mockResolvedValue(mockResponse(200, 'file-bytes'));
    const http = createHttpClient();

    const result = await http.download('/api/export');
    expect(result.filename).toBe('download');
  });

  it('prefers an explicit filename over the header (821)', async () => {
    (globalThis.fetch as any).mockResolvedValue(
      mockResponse(200, 'file-bytes', { 'content-disposition': 'attachment; filename=server-name.bin' }),
    );
    const http = createHttpClient();

    const result = await http.download('/api/export', 'mine.bin');
    expect(result.filename).toBe('mine.bin');
  });
});

// ---------------------------------------------------------------------------
// safeRequest fallbacks (805-813)
// ---------------------------------------------------------------------------

describe('createHttpClient — safe fallbacks', () => {
  it('wraps a non-object error body as { message, code } (810)', async () => {
    (globalThis.fetch as any).mockResolvedValue(
      mockResponse(500, 'plain text failure', { 'content-type': 'text/plain' }),
    );
    const http = createHttpClient();

    const result = await http.safe.get('/api/data', { retry: 0 });
    expect(result.data).toBeNull();
    expect(result.error).toEqual({ message: 'HTTP 500', code: undefined });
    expect(result.status).toBe(500);
  });

  it('reports status 0 on a network error with no response (811)', async () => {
    (globalThis.fetch as any).mockRejectedValue(Object.assign(new TypeError('fetch failed'), { name: 'TypeError' }));
    const http = createHttpClient();

    const result = await http.safe.get('/api/data', { retry: 0 });
    expect(result.data).toBeNull();
    expect(result.status).toBe(0);
    expect((result.error as any).message).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// interceptor arms (683-687, 745-761)
// ---------------------------------------------------------------------------

describe('createHttpClient — interceptor arms', () => {
  it('keeps the original config when a request interceptor returns undefined (685)', async () => {
    (globalThis.fetch as any).mockResolvedValue(jsonResponse(200, { ok: 1 }));
    const http = createHttpClient();
    http.interceptors.request.use(() => undefined as any);

    const res = await http.get('/api/data');
    expect(res.status).toBe(200);
  });

  it('swallows a request-interceptor throw when no onRejected is registered (686)', async () => {
    (globalThis.fetch as any).mockResolvedValue(jsonResponse(200, { ok: 1 }));
    const http = createHttpClient();
    http.interceptors.request.use(() => { throw new Error('interceptor bug'); });

    const res = await http.get('/api/data');
    expect(res.status).toBe(200);
  });

  it('keeps the original response when a response interceptor returns undefined (748)', async () => {
    (globalThis.fetch as any).mockResolvedValue(jsonResponse(200, { ok: 1 }));
    const http = createHttpClient();
    http.interceptors.response.use(() => undefined as any);

    const res = await http.get('/api/data');
    expect(res.data).toEqual({ ok: 1 });
  });

  it('skips absent onRejected handlers on failure (759)', async () => {
    (globalThis.fetch as any).mockResolvedValue(jsonResponse(500, { error: 'x' }));
    const http = createHttpClient();
    http.interceptors.response.use((r) => r); // fulfilled-only — no onRejected

    await expect(http.get('/api/data', { retry: 0 })).rejects.toMatchObject({ status: 500 });
  });

  it('request() without a method defaults to GET (689)', async () => {
    (globalThis.fetch as any).mockResolvedValue(jsonResponse(200, { ok: 1 }));
    const http = createHttpClient();

    await http.request('/api/data');
    expect((globalThis.fetch as any).mock.calls[0]![1].method).toBe('GET');
  });
});

// ---------------------------------------------------------------------------
// stale-while-revalidate + serveStaleOnError (772-793)
// ---------------------------------------------------------------------------

describe('createHttpClient — stale cache arms', () => {
  it('serves stale data and absorbs the failing background refresh (772-774)', async () => {
    vi.setSystemTime(5_000_000);
    (globalThis.fetch as any).mockResolvedValue(jsonResponse(200, { v: 1 }));
    const http = createHttpClient();

    const first = await http.get('/api/data', { retry: 0, cache: { ttl: 1000, staleTtl: 60_000 } });
    expect(first.data).toEqual({ v: 1 });

    // Entry now stale (past ttl, within staleTtl); the revalidation fetch fails.
    vi.setSystemTime(5_002_000);
    (globalThis.fetch as any).mockRejectedValue(new TypeError('network down'));

    const second = await http.get('/api/data', { retry: 0, cache: { ttl: 1000, staleTtl: 60_000 } });
    expect(second.stale).toBe(true);
    expect(second.data).toEqual({ v: 1 });
    // The background failure must not become an unhandled rejection (773);
    // the revalidation promise itself still reports it to interested callers.
    await expect(second.revalidation).rejects.toThrow();
  });

  it('surfaces the error when serveStaleOnError finds nothing retained (787-791)', async () => {
    (globalThis.fetch as any).mockRejectedValue(new TypeError('network down'));
    const http = createHttpClient();

    await expect(
      http.get('/api/never-cached', { retry: 0, cache: { serveStaleOnError: true } }),
    ).rejects.toThrow();
  });
});
