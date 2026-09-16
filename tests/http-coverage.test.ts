/**
 * Supplemental coverage for src/http.ts.
 *
 * Drives the arms the main http suite does not reach:
 *  - readCsrfFromDom hidden-input fallback
 *  - refreshCsrfOnce coalescing + failure paths
 *  - parseRetryAfter HTTP-date branch
 *  - combineSignals AbortSignal.any fallback
 *  - sleepMs abort path
 *  - doClientFetch json content-type fallback
 *  - clientRequest 419 CSRF retry + session-expiry-after-retry
 *  - clientRequest network-error retry
 *  - request interceptor onRejected when onFulfilled throws
 *  - String() body for primitive data
 *  - safe.put / safe.patch / safe.delete wrappers
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  postCommand,
  createHttpClient,
  readCsrfToken,
  invalidateCsrfCache,
} from '../src/http';
import { createResponseCache } from '../src/http-cache';

// ---------------------------------------------------------------------------
// Fetch mock helper (mirrors the existing test files)
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
    blob: async () => new Blob([typeof body === 'string' ? body : JSON.stringify(body)]),
  };
}

function jsonResponse(status: number, body: unknown) {
  return mockResponse(status, body, { 'content-type': 'application/json' });
}

beforeEach(() => {
  // No global cache reset: each createHttpClient() owns its cache, so tests
  // are isolated by construction (item 6).
  invalidateCsrfCache();
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  invalidateCsrfCache();
});

// ---------------------------------------------------------------------------
// readCsrfToken - DOM source fallbacks
// ---------------------------------------------------------------------------

describe('readCsrfToken - DOM sources', () => {
  it('falls back to hidden input[name="_token"] when meta and cookie are absent', () => {
    vi.stubGlobal('document', {
      querySelector: (sel: string) => {
        if (sel === 'input[name="_token"]') return { value: 'hidden-input-token' };
        return null; // meta + xsrf-cookie meta all miss
      },
      cookie: '', // no cookie match
    });

    invalidateCsrfCache();
    const result = readCsrfToken();

    expect(result).toEqual({ token: 'hidden-input-token', headerName: 'X-CSRF-TOKEN' });
  });

  it('reads token from cookie using custom cookie name from meta[name="xsrf-cookie"]', () => {
    vi.stubGlobal('document', {
      querySelector: (sel: string) => {
        if (sel === 'meta[name="xsrf-cookie"]') return { content: 'MY-XSRF' };
        return null; // no csrf-token meta, no hidden input
      },
      cookie: 'other=1; MY-XSRF=cookie%2Dvalue; foo=bar',
    });

    invalidateCsrfCache();
    const result = readCsrfToken();

    expect(result).toEqual({ token: 'cookie-value', headerName: 'X-XSRF-TOKEN' });
  });

  it('returns null when no source yields a token', () => {
    vi.stubGlobal('document', {
      querySelector: () => null,
      cookie: '',
    });

    invalidateCsrfCache();
    expect(readCsrfToken()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// refreshCsrfOnce - coalescing + failure paths (driven via the 419 flow)
// ---------------------------------------------------------------------------

describe('refreshCsrfOnce - failure path', () => {
  it('throws when no token is found in the DOM after refresh', async () => {
    // No DOM token at all -> readCsrfToken() returns null post-refresh -> throw.
    vi.stubGlobal('document', {
      querySelector: () => null,
      cookie: '',
    });

    (globalThis.fetch as any)
      .mockResolvedValueOnce(mockResponse(419)) // original request -> 419
      .mockResolvedValueOnce(mockResponse(200, {})); // csrf-cookie GET succeeds

    await expect(postCommand('/api/cmd', {}, { retry: 0 })).rejects.toThrow(
      /CSRF refresh failed: no token found in DOM after refresh/,
    );
  });
});

describe('refreshCsrfOnce - coalescing', () => {
  it('coalesces a concurrent 419 refresh: second waiter reuses the in-flight refresh and succeeds', async () => {
    // Both requests get 419 first. The csrf-cookie endpoint is slow so the two
    // refreshes overlap; the second caller must enter the coalescing wait loop
    // (_csrfRefreshing === true) and then succeed once the first refresh lands.
    vi.stubGlobal('document', {
      querySelector: (sel: string) =>
        sel === 'meta[name="csrf-token"]' ? { content: 'coalesced-token' } : null,
      cookie: '',
    });

    let csrfCookieCalls = 0;
    // First POST per url -> 419 (forces refresh), then 200 on the retry.
    const status: Record<string, number> = {};
    const smartFetch = vi.fn((url: string) => {
      if (url === '/sanctum/csrf-cookie') {
        csrfCookieCalls++;
        // Slow refresh so the second request's refresh overlaps the first.
        return new Promise((resolve) => setTimeout(() => resolve(mockResponse(200, {})), 50));
      }
      status[url] = (status[url] ?? 0) + 1;
      if (status[url] === 1) return Promise.resolve(mockResponse(419));
      return Promise.resolve(mockResponse(200, { ok: true }));
    });
    vi.stubGlobal('fetch', smartFetch);

    const [r1, r2] = await Promise.all([
      postCommand('/api/a', {}, { retry: 0 }),
      postCommand('/api/b', {}, { retry: 0 }),
    ]);

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    // The second refresh coalesced onto the first, so only one csrf-cookie fetch ran.
    expect(csrfCookieCalls).toBe(1);
  });

  it('coalesced waiter throws when the in-flight refresh failed', async () => {
    // First refresh fails (no DOM token), so _csrfRefreshResult stays false.
    // The coalesced second waiter must observe that failure and throw.
    vi.stubGlobal('document', {
      querySelector: () => null, // no token -> refresh fails
      cookie: '',
    });

    let csrfCookieCalls = 0;
    const status: Record<string, number> = {};
    const smartFetch = vi.fn((url: string) => {
      if (url === '/sanctum/csrf-cookie') {
        csrfCookieCalls++;
        return new Promise((resolve) => setTimeout(() => resolve(mockResponse(200, {})), 50));
      }
      status[url] = (status[url] ?? 0) + 1;
      return Promise.resolve(mockResponse(419)); // always 419 -> always refresh
    });
    vi.stubGlobal('fetch', smartFetch);

    const results = await Promise.allSettled([
      postCommand('/api/x', {}, { retry: 0 }),
      postCommand('/api/y', {}, { retry: 0 }),
    ]);

    // Both reject - one from the primary refresh, one from the coalesced wait.
    expect(results[0].status).toBe('rejected');
    expect(results[1].status).toBe('rejected');
    const messages = results.map((r) => (r as PromiseRejectedResult).reason?.message ?? '');
    // At least one reflects the coalesced "token unavailable after refresh" path.
    expect(
      messages.some((m) => /CSRF refresh failed/.test(m)),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseRetryAfter - HTTP-date branch via retry timing
// ---------------------------------------------------------------------------

describe('parseRetryAfter - HTTP-date Retry-After', () => {
  it('honors a Retry-After HTTP date in the future and retries', async () => {
    const future = new Date(Date.now() + 2000).toUTCString();
    (globalThis.fetch as any)
      .mockResolvedValueOnce(mockResponse(503, null, { 'retry-after': future }))
      .mockResolvedValueOnce(mockResponse(200, { ok: true }));

    vi.useFakeTimers();
    const promise = postCommand('/api/cmd', {}, { retry: 1 });
    await vi.advanceTimersByTimeAsync(2500);
    const res = await promise;

    expect(res.ok).toBe(true);
    expect((globalThis.fetch as any).mock.calls).toHaveLength(2);
  });

  it('returns null for an unparseable Retry-After and falls back to backoff', async () => {
    (globalThis.fetch as any)
      .mockResolvedValueOnce(mockResponse(503, null, { 'retry-after': 'not-a-date-or-number' }))
      .mockResolvedValueOnce(mockResponse(200, { ok: true }));

    vi.useFakeTimers();
    const promise = postCommand('/api/cmd', {}, { retry: 1 });
    await vi.runAllTimersAsync();
    const res = await promise;

    expect(res.ok).toBe(true);
    expect((globalThis.fetch as any).mock.calls).toHaveLength(2);
  });

  it('ignores a past HTTP date and falls back to backoff', async () => {
    const past = new Date(Date.now() - 5000).toUTCString();
    (globalThis.fetch as any)
      .mockResolvedValueOnce(mockResponse(503, null, { 'retry-after': past }))
      .mockResolvedValueOnce(mockResponse(200, { ok: true }));

    vi.useFakeTimers();
    const promise = postCommand('/api/cmd', {}, { retry: 1 });
    await vi.runAllTimersAsync();
    const res = await promise;

    expect(res.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// combineSignals - AbortSignal.any fallback
// ---------------------------------------------------------------------------

describe('combineSignals - fallback without AbortSignal.any', () => {
  it('uses the manual fallback and still propagates a user abort', async () => {
    const realAny = (AbortSignal as any).any;
    // Force the fallback branch by removing AbortSignal.any.
    (AbortSignal as any).any = undefined;

    try {
      const ctrl = new AbortController();
      (globalThis.fetch as any).mockImplementation((_url: string, init: RequestInit) =>
        new Promise((_, reject) => {
          if (init?.signal?.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
          init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        }),
      );

      // A user signal present means combineSignals(userSignal, timeoutSignal) runs.
      const promise = postCommand('/api/cmd', {}, { signal: ctrl.signal });
      ctrl.abort();

      await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    } finally {
      (AbortSignal as any).any = realAny;
    }
  });
});

// ---------------------------------------------------------------------------
// sleepMs - abort path via user abort during retry backoff
// ---------------------------------------------------------------------------

describe('sleepMs - abort during retry backoff', () => {
  it('rejects the backoff sleep with AbortError when the user signal fires mid-wait', async () => {
    const ctrl = new AbortController();
    // Network error so the catch path schedules sleepMs(backoff, userSignal),
    // then we abort while that sleep is pending -> clearTimeout + reject path.
    (globalThis.fetch as any).mockRejectedValue(new Error('boom'));

    vi.useFakeTimers();
    const promise = postCommand('/api/cmd', {}, { retry: 3, signal: ctrl.signal });
    const assertion = expect(promise).rejects.toMatchObject({ name: 'AbortError' });

    // Let the first fetch reject and enter the backoff sleep.
    await vi.advanceTimersByTimeAsync(0);
    ctrl.abort(); // fires the sleepMs abort listener -> clearTimeout + reject
    await vi.runAllTimersAsync();
    await assertion;
  });
});

// ---------------------------------------------------------------------------
// doClientFetch - json content-type fallback to text
// ---------------------------------------------------------------------------

describe('doClientFetch - non-JSON content-type falls back to text', () => {
  it('returns text when responseType is json but content-type is not application/json', async () => {
    // content-type omitted -> not "application/json" -> data = await raw.text()
    (globalThis.fetch as any).mockResolvedValue(mockResponse(200, 'raw-body-text'));
    const http = createHttpClient();

    const res = await http.get('/api/raw');

    expect(res.data).toBe('raw-body-text');
    expect(res.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// clientRequest - 419 CSRF retry (419 is CSRF expiry, never session expiry)
// ---------------------------------------------------------------------------

describe('createHttpClient - 419 CSRF retry', () => {
  beforeEach(() => {
    vi.stubGlobal('document', {
      querySelector: (sel: string) =>
        sel === 'meta[name="csrf-token"]' ? { content: 'client-csrf-token' } : null,
      cookie: '',
    });
  });

  it('refreshes CSRF and retries once on 419, then succeeds', async () => {
    (globalThis.fetch as any)
      .mockResolvedValueOnce(jsonResponse(419, { message: 'csrf' })) // POST -> 419
      .mockResolvedValueOnce(mockResponse(200, {})) // GET /sanctum/csrf-cookie
      .mockResolvedValueOnce(jsonResponse(200, { ok: true })); // retry POST -> 200

    const http = createHttpClient({ csrf: true });
    const res = await http.post('/api/cmd', { a: 1 });

    expect(res.ok).toBe(true);
    expect(res.data).toEqual({ ok: true });
    expect((globalThis.fetch as any).mock.calls[1][0]).toBe('/sanctum/csrf-cookie');

    // The retried request carried the refreshed CSRF header.
    const [, retryInit] = (globalThis.fetch as any).mock.calls[2];
    expect(retryInit.headers['X-CSRF-TOKEN']).toBe('client-csrf-token');
  });

  it('a 419 that survives the refresh throws HttpError and does NOT fire onSessionExpired', async () => {
    const onSessionExpired = vi.fn();
    // 419 -> refresh -> 419 again. 419 is CSRF expiry, not session expiry
    // (whitepaper 5.7): it is thrown as an HttpError, and only 401 fires
    // onSessionExpired. clientRequest used to escalate here; it no longer does,
    // matching postCommand and the contract (runWithRetry, one policy).
    (globalThis.fetch as any)
      .mockResolvedValueOnce(jsonResponse(419, { message: 'csrf' }))
      .mockResolvedValueOnce(mockResponse(200, {})) // csrf-cookie GET
      .mockResolvedValueOnce(jsonResponse(419, { message: 'csrf again' }));

    const http = createHttpClient({ csrf: true });

    await expect(http.post('/api/cmd', {}, { onSessionExpired })).rejects.toMatchObject({
      name: 'HttpError',
      status: 419,
    });
    expect(onSessionExpired).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// clientRequest - network-error retry backoff
// ---------------------------------------------------------------------------

describe('createHttpClient - network error retry', () => {
  it('GET retries after a network error via backoff sleep, then succeeds', async () => {
    (globalThis.fetch as any)
      .mockRejectedValueOnce(new Error('network glitch'))
      .mockResolvedValueOnce(jsonResponse(200, { recovered: true }));

    vi.useFakeTimers();
    const http = createHttpClient();
    const promise = http.get('/api/data', { retry: 1 });
    await vi.runAllTimersAsync();
    const res = await promise;

    expect(res.ok).toBe(true);
    expect(res.data).toEqual({ recovered: true });
    expect((globalThis.fetch as any).mock.calls).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// request interceptor - onRejected when onFulfilled throws
// ---------------------------------------------------------------------------

describe('createHttpClient - request interceptor error path', () => {
  it('invokes onRejected when the request onFulfilled interceptor throws', async () => {
    (globalThis.fetch as any).mockResolvedValue(jsonResponse(200, { ok: true }));
    const http = createHttpClient();

    const onRejected = vi.fn();
    http.interceptors.request.use(() => {
      throw new Error('interceptor boom');
    }, onRejected);

    // The throw is caught inside forEach; the request still proceeds with the
    // un-mutated config (onFulfilled returned nothing usable).
    const res = await http.get('/api/data');

    expect(res.ok).toBe(true);
    expect(onRejected).toHaveBeenCalledTimes(1);
    expect((onRejected.mock.calls[0][0] as Error).message).toBe('interceptor boom');
  });
});

// ---------------------------------------------------------------------------
// request body - String(rawData) for primitive data
// ---------------------------------------------------------------------------

describe('createHttpClient - primitive body serialization', () => {
  it('stringifies a primitive (number) body via String() with no JSON Content-Type', async () => {
    (globalThis.fetch as any).mockResolvedValue(jsonResponse(200, {}));
    const http = createHttpClient();

    await http.post('/api/raw', 12345);

    const [, init] = (globalThis.fetch as any).mock.calls[0];
    expect(init.body).toBe('12345');
    // Primitive bodies don't set application/json Content-Type.
    expect(init.headers['Content-Type']).toBeUndefined();
  });

  it('stringifies a string body via String()', async () => {
    (globalThis.fetch as any).mockResolvedValue(jsonResponse(200, {}));
    const http = createHttpClient();

    await http.put('/api/raw', 'hello-world');

    const [, init] = (globalThis.fetch as any).mock.calls[0];
    expect(init.body).toBe('hello-world');
  });
});

// ---------------------------------------------------------------------------
// safe.put / safe.patch / safe.delete wrappers
// ---------------------------------------------------------------------------

describe('createHttpClient - safe.put/patch/delete', () => {
  it('safe.put returns a success SafeResult', async () => {
    (globalThis.fetch as any).mockResolvedValue(jsonResponse(200, { updated: true }));
    const http = createHttpClient();

    const result = await http.safe.put('/api/users/1', { name: 'Bob' });

    expect(result.error).toBeNull();
    expect(result.data).toEqual({ updated: true });
    expect(result.status).toBe(200);
    const [, init] = (globalThis.fetch as any).mock.calls[0];
    expect(init.method).toBe('PUT');
    expect(init.body).toBe(JSON.stringify({ name: 'Bob' }));
  });

  it('safe.patch returns an error SafeResult on failure (never throws)', async () => {
    (globalThis.fetch as any).mockResolvedValue(
      jsonResponse(422, { message: 'Validation failed', code: 'INVALID' }),
    );
    const http = createHttpClient();

    const result = await http.safe.patch('/api/users/1', { name: '' });

    expect(result.data).toBeNull();
    expect(result.error).toMatchObject({ message: 'Validation failed', code: 'INVALID' });
    expect(result.status).toBe(422);
    const [, init] = (globalThis.fetch as any).mock.calls[0];
    expect(init.method).toBe('PATCH');
  });

  it('safe.delete returns a success SafeResult with no body', async () => {
    (globalThis.fetch as any).mockResolvedValue(jsonResponse(200, { deleted: true }));
    const http = createHttpClient();

    const result = await http.safe.delete('/api/users/1');

    expect(result.error).toBeNull();
    expect(result.data).toEqual({ deleted: true });
    expect(result.status).toBe(200);
    const [, init] = (globalThis.fetch as any).mock.calls[0];
    expect(init.method).toBe('DELETE');
    expect(init.body).toBeUndefined();
  });
});

describe('response cache - per-instance LRU', () => {
  it('evicts the LEAST RECENTLY USED entry, not simply the oldest', () => {
    const cache = createResponseCache();
    for (let i = 0; i < 50; i++) cache.set(`key-${i}`, { i }, 60_000); // fills to CACHE_MAX_SIZE

    // Reading key-0 promotes it to most-recently-used, so key-1 becomes the
    // eviction candidate. This is what makes it an LRU rather than a FIFO.
    expect(cache.get('key-0')).not.toBeNull();

    cache.set('key-50', { i: 50 }, 60_000); // 51st insert -> one eviction
    expect(cache.get('key-1')).toBeNull(); // the least recently used went
    expect(cache.get('key-0')).not.toBeNull(); // the recently read one stayed
    expect(cache.get('key-50')).not.toBeNull();
  });

  // Item 6: the maps used to be module-level, so every client shared one
  // cache and one dedupe map - an instance illusion, and under concurrent SSR
  // a cross-request leak (the key has no auth/cookie dimension).
  it('two caches are independent - one clear() cannot empty the other', () => {
    const a = createResponseCache();
    const b = createResponseCache();
    a.set('json:/api/me', { user: 'A' }, 60_000);
    b.set('json:/api/me', { user: 'B' }, 60_000);

    expect(a.get('json:/api/me')?.data).toEqual({ user: 'A' });
    expect(b.get('json:/api/me')?.data).toEqual({ user: 'B' });

    a.clear();
    expect(a.get('json:/api/me')).toBeNull();
    expect(b.get('json:/api/me')?.data).toEqual({ user: 'B' });
  });

  it('in-flight dedupe is per instance too', async () => {
    const a = createResponseCache();
    const b = createResponseCache();
    const promise = Promise.resolve('A');
    a.setInflight('GET:json:/api/me', promise);

    expect(a.getInflight('GET:json:/api/me')).toBe(promise);
    expect(b.getInflight('GET:json:/api/me')).toBeUndefined();
    await promise;
  });
});

describe('getAny - last-resort lookup for cache.serveStaleOnError', () => {
  it('returns the entry even past its stale window (get would call it a miss)', () => {
    const cache = createResponseCache();
    cache.set('json:/api/x', { x: 1 }, /* ttl */ -1, /* staleTtl */ 0); // already expired
    expect(cache.get('json:/api/x')).toBeNull(); // ordinary lookup: a miss
    expect(cache.getAny('json:/api/x')).toMatchObject({ data: { x: 1 } }); // last resort: still there
  });

  it('returns null on a genuine miss', () => {
    expect(createResponseCache().getAny('json:/api/never-set')).toBeNull();
  });
});

