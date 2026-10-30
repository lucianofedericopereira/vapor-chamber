/**
 * src/http.ts edge cases: CSRF token sources and refresh, Retry-After parsing, abort, response parsing, bodies, safe wrappers, response cache.
 * Why: a missed CSRF token, a retry that ignores the server's wait or an abort, a cache that evicts or leaks across clients, or a case-sensitive header miss would send wrong requests or hide failures from every caller. Also the only file reaching the CSRF cache hit, a document without querySelector, safe.put, patch and delete, and the response cache's full-size eviction, so the 100% floor needs it.
 * Shows: readCsrfToken reads the hidden input, the cookie named by meta xsrf-cookie, and a TTL cache, or returns null; a 419 refreshes once, coalesced waiters share one refresh and one token, and a 419 that survives it throws without onSessionExpired; Retry-After as a future HTTP date is honoured while an unparseable or past one falls back to backoff; a user abort ends the fallback signal and the backoff sleep; non-JSON content-type and missing headers degrade to text; primitive bodies are String()-ed; safe.put, patch and delete return SafeResults; createResponseCache evicts LRU, is per instance, has getAny, invalidate and dev freezing; res.headers keys are lower-cased.
 * See: docs/whitepaper.md section 6.2.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  postCommand,
  createHttpClient,
  readCsrfToken,
  invalidateCsrfCache,
} from '../src/http';
import { createResponseCache } from '../src/http-cache';
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
  // Each createHttpClient() owns its cache: nothing global to reset.
  invalidateCsrfCache();
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  invalidateCsrfCache();
});

describe('readCsrfToken - DOM sources', () => {
  it('falls back to hidden input[name="_token"] when meta and cookie are absent', () => {
    vi.stubGlobal('document', {
      querySelector: (sel: string) => {
        if (sel === 'input[name="_token"]') return { value: 'hidden-input-token' };
        return null;
      },
      cookie: '',
    });

    invalidateCsrfCache();
    const result = readCsrfToken();

    expect(result).toEqual({ token: 'hidden-input-token', headerName: 'X-CSRF-TOKEN' });
  });

  it('reads token from cookie using custom cookie name from meta[name="xsrf-cookie"]', () => {
    vi.stubGlobal('document', {
      querySelector: (sel: string) => {
        if (sel === 'meta[name="xsrf-cookie"]') return { content: 'MY-XSRF' };
        return null;
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

describe('refreshCsrfOnce - failure path', () => {
  it('throws when no token is found in the DOM after refresh', async () => {
    // No DOM token: readCsrfToken() returns null after the refresh, so the request throws.
    vi.stubGlobal('document', {
      querySelector: () => null,
      cookie: '',
    });

    (globalThis.fetch as any)
      .mockResolvedValueOnce(mockResponse(419)) // original request -> 419
      .mockResolvedValueOnce(mockResponse(200, {})); // csrf-cookie GET succeeds

    await expect(postCommand('/api/cmd', {}, { retry: false })).rejects.toMatchObject({ code: 'transport:missing:csrf' });
  });
});

describe('refreshCsrfOnce - coalescing', () => {
  it('coalesces a concurrent 419 refresh: second waiter reuses the in-flight refresh and succeeds', async () => {
    // Both requests get 419; the csrf-cookie endpoint is slow so the refreshes overlap and the second caller waits on the first.
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
      postCommand('/api/a', {}, { retry: false }),
      postCommand('/api/b', {}, { retry: false }),
    ]);

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    // The second refresh coalesced onto the first, so only one csrf-cookie fetch ran.
    expect(csrfCookieCalls).toBe(1);
  });

  it('coalesced waiter throws when the in-flight refresh failed', async () => {
    // The first refresh fails (no DOM token); the coalesced second waiter must see that failure and throw.
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
      postCommand('/api/x', {}, { retry: false }),
      postCommand('/api/y', {}, { retry: false }),
    ]);

    // Both reject - one from the primary refresh, one from the coalesced wait.
    expect(results[0].status).toBe('rejected');
    expect(results[1].status).toBe('rejected');
    const codes = results.map((r) => (r as PromiseRejectedResult).reason?.code ?? '');
    // At least one reflects the coalesced "token unavailable after refresh" path.
    expect(codes.some((c) => c === 'transport:missing:csrf')).toBe(true);
  });
});

describe('parseRetryAfter - HTTP-date Retry-After', () => {
  it('honors a Retry-After HTTP date in the future and retries', async () => {
    const future = new Date(Date.now() + 2000).toUTCString();
    (globalThis.fetch as any)
      .mockResolvedValueOnce(mockResponse(503, null, { 'retry-after': future }))
      .mockResolvedValueOnce(mockResponse(200, { ok: true }));

    vi.useFakeTimers();
    const promise = postCommand('/api/cmd', {}, { retry: { maxAttempts: 2 } });
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
    const promise = postCommand('/api/cmd', {}, { retry: { maxAttempts: 2 } });
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
    const promise = postCommand('/api/cmd', {}, { retry: { maxAttempts: 2 } });
    await vi.runAllTimersAsync();
    const res = await promise;

    expect(res.ok).toBe(true);
  });
});

describe('_combineSignals - fallback without AbortSignal.any', () => {
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

      // A user signal present means _combineSignals(userSignal, timeoutSignal) runs.
      const promise = postCommand('/api/cmd', {}, { signal: ctrl.signal });
      ctrl.abort();

      await expect(promise).rejects.toMatchObject({ code: 'transport:aborted:request' });
    } finally {
      (AbortSignal as any).any = realAny;
    }
  });
});

describe('sleepMs - abort during retry backoff', () => {
  it("rejects the backoff sleep with the caller's abort code when the user signal fires mid-wait", async () => {
    // A draw under 1/200 makes the first backoff 0 ms, which advanceTimersByTimeAsync(0) would run before the abort; pin it mid-range.
    using _random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const ctrl = new AbortController();
    // A 503 is re-sent for any method, so the abort lands while sleepMs(backoff, userSignal) is pending.
    (globalThis.fetch as any).mockResolvedValue(jsonResponse(503, { message: 'busy' }));

    vi.useFakeTimers();
    const promise = postCommand('/api/cmd', {}, { retry: { maxAttempts: 4 }, signal: ctrl.signal });
    const assertion = expect(promise).rejects.toMatchObject({ code: 'transport:aborted:request' });

    // Let the first fetch reject and enter the backoff sleep.
    await vi.advanceTimersByTimeAsync(0);
    ctrl.abort(); // fires the sleepMs abort listener -> clearTimeout + reject
    expect(vi.getTimerCount()).toBe(0); // the sleep ended at the abort, not at its timer
    await vi.runAllTimersAsync();
    await assertion;
  });

  it('the same after a thrown failure: a GET with no response, aborted in its backoff', async () => {
    using _random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const ctrl = new AbortController();
    (globalThis.fetch as any).mockRejectedValue(new TypeError('Failed to fetch'));

    vi.useFakeTimers();
    const promise = createHttpClient().get('/api/q', { retry: { maxAttempts: 4 }, signal: ctrl.signal });
    const assertion = expect(promise).rejects.toMatchObject({ code: 'transport:aborted:request' });

    await vi.advanceTimersByTimeAsync(0);
    ctrl.abort();
    expect(vi.getTimerCount()).toBe(0);
    await vi.runAllTimersAsync();
    await assertion;
    expect((globalThis.fetch as any).mock.calls.length).toBe(1);
  });
});

describe('doClientFetch - non-JSON content-type falls back to text', () => {
  it('returns text when responseType is json but content-type is not application/json', async () => {
    (globalThis.fetch as any).mockResolvedValue(mockResponse(200, 'raw-body-text'));
    const http = createHttpClient();

    const res = await http.get('/api/raw');

    expect(res.data).toBe('raw-body-text');
    expect(res.ok).toBe(true);
  });
});

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

    const [, retryInit] = (globalThis.fetch as any).mock.calls[2];
    expect(retryInit.headers['X-CSRF-TOKEN']).toBe('client-csrf-token');
  });

  it('a 419 that survives the refresh throws the remote failure and does NOT fire onSessionExpired', async () => {
    const onSessionExpired = vi.fn();
    // 419 is CSRF expiry, not session expiry: it is thrown as the remote failure and only 401 fires onSessionExpired.
    (globalThis.fetch as any)
      .mockResolvedValueOnce(jsonResponse(419, { message: 'csrf' }))
      .mockResolvedValueOnce(mockResponse(200, {})) // csrf-cookie GET
      .mockResolvedValueOnce(jsonResponse(419, { message: 'csrf again' }));

    const http = createHttpClient({ csrf: true });

    await expect(http.post('/api/cmd', {}, { onSessionExpired })).rejects.toMatchObject({
      name: 'BusError',
      context: { status: 419 },
    });
    expect(onSessionExpired).not.toHaveBeenCalled();
  });
});

describe('createHttpClient - network error retry', () => {
  it('GET retries after a network error via backoff sleep, then succeeds', async () => {
    (globalThis.fetch as any)
      .mockRejectedValueOnce(new Error('network glitch'))
      .mockResolvedValueOnce(jsonResponse(200, { recovered: true }));

    vi.useFakeTimers();
    const http = createHttpClient();
    const promise = http.get('/api/data', { retry: { maxAttempts: 2 } });
    await vi.runAllTimersAsync();
    const res = await promise;

    expect(res.ok).toBe(true);
    expect(res.data).toEqual({ recovered: true });
    expect((globalThis.fetch as any).mock.calls).toHaveLength(2);
  });
});

describe('createHttpClient - request interceptor error path', () => {
  it('invokes onRejected when the request onFulfilled interceptor throws', async () => {
    (globalThis.fetch as any).mockResolvedValue(jsonResponse(200, { ok: true }));
    const http = createHttpClient();

    const onRejected = vi.fn();
    http.interceptors.request.use(() => {
      throw new Error('interceptor boom');
    }, onRejected);

    // The throw is caught and the request proceeds with the un-mutated config.
    const res = await http.get('/api/data');

    expect(res.ok).toBe(true);
    expect(onRejected).toHaveBeenCalledTimes(1);
    expect((onRejected.mock.calls[0][0] as Error).message).toBe('interceptor boom');
  });
});

describe('createHttpClient - primitive body serialization', () => {
  it('stringifies a primitive (number) body via String() with no JSON Content-Type', async () => {
    (globalThis.fetch as any).mockResolvedValue(jsonResponse(200, {}));
    const http = createHttpClient();

    await http.post('/api/raw', 12345);

    const [, init] = (globalThis.fetch as any).mock.calls[0];
    expect(init.body).toBe('12345');
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
      jsonResponse(422, { code: 'invalid', detail: 'Validation failed' }),
    );
    const http = createHttpClient();

    const result = await http.safe.patch('/api/users/1', { name: '' });

    expect(result.data).toBeNull();
    expect(problemOf(result.error)).toEqual({ status: 422, code: 'invalid', detail: 'Validation failed' });
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

    // Reading key-0 promotes it, so key-1 becomes the eviction candidate: LRU, not FIFO.
    expect(cache.get('key-0')).not.toBeNull();

    cache.set('key-50', { i: 50 }, 60_000); // 51st insert -> one eviction
    expect(cache.get('key-1')).toBeNull(); // the least recently used went
    expect(cache.get('key-0')).not.toBeNull(); // the recently read one stayed
    expect(cache.get('key-50')).not.toBeNull();
  });

  // Per client, never module-level: a shared cache would leak across concurrent SSR requests (the key has no auth or cookie dimension).
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
    a.setInflight('GET:json:/api/me', promise, '/api/me');

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

describe('cache.set at capacity (50 entries)', () => {
  it('evicts the least recently used entry, and only that one', () => {
    const cache = createResponseCache();
    for (let i = 0; i < 50; i++) cache.set(`json:/k${i}`, { i });
    cache.get('json:/k0'); // a hit moves k0 to the end; k1 is now the oldest
    cache.set('json:/k50', { i: 50 });
    expect(cache.getAny('json:/k1')).toBeNull();
    expect(cache.getAny('json:/k0')).not.toBeNull();
    expect(cache.getAny('json:/k2')).not.toBeNull();
    expect(cache.getAny('json:/k50')).not.toBeNull();
  });
});

describe('cache.invalidate', () => {
  it('removes entries whose URL (not the responseType prefix) matches', () => {
    const cache = createResponseCache();
    cache.set('json:/api/users/1', { id: 1 }, 60_000);
    cache.set('json:/api/users/2', { id: 2 }, 60_000);
    cache.set('json:/api/orders/1', { id: 1 }, 60_000);

    cache.invalidate((url) => url.startsWith('/api/users'));

    expect(cache.getAny('json:/api/users/1')).toBeNull();
    expect(cache.getAny('json:/api/users/2')).toBeNull();
    expect(cache.getAny('json:/api/orders/1')).not.toBeNull(); // untouched
  });

  it('is a no-op when nothing matches', () => {
    const cache = createResponseCache();
    cache.set('json:/api/orders/1', { id: 1 }, 60_000);
    cache.invalidate((url) => url === '/api/nothing-here');
    expect(cache.getAny('json:/api/orders/1')).not.toBeNull();
  });

});

describe('cached responses are immutable in dev (item 8)', () => {
  it('freezes the stored response and its payload', () => {
    const cache = createResponseCache();
    const response = { data: { items: [{ id: 1 }] }, status: 200, ok: true, headers: {} };
    cache.set('json:/api/items', response, 60_000);

    const hit = cache.get('json:/api/items')?.data as typeof response;
    // A consumer mutating in place would silently rewrite the cache for every later hit, so it throws at the mutation site.
    expect(() => {
      (hit.data.items as { id: number }[]).push({ id: 2 });
    }).toThrow();
    expect(() => {
      (hit as { status: number }).status = 500;
    }).toThrow();
    expect(hit.data.items).toHaveLength(1);
  });
});

describe('readCsrfToken - the TTL cache hit', () => {
  it('serves a second read from cache without touching the DOM again', () => {
    // Every csrf-enabled request inside the TTL reads the token from this cache.
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

    // Invalidating forces a fresh read.
    invalidateCsrfCache();
    expect(readCsrfToken()).toEqual(first);
    expect(domReads).toBe(2);
  });
});

describe('readCsrfToken - a document without querySelector', () => {
  it('skips both DOM probes and still reads the cookie', () => {
    // Some SSR and test harnesses expose only `cookie` on document, and a bare querySelector call on it would throw.
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
    // refreshCsrfOnce() resolves with the token, so a coalesced waiter never re-reads a cache or DOM another waiter cleared and retries with no CSRF header.
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
    // The coalescing promise is shared, so all waiters resolve with one agreed value instead of each re-reading the DOM when they resume.
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
  // Some fetch polyfills and hand-rolled doubles omit `headers`; the text and the json path must both tolerate that.
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

  it('does not throw on the DEFAULT json path', async () => {
    // An unguarded read would throw a TypeError; with no content-type the response yields raw text, as any content-type-less response does.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(headerless('{"fine":true}')));
    const client = createHttpClient();
    const res = await client.get('/api/thing');
    expect(res.headers).toEqual({});
    expect(res.data).toBe('{"fine":true}');
  });

  it('still parses JSON case-insensitively when headers ARE present', async () => {
    // The content-type read delegates to Headers.get(), which is case-insensitive by spec; reading the normalized object would miss and return a string.
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

describe('response header snapshot', () => {
  it('lower-cases keys so the case-sensitive consumer lookups cannot silently miss', async () => {
    // res.headers is read case-sensitively downstream (retry-after, x-ratelimit-reset, content-disposition); canonical casing would miss silently, so headersToObject lower-cases once.
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

    // The content-type decision still delegates to Headers.get(), so JSON parses regardless of casing.
    expect(res.data).toEqual({ parsed: true });
  });
});
