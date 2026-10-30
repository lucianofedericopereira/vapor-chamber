/**
 * postCommand and the CSRF token reader in src/http.ts: retry, timeout, abort, silent, session expiry, 419 refresh.
 * Why: a POST re-sent when it must be sent once could replay a mutation; a wrong CSRF refresh, abort, timeout or session-expiry path would leave a user's command failing or hanging.
 * Shows: postCommand sends JSON and merges headers; a 400, 403 or 422 is not re-sent; 503 and keyed no-reply POSTs are, honouring Retry-After for a keyed request; an unkeyed no-reply POST is not; timeout and abort give their transport codes; silent is stamped only when set; 401 calls onSessionExpired and dispatches an event; 419 refreshes the CSRF cookie once outside the retry budget; readCsrfToken reads the meta tag.
 * See: log s35.131
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  postCommand,
  readCsrfToken,
  invalidateCsrfCache,
} from '../src/http';

function mockResponse(status: number, body: unknown = null, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      entries: () => Object.entries(headers),
      get: (k: string) => headers[k.toLowerCase()] ?? null,
    },
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
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

describe('postCommand - basic', () => {
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

  it('throws the core failure on a non-retryable error status', async () => {
    (globalThis.fetch as any).mockResolvedValue(mockResponse(400, 'bad request'));

    await expect(postCommand('/api/cmd', {})).rejects.toMatchObject({ name: 'BusError', context: { status: 400 } });
  });

  it('merges extra headers', async () => {
    (globalThis.fetch as any).mockResolvedValue(mockResponse(200, {}));

    await postCommand('/api/cmd', {}, { headers: { Authorization: 'Bearer tok' } });

    const [, init] = (globalThis.fetch as any).mock.calls[0];
    expect(init.headers.Authorization).toBe('Bearer tok');
  });
});

describe('postCommand - retry', () => {
  it("does not re-send a 422: the server's verdict", async () => {
    (globalThis.fetch as any).mockResolvedValue(mockResponse(422));
    await expect(postCommand('/api/cmd', {}, { retry: { maxAttempts: 3 } })).rejects.toMatchObject({ context: { status: 422 } });
    expect((globalThis.fetch as any).mock.calls).toHaveLength(1);
  });

  it('an unkeyed request answered with Retry-After fails once, its retryIn kept', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    (globalThis.fetch as any).mockResolvedValue(mockResponse(409, null, { 'retry-after': '1' }));
    await expect(postCommand('/api/cmd', {}, { retry: { maxAttempts: 2 } })).rejects.toMatchObject({ context: { status: 409, retryIn: 1000 } });
    expect((globalThis.fetch as any).mock.calls).toHaveLength(1);
  });

  it('re-sends a keyed request that carries Retry-After, waiting what it says', async () => {
    (globalThis.fetch as any)
      .mockResolvedValueOnce(mockResponse(409, null, { 'retry-after': '1' }))
      .mockResolvedValueOnce(mockResponse(200, { state: 1 }));
    vi.useFakeTimers();
    const promise = postCommand('/api/cmd', {}, { retry: { maxAttempts: 2 }, headers: { 'Idempotency-Key': '"k"' } });
    await vi.advanceTimersByTimeAsync(999);
    expect((globalThis.fetch as any).mock.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    const res = await promise;
    expect(res.ok).toBe(true);
    expect((globalThis.fetch as any).mock.calls).toHaveLength(2);
  });

  it('retries on 503 and succeeds', async () => {
    (globalThis.fetch as any)
      .mockResolvedValueOnce(mockResponse(503))
      .mockResolvedValueOnce(mockResponse(200, { ok: true }));

    vi.useFakeTimers();
    const promise = postCommand('/api/cmd', {}, { retry: { maxAttempts: 2 } });
    await vi.runAllTimersAsync();
    const res = await promise;

    expect(res.ok).toBe(true);
    expect((globalThis.fetch as any).mock.calls).toHaveLength(2);
  });

  it('throws after exhausting retries', async () => {
    (globalThis.fetch as any).mockResolvedValue(mockResponse(503));

    vi.useFakeTimers();
    const promise = postCommand('/api/cmd', {}, { retry: { maxAttempts: 3 } });
    const assertion = expect(promise).rejects.toMatchObject({ name: 'BusError', context: { status: 503 } });
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
    const promise = postCommand('/api/cmd', {}, { retry: { maxAttempts: 2 } });
    await vi.advanceTimersByTimeAsync(retryAfterMs + 500);
    const res = await promise;

    expect(res.ok).toBe(true);
  });

  // No reply is `lost`: the POST may have landed, so it is re-sent only when safe to send twice, i.e. keyed.
  it('re-sends a POST with no reply only when it carries an Idempotency-Key', async () => {
    (globalThis.fetch as any)
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(mockResponse(200, { done: true }));

    vi.useFakeTimers();
    const promise = postCommand('/api/cmd', {}, { retry: { maxAttempts: 2 }, headers: { 'Idempotency-Key': '"k1"' } });
    await vi.runAllTimersAsync();
    const res = await promise;

    expect(res.ok).toBe(true);
    expect((globalThis.fetch as any).mock.calls).toHaveLength(2);
  });

  it('does not re-send a POST with no reply and no key', async () => {
    (globalThis.fetch as any).mockRejectedValue(new Error('network'));
    await expect(postCommand('/api/cmd', {}, { retry: { maxAttempts: 3 } })).rejects.toMatchObject({ code: 'transport:lost:reply' });
    expect((globalThis.fetch as any).mock.calls).toHaveLength(1);
  });

  it('throws on network error after exhausting retries', async () => {
    (globalThis.fetch as any).mockRejectedValue(new Error('network down'));

    vi.useFakeTimers();
    const promise = postCommand('/api/cmd', {}, { retry: { maxAttempts: 2 } });
    const assertion = expect(promise).rejects.toMatchObject({ code: 'transport:lost:reply', cause: { message: 'network down' } });
    await vi.runAllTimersAsync();
    await assertion;
  });

  it('does NOT retry a 403', async () => {
    (globalThis.fetch as any).mockResolvedValue(mockResponse(403));

    vi.useFakeTimers();
    const promise = postCommand('/api/cmd', {}, { retry: { maxAttempts: 3 } });
    const assertion = expect(promise).rejects.toMatchObject({ name: 'BusError', context: { status: 403 } });
    await vi.runAllTimersAsync();
    await assertion;

    expect((globalThis.fetch as any).mock.calls).toHaveLength(1);
  });
});

describe('postCommand - timeout', () => {
  it('throws transport:timeout:reply when request exceeds timeout', async () => {
    (globalThis.fetch as any).mockImplementation((_url: string, init: RequestInit) =>
      new Promise((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      })
    );

    vi.useFakeTimers();
    const promise = postCommand('/api/cmd', {}, { timeout: 100 });
    const assertion = expect(promise).rejects.toMatchObject({ code: 'transport:timeout:reply' });
    await vi.advanceTimersByTimeAsync(200);
    await assertion;
  });
});

describe('postCommand - user abort', () => {
  it('throws transport:aborted:request when user signal fires', async () => {
    const ctrl = new AbortController();
    (globalThis.fetch as any).mockImplementation((_url: string, init: RequestInit) =>
      new Promise((_, reject) => {
        if (init?.signal?.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      })
    );

    const promise = postCommand('/api/cmd', {}, { signal: ctrl.signal });
    ctrl.abort();

    await expect(promise).rejects.toMatchObject({ code: 'transport:aborted:request' });
  });

  it('short-circuits immediately if signal is already aborted', async () => {
    const ctrl = new AbortController();
    ctrl.abort();

    await expect(postCommand('/api/cmd', {}, { signal: ctrl.signal })).rejects.toMatchObject({ code: 'transport:aborted:request' });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe('postCommand - silent flag', () => {
  it('stamps error.context.silent when config.silent is true', async () => {
    (globalThis.fetch as any).mockResolvedValue(mockResponse(500, { message: 'boom' }));

    const err = await postCommand('/api/cmd', {}, { silent: true }).catch((e: any) => e);

    expect(err.context.silent).toBe(true);
  });

  it('stamps it on a request that got no response at all', async () => {
    (globalThis.fetch as any).mockRejectedValue(new TypeError('Failed to fetch'));

    const err = await postCommand('/api/cmd', {}, { silent: true }).catch((e: any) => e);

    expect(err.code).toBe('transport:lost:reply');
    expect(err.context.silent).toBe(true);
  });

  it('does not stamp without the flag', async () => {
    (globalThis.fetch as any).mockResolvedValue(mockResponse(500, { message: 'boom' }));

    const err = await postCommand('/api/cmd', {}).catch((e: any) => e);

    expect(err.context.silent).toBeUndefined();
  });
});

describe('postCommand - session expiry', () => {
  it('calls onSessionExpired on 401', async () => {
    (globalThis.fetch as any).mockResolvedValue(mockResponse(401));
    const onSessionExpired = vi.fn();

    await expect(postCommand('/api/cmd', {}, { onSessionExpired })).rejects.toMatchObject({ context: { status: 401 } });
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

describe('postCommand - CSRF 419 refresh', () => {
  // refreshCsrfOnce throws if readCsrfToken() is null after the refresh, and Node has no DOM, so a meta tag is faked.
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
      .mockResolvedValueOnce(mockResponse(419))          // original request -> 419
      .mockResolvedValueOnce(mockResponse(200, {}))      // GET /sanctum/csrf-cookie
      .mockResolvedValueOnce(mockResponse(200, { refreshed: true })); // retry -> 200

    const res = await postCommand('/api/cmd', {}, { retry: false });

    expect(res.ok).toBe(true);
    // call[0] = original POST, call[1] = csrf-cookie GET, call[2] = retry POST
    expect((globalThis.fetch as any).mock.calls).toHaveLength(3);
    expect((globalThis.fetch as any).mock.calls[1][0]).toBe('/sanctum/csrf-cookie');
    expect((globalThis.fetch as any).mock.calls[1][1].method).toBe('GET');
  });

  it('does not retry 419 a second time (csrfRetried guard)', async () => {
    (globalThis.fetch as any).mockResolvedValue(mockResponse(419));

    await expect(postCommand('/api/cmd', {}, { retry: false })).rejects.toMatchObject({ context: { status: 419 } });
    // call[0] = original POST, call[1] = csrf-cookie GET, call[2] = retry POST -> 419 again -> throw
    expect((globalThis.fetch as any).mock.calls).toHaveLength(3);
  });

  it('uses custom csrfCookieUrl when provided', async () => {
    (globalThis.fetch as any)
      .mockResolvedValueOnce(mockResponse(419))
      .mockResolvedValueOnce(mockResponse(200, {}))
      .mockResolvedValueOnce(mockResponse(200, {}));

    await postCommand('/api/cmd', {}, { retry: false, csrfCookieUrl: '/custom/csrf' });

    expect((globalThis.fetch as any).mock.calls[1][0]).toBe('/custom/csrf');
  });

  it('skips csrf-cookie fetch when csrfCookieUrl is empty string', async () => {
    (globalThis.fetch as any)
      .mockResolvedValueOnce(mockResponse(419))
      .mockResolvedValueOnce(mockResponse(200, {}));

    await postCommand('/api/cmd', {}, { retry: false, csrfCookieUrl: '' });

    // Only original POST + retry POST - no csrf-cookie fetch
    expect((globalThis.fetch as any).mock.calls).toHaveLength(2);
  });

  it('419 does NOT trigger onSessionExpired', async () => {
    (globalThis.fetch as any).mockResolvedValue(mockResponse(419));
    const onSessionExpired = vi.fn();

    await expect(postCommand('/api/cmd', {}, { onSessionExpired, retry: false })).rejects.toBeDefined();
    expect(onSessionExpired).not.toHaveBeenCalled();
  });
});

describe('readCsrfToken', () => {
  beforeEach(() => invalidateCsrfCache());

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