describe('cache.invalidate', () => {
  it('removes entries whose URL (not the responseType prefix) matches a RegExp', () => {
    const cache = createResponseCache();
    cache.set('json:/api/users/1', { id: 1 }, 60_000);
    cache.set('json:/api/users/2', { id: 2 }, 60_000);
    cache.set('json:/api/orders/1', { id: 1 }, 60_000);

    cache.invalidate(/^\/api\/users/);

    expect(cache.getAny('json:/api/users/1')).toBeNull();
    expect(cache.getAny('json:/api/users/2')).toBeNull();
    expect(cache.getAny('json:/api/orders/1')).not.toBeNull(); // untouched
  });

  it('treats a plain string as a literal substring', () => {
    const cache = createResponseCache();
    cache.set('json:/api/orders/1', { id: 1 }, 60_000);
    cache.invalidate('/api/orders');
    expect(cache.getAny('json:/api/orders/1')).toBeNull();
  });

  it('is a no-op when nothing matches', () => {
    const cache = createResponseCache();
    cache.set('json:/api/orders/1', { id: 1 }, 60_000);
    cache.invalidate(/^\/api\/nothing-here/);
    expect(cache.getAny('json:/api/orders/1')).not.toBeNull();
  });

  // Item 9: `new RegExp(pattern)` on a plain string threw on this library's
  // OWN output - buildFullUrl serializes arrays as `ids[0]=`, so the key holds
  // a literal `[`.
  it('does not throw on a URL containing regex metacharacters', () => {
    const cache = createResponseCache();
    cache.set('json:/api/products?ids[0]=1&ids[1]=2', { ok: true }, 60_000);

    expect(() => cache.invalidate('/api/products?ids[0]=1&ids[1]=2')).not.toThrow();
    expect(cache.getAny('json:/api/products?ids[0]=1&ids[1]=2')).toBeNull();
  });

  it('matches a query string literally instead of treating ? as a quantifier', () => {
    const cache = createResponseCache();
    cache.set('json:/api/products?page=1', { page: 1 }, 60_000);
    cache.set('json:/api/productsage=1', { decoy: true }, 60_000);

    cache.invalidate('/api/products?page=1');

    expect(cache.getAny('json:/api/products?page=1')).toBeNull();
    // `?` as a quantifier made '/api/product' + 'sage=1' a match - it is not.
    expect(cache.getAny('json:/api/productsage=1')).not.toBeNull();
  });

  it('warns in dev when an anchored string looks like an intended regex', () => {
    using warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    createResponseCache().invalidate('^/api/users');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('literal'));
  });
});

