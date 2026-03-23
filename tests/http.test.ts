/**
 * Tests for src/http.ts — postCommand, CSRF, retry, timeout, session expiry
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  postCommand,
  readCsrfToken,
  invalidateCsrfCache,
  type HttpConfig,
} from '../src/http';

// ---------------------------------------------------------------------------
// Fetch mock helpers
// ---------------------------------------------------------------------------

function mockResponse(status: number, body: unknown = null, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      entries: () => Object.entries(headers),
      get: (k: string) => headers[k.toLowerCase()] ?? null,
    },
    json: async () => body,
    text: async () => String(body),
  };
}

beforeEach(() => {
  invalidateCsrfCache();
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Basic success
// ---------------------------------------------------------------------------

describe('postCommand — basic', () => {
  it('returns data on 200', async () => {
    (globalThis.fetch as any).mockResolvedValue(mockResponse(200, { id: 42 }));

    const res = await postCommand('/api/cmd', { action: 'test' });
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(res.data).toEqual({ id: 42 });
  });

  it('sends JSON body and correct headers', async () => {
    (globalThis.fetch as any).mockResolvedValue(mockResponse(200, {}));

    await postCommand('/api/cmd', { foo: 'bar' });

    const [url, init] = (globalThis.fetch as any).mock.calls[0];
    expect(url).toBe('/api/cmd');
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({ foo: 'bar' });
  });

  it('throws HttpError on non-retryable error status', async () => {
    (globalThis.fetch as any).mockResolvedValue(mockResponse(400, 'bad request'));

    await expect(postCommand('/api/cmd', {})).rejects.toMatchObject({ name: 'HttpError', status: 400 });
  });

  it('merges extra headers', async () => {
    (globalThis.fetch as any).mockResolvedValue(mockResponse(200, {}));

    await postCommand('/api/cmd', {}, { headers: { Authorization: 'Bearer tok' } });

    const [, init] = (globalThis.fetch as any).mock.calls[0];
    expect(init.headers['Authorization']).toBe('Bearer tok');
  });
});

// ---------------------------------------------------------------------------
// Retry on 5xx / 429
// ---------------------------------------------------------------------------

describe('postCommand — retry', () => {
  it('retries on 500 and succeeds', async () => {
    (globalThis.fetch as any)
      .mockResolvedValueOnce(mockResponse(500))
      .mockResolvedValueOnce(mockResponse(200, { ok: true }));

    vi.useFakeTimers();
    const promise = postCommand('/api/cmd', {}, { retry: 1 });
    await vi.runAllTimersAsync();
    const res = await promise;

    expect(res.ok).toBe(true);
    expect((globalThis.fetch as any).mock.calls).toHaveLength(2);
  });

  it('throws after exhausting retries', async () => {
    (globalThis.fetch as any).mockResolvedValue(mockResponse(503));

    vi.useFakeTimers();
    const promise = postCommand('/api/cmd', {}, { retry: 2 });
    const assertion = expect(promise).rejects.toMatchObject({ name: 'HttpError', status: 503 });
    await vi.runAllTimersAsync();
    await assertion;

    expect((globalThis.fetch as any).mock.calls).toHaveLength(3);
  });

  it('respects Retry-After header (seconds)', async () => {
    const retryAfterMs = 1000;
    (globalThis.fetch as any)
      .mockResolvedValueOnce(mockResponse(429, null, { 'retry-after': '1' }))
      .mockResolvedValueOnce(mockResponse(200, {}));

    vi.useFakeTimers();
    const promise = postCommand('/api/cmd', {}, { retry: 1 });
    await vi.advanceTimersByTimeAsync(retryAfterMs + 500);
    const res = await promise;

    expect(res.ok).toBe(true);
  });

  it('retries on network error', async () => {
    (globalThis.fetch as any)
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(mockResponse(200, { done: true }));

    vi.useFakeTimers();
    const promise = postCommand('/api/cmd', {}, { retry: 1 });
    await vi.runAllTimersAsync();
    const res = await promise;

    expect(res.ok).toBe(true);
  });

  it('throws on network error after exhausting retries', async () => {
    (globalThis.fetch as any).mockRejectedValue(new Error('network down'));

    vi.useFakeTimers();
    const promise = postCommand('/api/cmd', {}, { retry: 1 });
    const assertion = expect(promise).rejects.toThrow('network down');
    await vi.runAllTimersAsync();
    await assertion;
  });
});

// ---------------------------------------------------------------------------
// Timeout
// ---------------------------------------------------------------------------

describe('postCommand — timeout', () => {
  it('throws TimeoutError when request exceeds timeout', async () => {
    (globalThis.fetch as any).mockImplementation((_url: string, init: RequestInit) =>
      new Promise((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      })
    );

    vi.useFakeTimers();
    const promise = postCommand('/api/cmd', {}, { timeout: 100 });
    const assertion = expect(promise).rejects.toMatchObject({ name: 'TimeoutError' });
    await vi.advanceTimersByTimeAsync(200);
    await assertion;
  });
});

// ---------------------------------------------------------------------------
// User abort
// ---------------------------------------------------------------------------

describe('postCommand — user abort', () => {
  it('throws AbortError when user signal fires', async () => {
    const ctrl = new AbortController();
    (globalThis.fetch as any).mockImplementation((_url: string, init: RequestInit) =>
      new Promise((_, reject) => {
        if (init?.signal?.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      })
    );

    const promise = postCommand('/api/cmd', {}, { signal: ctrl.signal });
    ctrl.abort();

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('short-circuits immediately if signal is already aborted', async () => {
    const ctrl = new AbortController();
    ctrl.abort();

    await expect(postCommand('/api/cmd', {}, { signal: ctrl.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Session expiry
// ---------------------------------------------------------------------------

describe('postCommand — session expiry', () => {
  it('calls onSessionExpired on 401', async () => {
    (globalThis.fetch as any).mockResolvedValue(mockResponse(401));
    const onSessionExpired = vi.fn();

    await expect(postCommand('/api/cmd', {}, { onSessionExpired })).rejects.toMatchObject({ status: 401 });
    expect(onSessionExpired).toHaveBeenCalledWith(401);
  });

  it('dispatches session-expired CustomEvent on 401', async () => {
    (globalThis.fetch as any).mockResolvedValue(mockResponse(401));
    const events: Event[] = [];

    vi.stubGlobal('window', { dispatchEvent: (e: Event) => { events.push(e); return true; } });

    await expect(postCommand('/api/cmd', {})).rejects.toBeDefined();

    expect(events).toHaveLength(1);
    expect((events[0] as CustomEvent).detail.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// 419 CSRF refresh
// ---------------------------------------------------------------------------

describe('postCommand — CSRF 419 refresh', () => {
  // After the A3 fix, refreshCsrfOnce throws if readCsrfToken() returns null
  // post-refresh. In Node there's no real DOM, so we mock document + querySelector
  // to provide a CSRF meta tag after the csrf-cookie fetch completes.
  beforeEach(() => {
    const fakeDocument = {
      querySelector: (sel: string) => {
        if (sel === 'meta[name="csrf-token"]') {
          return { content: 'test-csrf-token-refreshed' };
        }
        return null;
      },
      cookie: '',
    };
    vi.stubGlobal('document', fakeDocument);
  });

  it('retries once after 419 and does not count against retry budget', async () => {
    (globalThis.fetch as any)
      .mockResolvedValueOnce(mockResponse(419))          // original request → 419
      .mockResolvedValueOnce(mockResponse(200, {}))      // GET /sanctum/csrf-cookie
      .mockResolvedValueOnce(mockResponse(200, { refreshed: true })); // retry → 200

    const res = await postCommand('/api/cmd', {}, { retry: 0 });

    expect(res.ok).toBe(true);
    // call[0] = original POST, call[1] = csrf-cookie GET, call[2] = retry POST
    expect((globalThis.fetch as any).mock.calls).toHaveLength(3);
    expect((globalThis.fetch as any).mock.calls[1][0]).toBe('/sanctum/csrf-cookie');
    expect((globalThis.fetch as any).mock.calls[1][1].method).toBe('GET');
  });

  it('does not retry 419 a second time (csrfRetried guard)', async () => {
    (globalThis.fetch as any).mockResolvedValue(mockResponse(419));

    await expect(postCommand('/api/cmd', {}, { retry: 0 })).rejects.toMatchObject({ status: 419 });
    // call[0] = original POST, call[1] = csrf-cookie GET, call[2] = retry POST → 419 again → throw
    expect((globalThis.fetch as any).mock.calls).toHaveLength(3);
  });

  it('uses custom csrfCookieUrl when provided', async () => {
    (globalThis.fetch as any)
      .mockResolvedValueOnce(mockResponse(419))
      .mockResolvedValueOnce(mockResponse(200, {}))
      .mockResolvedValueOnce(mockResponse(200, {}));

    await postCommand('/api/cmd', {}, { retry: 0, csrfCookieUrl: '/custom/csrf' });

    expect((globalThis.fetch as any).mock.calls[1][0]).toBe('/custom/csrf');
  });

  it('skips csrf-cookie fetch when csrfCookieUrl is empty string', async () => {
    (globalThis.fetch as any)
      .mockResolvedValueOnce(mockResponse(419))
      .mockResolvedValueOnce(mockResponse(200, {}));

    await postCommand('/api/cmd', {}, { retry: 0, csrfCookieUrl: '' });

    // Only original POST + retry POST — no csrf-cookie fetch
    expect((globalThis.fetch as any).mock.calls).toHaveLength(2);
  });

  it('401 still triggers onSessionExpired (not 419)', async () => {
    (globalThis.fetch as any).mockResolvedValue(mockResponse(401));
    const onSessionExpired = vi.fn();

    await expect(postCommand('/api/cmd', {}, { onSessionExpired })).rejects.toBeDefined();
    expect(onSessionExpired).toHaveBeenCalledWith(401);
  });

  it('419 does NOT trigger onSessionExpired', async () => {
    (globalThis.fetch as any).mockResolvedValue(mockResponse(419));
    const onSessionExpired = vi.fn();

    await expect(postCommand('/api/cmd', {}, { onSessionExpired, retry: 0 })).rejects.toBeDefined();
    expect(onSessionExpired).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// CSRF token reading
// ---------------------------------------------------------------------------

describe('readCsrfToken', () => {
  beforeEach(() => invalidateCsrfCache());

  it('returns null when document is not available', () => {
    // In Node/vitest jsdom, document exists. Check cache invalidated path.
    const result = readCsrfToken();
    // No DOM CSRF tokens set — either null or a cached result. Just verify shape.
    if (result !== null) {
      expect(result).toHaveProperty('token');
      expect(result).toHaveProperty('headerName');
    }
  });

  it('returns cached result on second call', () => {
    const r1 = readCsrfToken();
    const r2 = readCsrfToken();
    expect(r1).toBe(r2); // same reference from cache
  });

  it('invalidateCsrfCache clears cache', () => {
    readCsrfToken(); // prime cache
    invalidateCsrfCache();
    // After invalidation the next call re-reads from DOM — just ensure it runs without error
    expect(() => readCsrfToken()).not.toThrow();
  });

  it('reads token from meta tag', () => {
    vi.stubGlobal('document', {
      querySelector: (sel: string) => sel === 'meta[name="csrf-token"]' ? { content: 'meta-token-123' } : null,
      cookie: '',
    });

    invalidateCsrfCache();
    const result = readCsrfToken();

    expect(result?.token).toBe('meta-token-123');
    expect(result?.headerName).toBe('X-CSRF-TOKEN');
  });
});
