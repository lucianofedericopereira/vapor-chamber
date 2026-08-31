/**
 * Supplemental coverage for src/http.ts - the paths http-coverage.test.ts and
 * http-errors.test.ts leave open:
 *
 *  - postCommand: `silent` stamped on a PERMANENT failure re-thrown from the
 *    catch - the 4xx path, distinct from the already-covered `throw
 *    failed` stamp at 348.
 *  - clientRequest: pre-attempt user abort, 401 session expiry,
 *    and a mid-flight user abort surfacing as AbortError.
 *  - createHttpClient: response-interceptor `onRejected` on a failed request
 *, which only runs on the rejection branch.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { postCommand, createHttpClient, invalidateCsrfCache } from '../src/http';

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
// postCommand - silent on the permanent-failure re-throw
// ---------------------------------------------------------------------------

describe('postCommand - silent on permanent failures', () => {
  it('stamps silent on a 422 re-thrown from the catch and does not retry it', async () => {
    (globalThis.fetch as any).mockResolvedValue(jsonResponse(422, { error: 'invalid' }));

    await expect(
      postCommand('/api/vc', { command: 'save' }, { retry: 3, silent: true }),
    ).rejects.toMatchObject({ silent: true, status: 422 });

    // A permanent 4xx must not consume the retry budget.
    expect((globalThis.fetch as any).mock.calls).toHaveLength(1);
  });

  it('leaves silent unset by default on the same failure', async () => {
    (globalThis.fetch as any).mockResolvedValue(jsonResponse(422, { error: 'invalid' }));

    const err = await postCommand('/api/vc', { command: 'save' }, { retry: 1 }).catch(e => e);
    expect(err.status).toBe(422);
    expect(err.silent).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// clientRequest - abort and session-expiry paths
// ---------------------------------------------------------------------------

describe('createHttpClient - abort and session expiry', () => {
  it('throws AbortError before issuing a request when the signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    const http = createHttpClient();

    await expect(http.get('/api/data', { signal: ac.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect((globalThis.fetch as any)).not.toHaveBeenCalled();
  });

  it('checks the signal again before each retry attempt', async () => {
    const ac = new AbortController();
    (globalThis.fetch as any).mockImplementation(async () => {
      ac.abort(); // trip the signal while attempt 0 is in flight
      // 429 + `retry-after: 0` keeps the retry sleep at zero: the signal was
      // already aborted when sleepMs attached its listener, so the sleep runs
      // to completion and only the pre-attempt guard stops attempt 1.
      return mockResponse(429, { error: 'slow down' }, { 'content-type': 'application/json', 'retry-after': '0' });
    });

    const http = createHttpClient();
    await expect(http.get('/api/data', { retry: 2, signal: ac.signal })).rejects.toMatchObject({ name: 'AbortError' });
    // Attempt 0 ran; the pre-attempt guard stopped attempt 1.
    expect((globalThis.fetch as any).mock.calls).toHaveLength(1);
  });

  it('fires onSessionExpired on a 401', async () => {
    (globalThis.fetch as any).mockResolvedValue(jsonResponse(401, { message: 'Unauthenticated' }));
    const onSessionExpired = vi.fn();
    const http = createHttpClient();

    await expect(http.get('/api/me', { onSessionExpired })).rejects.toMatchObject({ status: 401 });
    expect(onSessionExpired).toHaveBeenCalledTimes(1);
  });

  it('rethrows a mid-flight user abort as AbortError without retrying', async () => {
    const ac = new AbortController();
    (globalThis.fetch as any).mockImplementation(async () => {
      ac.abort();
      throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    });

    const http = createHttpClient();
    await expect(http.get('/api/data', { retry: 2, signal: ac.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect((globalThis.fetch as any).mock.calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// createHttpClient - response interceptor onRejected
// ---------------------------------------------------------------------------

describe('createHttpClient - response interceptor onRejected', () => {
  it('runs onRejected with the error and still rejects', async () => {
    (globalThis.fetch as any).mockResolvedValue(jsonResponse(500, { error: 'boom' }));
    const onRejected = vi.fn();
    const onFulfilled = vi.fn(r => r);

    const http = createHttpClient({ retry: 0 });
    http.interceptors.response.use(onFulfilled, onRejected);

    await expect(http.get('/api/data')).rejects.toMatchObject({ status: 500 });
    expect(onRejected).toHaveBeenCalledTimes(1);
    expect((onRejected.mock.calls[0]![0] as any).status).toBe(500);
    expect(onFulfilled).not.toHaveBeenCalled();
  });

  it('stamps silent on the rejected error when config.silent is set', async () => {
    (globalThis.fetch as any).mockResolvedValue(jsonResponse(500, { error: 'boom' }));
    const http = createHttpClient();

    await expect(http.get('/api/data', { silent: true, retry: 0 })).rejects.toMatchObject({ silent: true });
  });
});
