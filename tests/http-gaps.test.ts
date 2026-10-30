/**
 * postCommand and createHttpClient on permanent failures, aborts, 401 and rejected responses.
 * Why: a permanent 4xx that burned the retry budget or lost the silent flag, an aborted caller that still sent or retried, a 401 that did not signal session expiry, or a rejection that skipped the response interceptor would each break error handling for callers. Also the only file reaching the already-aborted signal arm and a response interceptor's onRejected on failure, so the 100% floor needs it.
 * Shows: postCommand stamps silent on a 422 only when asked and sends it once; an already-aborted signal sends nothing; the signal is checked again before each retry; a 401 calls onSessionExpired once; a mid-flight abort rejects as transport:aborted:request without retrying; onRejected runs with the error and the request still rejects; silent is stamped on a rejected error.
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

describe('postCommand - silent on permanent failures', () => {
  it('stamps silent on a 422 re-thrown from the catch and does not retry it', async () => {
    (globalThis.fetch as any).mockResolvedValue(jsonResponse(422, { error: 'invalid' }));

    await expect(
      postCommand('/api/vc', { command: 'save' }, { retry: { maxAttempts: 4 }, silent: true }),
    ).rejects.toMatchObject({ context: { silent: true, status: 422 } });

    // A permanent 4xx must not consume the retry budget.
    expect((globalThis.fetch as any).mock.calls).toHaveLength(1);
  });

  it('leaves silent unset by default on the same failure', async () => {
    (globalThis.fetch as any).mockResolvedValue(jsonResponse(422, { error: 'invalid' }));

    const err = await postCommand('/api/vc', { command: 'save' }, { retry: { maxAttempts: 2 } }).catch(e => e);
    expect(err.context.status).toBe(422);
    expect(err.context.silent).toBeUndefined();
  });
});

describe('createHttpClient - abort and session expiry', () => {
  it('throws AbortError before issuing a request when the signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    const http = createHttpClient();

    await expect(http.get('/api/data', { signal: ac.signal })).rejects.toMatchObject({ code: 'transport:aborted:request' });
    expect((globalThis.fetch as any)).not.toHaveBeenCalled();
  });

  it('checks the signal again before each retry attempt', async () => {
    const ac = new AbortController();
    (globalThis.fetch as any).mockImplementation(async () => {
      ac.abort(); // trip the signal while attempt 0 is in flight
      // retry-after: 0 keeps the sleep at zero, so only the pre-attempt guard can stop attempt 1.
      return mockResponse(429, { error: 'slow down' }, { 'content-type': 'application/json', 'retry-after': '0' });
    });

    const http = createHttpClient();
    await expect(http.get('/api/data', { retry: { maxAttempts: 3 }, signal: ac.signal })).rejects.toMatchObject({ code: 'transport:aborted:request' });
    expect((globalThis.fetch as any).mock.calls).toHaveLength(1);
  });

  it('fires onSessionExpired on a 401', async () => {
    (globalThis.fetch as any).mockResolvedValue(jsonResponse(401, { message: 'Unauthenticated' }));
    const onSessionExpired = vi.fn();
    const http = createHttpClient();

    await expect(http.get('/api/me', { onSessionExpired })).rejects.toMatchObject({ context: { status: 401 } });
    expect(onSessionExpired).toHaveBeenCalledTimes(1);
  });

  it('rethrows a mid-flight user abort as AbortError without retrying', async () => {
    const ac = new AbortController();
    (globalThis.fetch as any).mockImplementation(async () => {
      ac.abort();
      throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    });

    const http = createHttpClient();
    await expect(http.get('/api/data', { retry: { maxAttempts: 3 }, signal: ac.signal })).rejects.toMatchObject({ code: 'transport:aborted:request' });
    expect((globalThis.fetch as any).mock.calls).toHaveLength(1);
  });
});

describe('createHttpClient - response interceptor onRejected', () => {
  it('runs onRejected with the error and still rejects', async () => {
    (globalThis.fetch as any).mockResolvedValue(jsonResponse(500, { error: 'boom' }));
    const onRejected = vi.fn();
    const onFulfilled = vi.fn(r => r);

    const http = createHttpClient({ retry: false });
    http.interceptors.response.use(onFulfilled, onRejected);

    await expect(http.get('/api/data')).rejects.toMatchObject({ context: { status: 500 } });
    expect(onRejected).toHaveBeenCalledTimes(1);
    expect((onRejected.mock.calls[0]![0] as any).context.status).toBe(500);
    expect(onFulfilled).not.toHaveBeenCalled();
  });

  it('stamps silent on the rejected error when config.silent is set', async () => {
    (globalThis.fetch as any).mockResolvedValue(jsonResponse(500, { error: 'boom' }));
    const http = createHttpClient();

    await expect(http.get('/api/data', { silent: true, retry: false })).rejects.toMatchObject({ context: { silent: true } });
  });
});