describe('cached responses are immutable in dev (item 8)', () => {
  it('freezes the stored response and its payload', () => {
    const cache = createResponseCache();
    const response = { data: { items: [{ id: 1 }] }, status: 200, ok: true, headers: {} };
    cache.set('json:/api/items', response, 60_000);

    const hit = cache.get('json:/api/items')?.data as typeof response;
    // A consumer sorting/deleting in place used to silently rewrite the cache
    // for every later hit. Now it throws at the mutation site.
    expect(() => {
      (hit.data.items as { id: number }[]).push({ id: 2 });
    }).toThrow();
    expect(() => {
      (hit as { status: number }).status = 500;
    }).toThrow();
    expect(hit.data.items).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The remaining http.ts arms: a document with no querySelector, a 419 refresh
// that yields no fresh token, and a fetch Response with no `headers`.
// ---------------------------------------------------------------------------

describe('readCsrfToken - the TTL cache hit', () => {
  it('serves a second read from cache without touching the DOM again', () => {
    // The 5-minute cache. This used to be covered incidentally by the 419 path,
    // which called readCsrfToken() a second time right after refreshCsrfOnce();
    // that re-read has been removed (the refresh now returns the token), so the
    // cache needs asserting on its own terms. It still matters for the ordinary
    // case: every csrf-enabled request inside the TTL reads from here.
    let domReads = 0;
    vi.stubGlobal('document', {
      querySelector: (sel: string) => {
        if (sel === 'meta[name="csrf-token"]') { domReads++; return { content: 'cached-token' }; }
        return null;
      },
      cookie: '',
    });
    invalidateCsrfCache();

    const first = readCsrfToken();
    const second = readCsrfToken();

    expect(first).toEqual({ token: 'cached-token', headerName: 'X-CSRF-TOKEN' });
    expect(second).toEqual(first);
    expect(domReads).toBe(1); // second call never reached the DOM

    // ...and invalidating forces a fresh read.
    invalidateCsrfCache();
    expect(readCsrfToken()).toEqual(first);
    expect(domReads).toBe(2);
  });
});

describe('readCsrfToken - a document without querySelector', () => {
  it('skips both DOM probes and still reads the cookie', () => {
    // `typeof document.querySelector === 'function' ? ... : null` - the null arm,
    // which then short-circuits BOTH `if (q)` blocks. This is the shape a
    // non-DOM `document` shim has (some SSR/test harnesses expose only
    // `cookie`), and a bare property read on it would throw.
    vi.stubGlobal('document', { cookie: 'XSRF-TOKEN=from-cookie-only' });

    invalidateCsrfCache();
    expect(readCsrfToken()).toEqual({ token: 'from-cookie-only', headerName: 'X-XSRF-TOKEN' });
  });

  it('returns null when there is neither a querySelector nor a cookie', () => {
    vi.stubGlobal('document', { cookie: '' });
    invalidateCsrfCache();
    expect(readCsrfToken()).toBeNull();
  });
});

describe('clientRequest - 419 CSRF refresh returns the token it proved readable', () => {
  it('retries with the token handed back by the refresh, not a re-read', async () => {
    // refreshCsrfOnce() now RESOLVES WITH the token instead of leaving the
    // caller to call readCsrfToken() again. That removed a real window: the
    // two statements were separated by a microtask boundary that coalesced
    // waiters resume across, so a waiter running first could invalidate the
    // cache or clear the DOM and leave a later waiter re-reading null - then
    // silently retrying with no CSRF header.
    let token = 'token-after-refresh';
    vi.stubGlobal('document', {
      querySelector: (sel: string) =>
        sel === 'meta[name="csrf-token"]' ? { content: token } : null,
      cookie: '',
    });
    invalidateCsrfCache();

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(419, { message: 'csrf expired' })) // trips the refresh
      .mockImplementationOnce(async () => {
        // The refresh round-trip: the backend rotates the token.
        token = 'rotated-token';
        return mockResponse(200, null);
      })
      .mockResolvedValueOnce(jsonResponse(200, { ok: true })); // the retry
    vi.stubGlobal('fetch', fetchMock);

    const client = createHttpClient({ csrfCookieUrl: '/sanctum/csrf-cookie' });
    const res = await client.get('/api/thing');

    expect(res.data).toEqual({ ok: true });
    const lastInit = fetchMock.mock.calls.at(-1)![1];
    expect(lastInit.headers['X-CSRF-TOKEN']).toBe('rotated-token');
  });

  it('gives every coalesced waiter the SAME token', async () => {
    // The coalescing promise is shared, so all waiters now resolve with one
    // agreed value rather than each re-reading whatever the DOM held at the
    // moment they happened to resume.
    let token = 'initial';
    vi.stubGlobal('document', {
      querySelector: (sel: string) =>
        sel === 'meta[name="csrf-token"]' ? { content: token } : null,
      cookie: '',
    });
    invalidateCsrfCache();

    const seen: (string | undefined)[] = [];
    const fetchMock = vi.fn(async (_url: string, init: any) => {
      if (String(_url).includes('csrf-cookie')) {
        token = 'rotated';
        return mockResponse(200, null);
      }
      const header = init?.headers?.['X-CSRF-TOKEN'];
      if (header !== undefined) seen.push(header);
      // First attempt for each request 419s; the retry (with a header) succeeds.
      return header ? jsonResponse(200, { ok: true }) : jsonResponse(419, { message: 'csrf expired' });
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = createHttpClient({ csrfCookieUrl: '/sanctum/csrf-cookie' });
    const [a, b, c] = await Promise.all([
      client.get('/api/a'),
      client.get('/api/b'),
      client.get('/api/c'),
    ]);

    expect([a.data, b.data, c.data]).toEqual([{ ok: true }, { ok: true }, { ok: true }]);
    expect(seen).toHaveLength(3);
    expect(new Set(seen).size).toBe(1); // one agreed token across all waiters
  });
});

describe('doClientFetch - a Response with no headers', () => {
  // `headersToObject(raw.headers)` - the absent-headers arm. Some fetch
  // polyfills and hand-rolled doubles omit `headers` entirely.
  //
  // This used to be split in two, with the second case PINNING a defect: the
  // guard tolerated a missing `headers` while the json path immediately did an
  // unguarded `raw.headers.get('content-type')`, so the default path still
  // threw. Both paths are tolerant now, and both are asserted here.
  const headerless = (body: string) => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    // no `headers` key at all
    text: async () => body,
  });

  it('returns empty headers on the text path', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(headerless('plain body')));
    const client = createHttpClient();
    const res = await client.get('/api/thing', { responseType: 'text' });
    expect(res.data).toBe('plain body');
    expect(res.headers).toEqual({});
  });

  it('no longer throws on the DEFAULT json path', async () => {
    // Regression: this threw `TypeError: Cannot read properties of undefined
    // (reading 'get')`. With no content-type to read, the response falls
    // through to the non-JSON branch and yields the raw text - the same
    // graceful degradation any content-type-less response already gets.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(headerless('{"fine":true}')));
    const client = createHttpClient();
    const res = await client.get('/api/thing');
    expect(res.headers).toEqual({});
    expect(res.data).toBe('{"fine":true}');
  });

  it('still parses JSON case-insensitively when headers ARE present', async () => {
    // The reason the content-type read delegates to `Headers.get()` instead of
    // the normalized snapshot: `get()` is case-insensitive by spec, so an
    // implementation yielding `Content-Type` still parses. Reading the plain
    // object would miss and silently hand back a STRING.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: {
        entries: () => [['Content-Type', 'application/json']].values(),
        get: (k: string) => (k.toLowerCase() === 'content-type' ? 'application/json' : null),
      },
      text: async () => '{"parsed":true}',
    }));
    const client = createHttpClient();
    const res = await client.get('/api/thing');
    expect(res.data).toEqual({ parsed: true }); // object, not a string
  });
});

