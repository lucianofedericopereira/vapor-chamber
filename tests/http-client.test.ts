/**
 * createHttpClient: methods, bodies, query params, baseURL, retry, timeout, dedupe, cache, interceptors, safe mode, CSRF, download.
 * Why: a wrong method, body, URL, retry, cache or error shape would send the wrong request or hide a failure from every caller of the client.
 * Shows: each method and body kind reaches fetch as expected; retry re-sends only retryable failures (a 422 on a POST and a 404 on a GET are not retried, a 503 is); a timeout competes for the retry budget; concurrent GETs dedupe and POSTs do not; cache, stale-while-revalidate and serveStaleOnError (including a deduped follower) behave per option; interceptors, safe mode, create(), CSRF on mutations only and download() return the documented values.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHttpClient } from '../src/http';
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
    blob: async () => new Blob([JSON.stringify(body)]),
  };
}

function jsonResponse(status: number, body: unknown) {
  return mockResponse(status, body, { 'content-type': 'application/json' });
}

beforeEach(() => {
  // Each createHttpClient() owns its cache: nothing global to reset.
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('createHttpClient - methods', () => {
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

describe('createHttpClient - body', () => {
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

describe('createHttpClient - query params', () => {
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

describe('createHttpClient - baseURL', () => {
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

describe('createHttpClient - retry', () => {
  it('GET retries on 503 (default retry: 2)', async () => {
    let attempts = 0;
    (globalThis.fetch as any).mockImplementation(async () => {
      attempts++;
      if (attempts < 3) return jsonResponse(503, { detail: 'server' });
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

  // RETRY_STATUS governs only the Retry-After path; a status outside it is thrown inside the try and must not re-enter retry through the catch, which would re-send a mutation.
  it('POST with retry configured does NOT retry a 422', async () => {
    let attempts = 0;
    (globalThis.fetch as any).mockImplementation(async () => {
      attempts++;
      return jsonResponse(422, { message: 'validation failed' });
    });

    const http = createHttpClient();
    await expect(http.post('/api/cmd', { qty: -1 }, { retry: { maxAttempts: 3 } })).rejects.toMatchObject({
      context: { status: 422 },
    });
    expect(attempts).toBe(1);
  });

  it('GET with retry configured does NOT retry a 404', async () => {
    let attempts = 0;
    (globalThis.fetch as any).mockImplementation(async () => {
      attempts++;
      return jsonResponse(404, { message: 'nope' });
    });

    const http = createHttpClient();
    await expect(http.get('/api/missing', { retry: { maxAttempts: 3 } })).rejects.toThrow();
    expect(attempts).toBe(1);
  });

  it('still retries a 503 when retry is configured on a POST', async () => {
    let attempts = 0;
    (globalThis.fetch as any).mockImplementation(async () => {
      attempts++;
      if (attempts < 3) return jsonResponse(503, { detail: 'server' });
      return jsonResponse(200, { ok: true });
    });

    const http = createHttpClient();
    const res = await http.post('/api/cmd', {}, { retry: { maxAttempts: 3 } });
    expect(res.ok).toBe(true);
    expect(attempts).toBe(3);
  });
});

// A timeout-triggered abort competes for the same retry budget as a 5xx/429/408 response.

describe('createHttpClient - timeout retry', () => {
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
    const promise = http.get('/api/slow', { timeout: 100, retry: { maxAttempts: 2 } });
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
    const promise = http.get('/api/slow', { timeout: 50, retry: { maxAttempts: 2 } });
    const assertion = expect(promise).rejects.toMatchObject({ code: 'transport:timeout:reply' });
    await vi.advanceTimersByTimeAsync(3000);
    await assertion;
  });
});

describe('createHttpClient - silent flag', () => {
  it('stamps error.context.silent when config.silent is true', async () => {
    (globalThis.fetch as any).mockImplementation(async () => jsonResponse(500, { message: 'boom' }));

    const http = createHttpClient();
    const err = await http.post('/api/x', {}, { silent: true }).catch((e: any) => e);

    expect(err.context.silent).toBe(true);
  });

  it('does not stamp without the flag', async () => {
    (globalThis.fetch as any).mockImplementation(async () => jsonResponse(500, { message: 'boom' }));

    const http = createHttpClient();
    const err = await http.post('/api/x', {}).catch((e: any) => e);

    expect(err.context.silent).toBeUndefined();
  });
});

describe('createHttpClient - deduplication', () => {
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

describe('createHttpClient - cache', () => {
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

});

describe('createHttpClient - stale-while-revalidate', () => {
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
    expect(r2.data).toEqual({ n: 1 }); // stale data is returned at once

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
    expect(fetchCount).toBe(2);
  });
});

describe('createHttpClient - serveStaleOnError', () => {
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

    const res = await http.get('/api/thing', { cache, dedupe: false, retry: false });

    expect(res.servedOnError).toBe(true);
    expect(res.stale).toBe(true);
    expect(res.data).toEqual({ v: 1 });
    expect(res.error).toBeTruthy();
  });

  // Dedupe shares the raw fetch promise, so a follower on the same key must be served stale like the leader; the other tests here pass dedupe: false.
  it('serves the retained entry to a DEDUPED follower, not just the leader', async () => {
    let attempts = 0;
    let release: (() => void) | undefined;
    (globalThis.fetch as any).mockImplementation(async () => {
      attempts++;
      if (attempts === 1) return jsonResponse(200, { v: 1 });
      // Hold the second request open so both callers are in flight together: dedupe only acts then.
      await new Promise<void>((resolve) => { release = resolve; });
      return jsonResponse(500, { message: 'down' });
    });

    const http = createHttpClient();
    const cache = { ttl: 1, serveStaleOnError: true };

    await http.get('/api/dedupe-stale', { cache, dedupe: false });
    await new Promise((r) => setTimeout(r, 10)); // entry expires but is retained

    const leader = http.get('/api/dedupe-stale', { cache, retry: false });
    const follower = http.get('/api/dedupe-stale', { cache, retry: false });

    await new Promise((r) => setTimeout(r, 0));
    release?.();

    const [leaderRes, followerRes] = await Promise.all([leader, follower]);

    expect(leaderRes.servedOnError).toBe(true);
    expect(followerRes.servedOnError).toBe(true);
    expect(followerRes.data).toEqual({ v: 1 });
    expect(attempts).toBe(2); // one initial fill, one shared retry
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

    await expect(http.get('/api/biz', { cache, dedupe: false, retry: false })).rejects.toThrow();
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

describe('createHttpClient - interceptors', () => {
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

describe('createHttpClient - safe mode', () => {
  it('returns { data, error: null, status } on success', async () => {
    (globalThis.fetch as any).mockResolvedValue(jsonResponse(200, { id: 42 }));
    const http = createHttpClient();

    const result = await http.safe.get('/api/data');
    expect(result.data).toEqual({ id: 42 });
    expect(result.error).toBeNull();
    expect(result.status).toBe(200);
  });

  it('returns the backend\'s problem on failure, its status added', async () => {
    const errors = [{ pointer: '/payload/email', detail: 'Required.' }];
    (globalThis.fetch as any).mockResolvedValue(jsonResponse(422, { code: 'invalid', detail: 'Validation failed', errors }));
    const http = createHttpClient();

    const result = await http.safe.post('/api/submit', {});
    expect(result.data).toBeNull();
    expect(result.status).toBe(422);
    expect(result.error?.code).toBe('remote:invalid:invalid');
    expect(problemOf(result.error)).toEqual({ status: 422, code: 'invalid', detail: 'Validation failed', errors });
  });
});

describe('createHttpClient - create instance', () => {
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

describe('createHttpClient - CSRF', () => {
  it('attaches CSRF token to POST but not GET', async () => {
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

describe('createHttpClient - response types', () => {
  it('parses text response', async () => {
    (globalThis.fetch as any).mockResolvedValue(mockResponse(200, 'plain text'));
    const http = createHttpClient();

    const res = await http.get('/api/text', { responseType: 'text' });
    expect(res.data).toBe('plain text');
  });
});

describe('createHttpClient - download', () => {
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
