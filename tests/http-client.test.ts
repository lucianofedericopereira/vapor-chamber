/**
 * Tests for createHttpClient — multi-method HTTP client
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHttpClient } from '../src/http';
import { clearAllCache } from '../src/http-cache';

// ---------------------------------------------------------------------------
// Fetch mock helpers
// ---------------------------------------------------------------------------

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
    blob: async () => new Blob([JSON.stringify(body)]),
  };
}

function jsonResponse(status: number, body: unknown) {
  return mockResponse(status, body, { 'content-type': 'application/json' });
}

beforeEach(() => {
  clearAllCache();
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// HTTP methods
// ---------------------------------------------------------------------------

describe('createHttpClient — methods', () => {
  it('get() sends GET request', async () => {
    (globalThis.fetch as any).mockResolvedValue(jsonResponse(200, { users: [] }));
    const http = createHttpClient();

    const res = await http.get('/api/users');
    expect(res.ok).toBe(true);
    expect(res.data).toEqual({ users: [] });

    const [, init] = (globalThis.fetch as any).mock.calls[0];
    expect(init.method).toBe('GET');
  });

  it('post() sends POST with body', async () => {
    (globalThis.fetch as any).mockResolvedValue(jsonResponse(201, { id: 1 }));
    const http = createHttpClient();

    const res = await http.post('/api/users', { name: 'Alice' });
    expect(res.status).toBe(201);

    const [, init] = (globalThis.fetch as any).mock.calls[0];
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ name: 'Alice' }));
  });

  it('put() sends PUT with body', async () => {
    (globalThis.fetch as any).mockResolvedValue(jsonResponse(200, { ok: true }));
    const http = createHttpClient();

    await http.put('/api/users/1', { name: 'Bob' });

    const [, init] = (globalThis.fetch as any).mock.calls[0];
    expect(init.method).toBe('PUT');
    expect(init.body).toBe(JSON.stringify({ name: 'Bob' }));
  });

  it('patch() sends PATCH with body', async () => {
    (globalThis.fetch as any).mockResolvedValue(jsonResponse(200, {}));
    const http = createHttpClient();

    await http.patch('/api/users/1', { name: 'Carol' });

    const [, init] = (globalThis.fetch as any).mock.calls[0];
    expect(init.method).toBe('PATCH');
  });

  it('delete() sends DELETE without body', async () => {
    (globalThis.fetch as any).mockResolvedValue(jsonResponse(200, {}));
    const http = createHttpClient();

    await http.delete('/api/users/1');

    const [, init] = (globalThis.fetch as any).mock.calls[0];
    expect(init.method).toBe('DELETE');
    expect(init.body).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Body handling
// ---------------------------------------------------------------------------

describe('createHttpClient — body', () => {
  it('auto-serializes objects as JSON with Content-Type', async () => {
    (globalThis.fetch as any).mockResolvedValue(jsonResponse(200, {}));
    const http = createHttpClient();

    await http.post('/api', { key: 'value' });

    const [, init] = (globalThis.fetch as any).mock.calls[0];
    expect(init.body).toBe('{"key":"value"}');
    expect(init.headers['Content-Type']).toBe('application/json');
  });

  it('FormData passes through without Content-Type', async () => {
    (globalThis.fetch as any).mockResolvedValue(jsonResponse(200, {}));
    const http = createHttpClient();
    const form = new FormData();
    form.append('file', 'data');

    await http.post('/api/upload', form);

    const [, init] = (globalThis.fetch as any).mock.calls[0];
    expect(init.body).toBe(form);
    expect(init.headers['Content-Type']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Query params
// ---------------------------------------------------------------------------

describe('createHttpClient — query params', () => {
  it('appends scalar params to URL', async () => {
    (globalThis.fetch as any).mockResolvedValue(jsonResponse(200, []));
    const http = createHttpClient();

    await http.get('/api/users', { params: { page: 1, limit: 10 } });

    const [url] = (globalThis.fetch as any).mock.calls[0];
    expect(url).toContain('page=1');
    expect(url).toContain('limit=10');
  });

  it('handles array params', async () => {
    (globalThis.fetch as any).mockResolvedValue(jsonResponse(200, []));
    const http = createHttpClient();

    await http.get('/api/search', { params: { ids: [1, 2, 3] } });

    const [url] = (globalThis.fetch as any).mock.calls[0];
    expect(url).toContain('ids%5B0%5D=1');
    expect(url).toContain('ids%5B1%5D=2');
  });

  it('filters null/undefined params', async () => {
    (globalThis.fetch as any).mockResolvedValue(jsonResponse(200, []));
    const http = createHttpClient();

    await http.get('/api/users', { params: { page: 1, filter: undefined, sort: null } });

    const [url] = (globalThis.fetch as any).mock.calls[0];
    expect(url).toContain('page=1');
    expect(url).not.toContain('filter');
    expect(url).not.toContain('sort');
  });
});

// ---------------------------------------------------------------------------
// BaseURL
// ---------------------------------------------------------------------------

describe('createHttpClient — baseURL', () => {
  it('prepends baseURL to relative paths', async () => {
    (globalThis.fetch as any).mockResolvedValue(jsonResponse(200, {}));
    const http = createHttpClient({ baseURL: 'https://api.example.com' });

    await http.get('/users');

    const [url] = (globalThis.fetch as any).mock.calls[0];
    expect(url).toBe('https://api.example.com/users');
  });

  it('does not modify absolute URLs', async () => {
    (globalThis.fetch as any).mockResolvedValue(jsonResponse(200, {}));
    const http = createHttpClient({ baseURL: 'https://api.example.com' });

    await http.get('https://other.com/data');

    const [url] = (globalThis.fetch as any).mock.calls[0];
    expect(url).toBe('https://other.com/data');
  });
});

// ---------------------------------------------------------------------------
// Retry
// ---------------------------------------------------------------------------

describe('createHttpClient — retry', () => {
  it('GET retries on 500 (default retry: 2)', async () => {
    let attempts = 0;
    (globalThis.fetch as any).mockImplementation(async () => {
      attempts++;
      if (attempts < 3) return jsonResponse(500, { error: 'server' });
      return jsonResponse(200, { ok: true });
    });

    const http = createHttpClient();
    const res = await http.get('/api/data');

    expect(res.ok).toBe(true);
    expect(attempts).toBe(3);
  });

  it('POST does not retry by default', async () => {
    let attempts = 0;
    (globalThis.fetch as any).mockImplementation(async () => {
      attempts++;
      return jsonResponse(500, { error: 'server' });
    });

    const http = createHttpClient();
    await expect(http.post('/api/cmd', {})).rejects.toThrow();
    expect(attempts).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Timeout retry — a timeout-triggered abort must compete for the same
// retry budget as a 5xx/429/408 response, not throw on the first attempt
// regardless of `retry`.
// ---------------------------------------------------------------------------

describe('createHttpClient — timeout retry', () => {
  it('retries a GET after a timeout instead of failing on the first attempt', async () => {
    let attempts = 0;
    (globalThis.fetch as any).mockImplementation((_url: string, init: RequestInit) => {
      attempts++;
      const thisAttempt = attempts;
      return new Promise((resolve, reject) => {
        if (thisAttempt === 1) {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        } else {
          resolve(jsonResponse(200, { ok: true }));
        }
      });
    });

    vi.useFakeTimers();
    const http = createHttpClient();
    const promise = http.get('/api/slow', { timeout: 100, retry: 1 });
    await vi.advanceTimersByTimeAsync(3000);
    const res = await promise;

    expect(res.data).toEqual({ ok: true });
    expect(attempts).toBe(2);
  });

  it('rejects with TimeoutError (not AbortError) once retries are exhausted', async () => {
    (globalThis.fetch as any).mockImplementation((_url: string, init: RequestInit) =>
      new Promise((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      })
    );

    vi.useFakeTimers();
    const http = createHttpClient();
    const promise = http.get('/api/slow', { timeout: 50, retry: 1 });
    const assertion = expect(promise).rejects.toMatchObject({ name: 'TimeoutError' });
    await vi.advanceTimersByTimeAsync(3000);
    await assertion;
  });
});

// ---------------------------------------------------------------------------
// silent flag — stamped on thrown errors for a caller's global error handler
// ---------------------------------------------------------------------------

describe('createHttpClient — silent flag', () => {
  it('stamps error.silent when config.silent is true', async () => {
    (globalThis.fetch as any).mockImplementation(async () => jsonResponse(500, { message: 'boom' }));

    const http = createHttpClient();
    const err = await http.post('/api/x', {}, { silent: true }).catch((e: any) => e);

    expect(err.silent).toBe(true);
  });

  it('does not stamp without the flag', async () => {
    (globalThis.fetch as any).mockImplementation(async () => jsonResponse(500, { message: 'boom' }));

    const http = createHttpClient();
    const err = await http.post('/api/x', {}).catch((e: any) => e);

    expect(err.silent).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Request deduplication
// ---------------------------------------------------------------------------

describe('createHttpClient — deduplication', () => {
  it('deduplicates concurrent GET requests to the same URL', async () => {
    let fetchCount = 0;
    (globalThis.fetch as any).mockImplementation(async () => {
      fetchCount++;
      await new Promise(r => setTimeout(r, 50));
      return jsonResponse(200, { count: fetchCount });
    });

    const http = createHttpClient();

    const [r1, r2] = await Promise.all([
      http.get('/api/data'),
      http.get('/api/data'),
    ]);

    expect(fetchCount).toBe(1);
    expect(r1.data).toEqual(r2.data);
  });

  it('does not deduplicate POST requests', async () => {
    let fetchCount = 0;
    (globalThis.fetch as any).mockImplementation(async () => {
      fetchCount++;
      return jsonResponse(200, {});
    });

    const http = createHttpClient();

    await Promise.all([
      http.post('/api/cmd', { a: 1 }),
      http.post('/api/cmd', { a: 2 }),
    ]);

    expect(fetchCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// LRU cache
// ---------------------------------------------------------------------------

describe('createHttpClient — cache', () => {
  it('caches GET responses with cache: true', async () => {
    let fetchCount = 0;
    (globalThis.fetch as any).mockImplementation(async () => {
      fetchCount++;
      return jsonResponse(200, { n: fetchCount });
    });

    const http = createHttpClient();

    const r1 = await http.get('/api/data', { cache: true, dedupe: false });
    const r2 = await http.get('/api/data', { cache: true, dedupe: false });

    expect(fetchCount).toBe(1);
    expect(r1.data).toEqual(r2.data);
  });

  it('clearCache() invalidates all cached entries', async () => {
    let fetchCount = 0;
    (globalThis.fetch as any).mockImplementation(async () => {
      fetchCount++;
      return jsonResponse(200, { n: fetchCount });
    });

    const http = createHttpClient();

    await http.get('/api/data', { cache: true, dedupe: false });
    http.clearCache();
    await http.get('/api/data', { cache: true, dedupe: false });

    expect(fetchCount).toBe(2);
  });

  it('invalidateCache() removes matching entries', async () => {
    let fetchCount = 0;
    (globalThis.fetch as any).mockImplementation(async () => {
      fetchCount++;
      return jsonResponse(200, { n: fetchCount });
    });

    const http = createHttpClient();

    await http.get('/api/data', { cache: true, dedupe: false });
    http.invalidateCache(/data/);
    await http.get('/api/data', { cache: true, dedupe: false });

    expect(fetchCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Stale-while-revalidate (cache.staleTtl)
// ---------------------------------------------------------------------------

describe('createHttpClient — stale-while-revalidate', () => {
  it('serves a stale hit instantly and revalidates in the background', async () => {
    let fetchCount = 0;
    (globalThis.fetch as any).mockImplementation(async () => {
      fetchCount++;
      return jsonResponse(200, { n: fetchCount });
    });

    const http = createHttpClient();
    const cache = { ttl: 1, staleTtl: 10_000 };

    const r1 = await http.get('/api/thing', { cache, dedupe: false });
    expect(r1.data).toEqual({ n: 1 });
    expect(r1.stale).toBeFalsy();

    await new Promise((r) => setTimeout(r, 10)); // past ttl, inside staleTtl

    const r2 = await http.get('/api/thing', { cache, dedupe: false });
    expect(r2.stale).toBe(true);
    expect(r2.data).toEqual({ n: 1 }); // stale data served immediately, even
    // though the background revalidation fetch has already been dispatched
    // (it starts synchronously alongside the stale return, not lazily).

    const fresh = await r2.revalidation;
    expect(fresh?.data).toEqual({ n: 2 });
    expect(fetchCount).toBe(2);
  });

  it('a stale entry is a plain miss once past both ttl and staleTtl', async () => {
    let fetchCount = 0;
    (globalThis.fetch as any).mockImplementation(async () => {
      fetchCount++;
      return jsonResponse(200, { n: fetchCount });
    });

    const http = createHttpClient();
    const cache = { ttl: 1, staleTtl: 1 };

    await http.get('/api/thing', { cache, dedupe: false });
    await new Promise((r) => setTimeout(r, 15)); // past both windows

    const r2 = await http.get('/api/thing', { cache, dedupe: false });
    expect(r2.stale).toBeFalsy();
    expect(fetchCount).toBe(2); // no stale hit — a real blocking refetch
  });
});

// ---------------------------------------------------------------------------
// serveStaleOnError (opt-in resilience)
// ---------------------------------------------------------------------------

describe('createHttpClient — serveStaleOnError', () => {
  it('serves the retained entry on a transient failure (500)', async () => {
    let attempts = 0;
    (globalThis.fetch as any).mockImplementation(async () => {
      attempts++;
      return attempts === 1 ? jsonResponse(200, { v: 1 }) : jsonResponse(500, { message: 'down' });
    });

    const http = createHttpClient();
    const cache = { ttl: 1, serveStaleOnError: true };

    await http.get('/api/thing', { cache, dedupe: false });
    await new Promise((r) => setTimeout(r, 10)); // entry expires but is retained

    const res = await http.get('/api/thing', { cache, dedupe: false, retry: 0 });

    expect(res.servedOnError).toBe(true);
    expect(res.stale).toBe(true);
    expect(res.data).toEqual({ v: 1 });
    expect(res.error).toBeTruthy();
  });

  it('does NOT mask a business error (422)', async () => {
    let attempts = 0;
    (globalThis.fetch as any).mockImplementation(async () => {
      attempts++;
      return attempts === 1 ? jsonResponse(200, { v: 1 }) : jsonResponse(422, { message: 'nope' });
    });

    const http = createHttpClient();
    const cache = { ttl: 1, serveStaleOnError: true };

    await http.get('/api/biz', { cache, dedupe: false });
    await new Promise((r) => setTimeout(r, 10));

    await expect(http.get('/api/biz', { cache, dedupe: false, retry: 0 })).rejects.toThrow();
  });

  it('expired entries stay a plain miss without the flag', async () => {
    let attempts = 0;
    (globalThis.fetch as any).mockImplementation(async () => {
      attempts++;
      return jsonResponse(200, { v: attempts });
    });

    const http = createHttpClient();
    const cache = { ttl: 1 };

    await http.get('/api/plain', { cache, dedupe: false });
    await new Promise((r) => setTimeout(r, 10));
    await http.get('/api/plain', { cache, dedupe: false });

    expect(attempts).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Interceptors
// ---------------------------------------------------------------------------

describe('createHttpClient — interceptors', () => {
  it('request interceptor modifies config', async () => {
    (globalThis.fetch as any).mockResolvedValue(jsonResponse(200, {}));
    const http = createHttpClient();

    http.interceptors.request.use((config) => {
      return { ...config, headers: { ...config.headers, 'X-Custom': 'test' } };
    });

    await http.get('/api/data');

    const [, init] = (globalThis.fetch as any).mock.calls[0];
    expect(init.headers['X-Custom']).toBe('test');
  });

  it('response interceptor transforms response', async () => {
    (globalThis.fetch as any).mockResolvedValue(jsonResponse(200, { raw: true }));
    const http = createHttpClient();

    http.interceptors.response.use((response) => {
      return { ...response, data: { ...response.data as any, transformed: true } };
    });

    const res = await http.get('/api/data');
    expect((res.data as any).transformed).toBe(true);
  });

  it('eject removes an interceptor', async () => {
    (globalThis.fetch as any).mockResolvedValue(jsonResponse(200, {}));
    const http = createHttpClient();

    const id = http.interceptors.request.use((config) => {
      return { ...config, headers: { ...config.headers, 'X-Remove-Me': 'yes' } };
    });

    http.interceptors.request.eject(id);

    await http.get('/api/data');

    const [, init] = (globalThis.fetch as any).mock.calls[0];
    expect(init.headers['X-Remove-Me']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Safe mode
// ---------------------------------------------------------------------------

describe('createHttpClient — safe mode', () => {
  it('returns { data, error: null, status } on success', async () => {
    (globalThis.fetch as any).mockResolvedValue(jsonResponse(200, { id: 42 }));
    const http = createHttpClient();

    const result = await http.safe.get('/api/data');
    expect(result.data).toEqual({ id: 42 });
    expect(result.error).toBeNull();
    expect(result.status).toBe(200);
  });

  it('returns { data: null, error, status } on failure', async () => {
    (globalThis.fetch as any).mockResolvedValue(jsonResponse(422, { message: 'Validation failed', code: 'INVALID' }));
    const http = createHttpClient();

    const result = await http.safe.post('/api/submit', {});
    expect(result.data).toBeNull();
    expect(result.error).toBeDefined();
    expect(result.status).toBe(422);
  });
});

// ---------------------------------------------------------------------------
// Instance creation
// ---------------------------------------------------------------------------

describe('createHttpClient — create instance', () => {
  it('create() produces a new client with merged defaults', async () => {
    (globalThis.fetch as any).mockResolvedValue(jsonResponse(200, {}));

    const base = createHttpClient({ headers: { 'X-Base': '1' } });
    const child = base.create({ headers: { 'X-Child': '2' } });

    await child.get('/api/data');

    const [, init] = (globalThis.fetch as any).mock.calls[0];
    expect(init.headers['X-Base']).toBe('1');
    expect(init.headers['X-Child']).toBe('2');
  });
});

// ---------------------------------------------------------------------------
// CSRF on mutations only
// ---------------------------------------------------------------------------

describe('createHttpClient — CSRF', () => {
  it('attaches CSRF token to POST but not GET', async () => {
    // Mock a CSRF meta tag
    const metaEl = { content: 'test-csrf-token' };
    vi.stubGlobal('document', {
      querySelector: (sel: string) => sel === 'meta[name="csrf-token"]' ? metaEl : null,
      cookie: '',
    });

    (globalThis.fetch as any).mockResolvedValue(jsonResponse(200, {}));
    const http = createHttpClient({ csrf: true });

    await http.get('/api/data');
    const [, getInit] = (globalThis.fetch as any).mock.calls[0];
    expect(getInit.headers['X-CSRF-TOKEN']).toBeUndefined();

    await http.post('/api/cmd', {});
    const [, postInit] = (globalThis.fetch as any).mock.calls[1];
    expect(postInit.headers['X-CSRF-TOKEN']).toBe('test-csrf-token');
  });
});

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

describe('createHttpClient — response types', () => {
  it('parses text response', async () => {
    (globalThis.fetch as any).mockResolvedValue(mockResponse(200, 'plain text'));
    const http = createHttpClient();

    const res = await http.get('/api/text', { responseType: 'text' });
    expect(res.data).toBe('plain text');
  });
});

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

describe('createHttpClient — download', () => {
  it('returns blob data with filename', async () => {
    const blob = new Blob(['csv,data'], { type: 'text/csv' });
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: {
        entries: () => [['content-disposition', 'attachment; filename="products.csv"'], ['content-type', 'text/csv']],
        get: (k: string) => k === 'content-type' ? 'text/csv' : k === 'content-disposition' ? 'attachment; filename="products.csv"' : null,
      },
      blob: async () => blob,
      text: async () => 'csv,data',
      json: async () => ({}),
    });

    // Mock document for download trigger
    const appendSpy = vi.fn();
    const removeSpy = vi.fn();
    const clickSpy = vi.fn();
    vi.stubGlobal('document', {
      querySelector: () => null,
      cookie: '',
      createElement: () => ({ set href(_: any) {}, set download(_: any) {}, click: clickSpy }),
      body: { appendChild: appendSpy, removeChild: removeSpy },
    });
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:url', revokeObjectURL: () => {} });

    const http = createHttpClient();
    const result = await http.download('/export/csv');

    expect(result.filename).toBe('products.csv');
    expect(result.status).toBe(200);
    expect(clickSpy).toHaveBeenCalled();
  });
});
