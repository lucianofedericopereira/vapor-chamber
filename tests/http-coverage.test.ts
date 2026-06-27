/**
 * Supplemental coverage for src/http.ts.
 *
 * Targets the previously-uncovered regions:
 *  - readCsrfFromDom hidden-input fallback (116-121)
 *  - refreshCsrfOnce coalescing + failure paths (134-143, 158)
 *  - parseRetryAfter HTTP-date branch (177-182)
 *  - combineSignals AbortSignal.any fallback (197-201)
 *  - sleepMs abort path (208-209)
 *  - doClientFetch json content-type fallback (475)
 *  - clientRequest 419 CSRF retry + session-expiry-after-retry (519-524, 529)
 *  - clientRequest network-error retry (550)
 *  - request interceptor onRejected when onFulfilled throws (609)
 *  - String() body for primitive data (650)
 *  - safe.put / safe.patch / safe.delete wrappers (743-745)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  postCommand,
  createHttpClient,
  readCsrfToken,
  invalidateCsrfCache,
} from '../src/http';
import { clearAllCache } from '../src/http-cache';

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
  invalidateCsrfCache();
  clearAllCache();
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  invalidateCsrfCache();
});

// ---------------------------------------------------------------------------
// readCsrfToken — DOM source fallbacks
// ---------------------------------------------------------------------------

describe('readCsrfToken — DOM sources', () => {
  it('falls back to hidden input[name="_token"] when meta and cookie are absent (116-121)', () => {
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
// refreshCsrfOnce — coalescing + failure paths (driven via the 419 flow)
// ---------------------------------------------------------------------------

describe('refreshCsrfOnce — failure path (158)', () => {
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

describe('refreshCsrfOnce — coalescing (134-143)', () => {
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

  it('coalesced waiter throws when the in-flight refresh failed (140-142)', async () => {
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

    // Both reject — one from the primary refresh, one from the coalesced wait.
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
// parseRetryAfter — HTTP-date branch (177-182) via retry timing
// ---------------------------------------------------------------------------

describe('parseRetryAfter — HTTP-date Retry-After (177-182)', () => {
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

  it('returns null for an unparseable Retry-After and falls back to backoff (182)', async () => {
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
// combineSignals — AbortSignal.any fallback (197-201)
// ---------------------------------------------------------------------------

describe('combineSignals — fallback without AbortSignal.any (197-201)', () => {
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
// sleepMs — abort path (208-209) via user abort during retry backoff
// ---------------------------------------------------------------------------

describe('sleepMs — abort during retry backoff (208-209)', () => {
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
// doClientFetch — json content-type fallback to text (475)
// ---------------------------------------------------------------------------

describe('doClientFetch — non-JSON content-type falls back to text (475)', () => {
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
// clientRequest — 419 CSRF retry + session expiry after retry (519-524, 529)
// ---------------------------------------------------------------------------

describe('createHttpClient — 419 CSRF retry (519-524)', () => {
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

  it('after CSRF retry exhausted, a second 419 routes through session-expiry handling (529)', async () => {
    const onSessionExpired = vi.fn();
    // 419 -> refresh -> 419 again. Second time csrfRetried is true, so the
    // `res.status === 419 && csrfRetried` branch fires handleSessionExpiry,
    // then httpError is thrown (419 is not in RETRY_STATUS).
    (globalThis.fetch as any)
      .mockResolvedValueOnce(jsonResponse(419, { message: 'csrf' }))
      .mockResolvedValueOnce(mockResponse(200, {})) // csrf-cookie GET
      .mockResolvedValueOnce(jsonResponse(419, { message: 'csrf again' }));

    const http = createHttpClient({ csrf: true });

    await expect(http.post('/api/cmd', {}, { onSessionExpired })).rejects.toMatchObject({
      name: 'HttpError',
      status: 419,
    });
    expect(onSessionExpired).toHaveBeenCalledWith(419);
  });
});

// ---------------------------------------------------------------------------
// clientRequest — network-error retry backoff (550)
// ---------------------------------------------------------------------------

describe('createHttpClient — network error retry (550)', () => {
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
// request interceptor — onRejected when onFulfilled throws (609)
// ---------------------------------------------------------------------------

describe('createHttpClient — request interceptor error path (609)', () => {
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
// request body — String(rawData) for primitive data (650)
// ---------------------------------------------------------------------------

describe('createHttpClient — primitive body serialization (650)', () => {
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
// safe.put / safe.patch / safe.delete wrappers (743-745)
// ---------------------------------------------------------------------------

describe('createHttpClient — safe.put/patch/delete (743-745)', () => {
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