// ---------------------------------------------------------------------------
// headersToObject - what it does and does NOT normalize.
// ---------------------------------------------------------------------------

describe('response header snapshot', () => {
  it('lower-cases keys so the case-sensitive consumer lookups cannot silently miss', async () => {
    // `res.headers` is read case-sensitively everywhere downstream:
    // ['retry-after'] and ['x-ratelimit-reset'] in both retry loops,
    // ['content-disposition'] in the download path. A Headers whose entries()
    // yields canonical casing would make every one of them miss with NO error
    // - backoff not honoured, filename lost. Normalizing once in
    // headersToObject is what rules that out.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: {
        entries: () =>
          [
            ['Content-Type', 'application/json'],
            ['Retry-After', '5'],
            ['Content-Disposition', 'attachment; filename="r.csv"'],
          ].values(),
        get: (k: string) => (k.toLowerCase() === 'content-type' ? 'application/json' : null),
      },
      text: async () => '{"parsed":true}',
    }));

    const client = createHttpClient();
    const res = await client.get('/api/thing');

    expect(res.headers['retry-after']).toBe('5');
    expect(res.headers['content-disposition']).toBe('attachment; filename="r.csv"');
    expect(res.headers['content-type']).toBe('application/json');
    expect(res.headers['Retry-After']).toBeUndefined(); // normalized, not duplicated

    // And the content-type decision still delegates to Headers.get(), so JSON
    // parses regardless of casing - belt and braces, from both directions.
    expect(res.data).toEqual({ parsed: true });
  });
});
