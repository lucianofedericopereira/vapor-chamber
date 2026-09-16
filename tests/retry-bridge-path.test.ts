/**
 * FIXTURE - retry() stacked in front of the real HTTP bridge.
 *
 * WHY THIS FILE EXISTS. The docs recommended exactly this stack (whitepaper
 * 11.7, examples/pattern-2-laravel-vite.ts, examples/feature-transports.ts),
 * and its two halves disagreed about the same failure. `postCommand` does not
 * re-send a 4xx - http.ts re-throws any response classifyError calls
 * permanent, a guard added because a 422 used to re-send a mutation. The
 * bridge then turns that throw into `{ ok: false, error }`, where
 * `error.code` is the BACKEND's own body code ('validation_failed' here) and
 * `error.status` is 422. retry()'s old default retried every error whose code
 * did not start with `VC_`, so the 422 re-entered the bridge and the write was
 * POSTed `maxAttempts` times. The HTTP layer refused to re-send it; the
 * plugin in front of it re-sent it anyway.
 *
 * Every earlier retry test used a mock bridge (tests/plugins-io.test.ts),
 * which is why none of them could see this: the error shape that matters is
 * the one the REAL bridge builds from a REAL HttpError. So this file drives
 * createAsyncCommandBus + retry() + createHttpBridge with only `fetch` stubbed.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAsyncCommandBus } from '../src/command-bus';
import { retry } from '../src/plugins-io';
import { createBatchingHttpBridge, createHttpBridge } from '../src/transports';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** The stack the docs recommended: retry() outer, the real bridge inner. */
function stack(opts: Parameters<typeof retry>[0] = { maxAttempts: 3 }) {
  const bus = createAsyncCommandBus();
  bus.use(retry(opts));
  bus.use(createHttpBridge({ endpoint: '/api/vc' }));
  return bus;
}

describe('retry() in front of the real HTTP bridge', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('a 422 is sent ONCE - retry() does not re-send what the HTTP layer calls permanent', async () => {
    const fetchMock = vi.fn(async () =>
      json(422, { ok: false, error: 'Invalid', code: 'validation_failed' }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await stack().dispatch('orderPlace', { id: 1 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toFailWith('validation_failed');
    // The shape the default predicate now reads: the backend's code, the status.
    const err = result.error as Error & { status?: number; code?: string };
    expect(err.message).toBe('Invalid');
    expect(err.status).toBe(422);
    expect(err.code).toBe('validation_failed');
  });

  it('the BATCHING bridge too: a 422 is sent once, with status and code on the error', async () => {
    // createBatchingHttpBridge built its error from the body message alone -
    // no status, no code - so the status rule had nothing to read and the
    // whole batch POST was re-sent `maxAttempts` times.
    const fetchMock = vi.fn(async () =>
      json(422, { ok: false, error: 'Invalid', code: 'validation_failed' }));
    vi.stubGlobal('fetch', fetchMock);

    const bus = createAsyncCommandBus();
    bus.use(retry({ maxAttempts: 3, baseDelay: 0 }));
    bus.use(createBatchingHttpBridge({ endpoint: '/api/vc/batch' }));
    const result = await bus.dispatch('orderPlace', { id: 1 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toFailWith('validation_failed');
    const err = result.error as Error & { status?: number; code?: string; response?: unknown };
    expect(err.message).toBe('Invalid');
    expect(err.name).toBe('HttpError');
    expect(err.status).toBe(422);
    expect(err.code).toBe('validation_failed');
    expect(err.response).toBeDefined();
  });

  it('the batching bridge copies only what is there: no status or code, none invented', async () => {
    // An httpClient that rejects with a body message but no status/code - the
    // shape a custom client or interceptor can produce.
    const httpClient = {
      post: vi.fn(async () => {
        throw Object.assign(new Error('raw'), { response: { data: { error: 'Nope' } } });
      }),
    } as any;
    const bus = createAsyncCommandBus();
    bus.use(createBatchingHttpBridge({ endpoint: '/api/vc/batch', httpClient }));
    const result = await bus.dispatch('orderPlace', { id: 1 });

    const err = result.error as Error & { status?: number; code?: string };
    expect(err.message).toBe('Nope');
    expect(err.status).toBeUndefined();
    expect(err.code).toBeUndefined();
  });

  it('the retry path still works: 503 then 200 is two calls and ok', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(503, { ok: false, error: 'Down' }))
      .mockResolvedValueOnce(json(200, { ok: true, state: { id: 1 } }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await stack({ maxAttempts: 3, baseDelay: 0 }).dispatch('orderPlace', { id: 1 });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toSucceedWith({ id: 1 });
  });

  it('reads the status from error.response.status too, and still retries a status-less error', async () => {
    // The http client's HttpError, thrown from an ordinary handler, carries
    // `response.status`; a network failure carries no status at all.
    const run = async (error: Error) => {
      let calls = 0;
      await retry({ maxAttempts: 3, baseDelay: 0 })(
        { action: 'save', target: {}, meta: {} } as any,
        () => { calls++; return { ok: false, error } as any; },
      );
      return calls;
    };
    expect(await run(Object.assign(new Error('gone'), { response: { status: 404 } }))).toBe(1);
    expect(await run(Object.assign(new Error('flaky'), { response: { status: 502 } }))).toBe(3);
    expect(await run(new TypeError('Failed to fetch'))).toBe(3);
  });

  it('a user abort mid-flight is not retried: one request, no backoff sleep left behind', async () => {
    // postCommand re-throws the abort as a DOMException AbortError, whose
    // `code` is the NUMBER 20. The old default read "not a string code" as
    // retryable, so retry() scheduled its backoff sleeps and the caller waited
    // them out after cancelling - nothing was re-sent (postCommand throws on an
    // aborted signal before fetching), but the dispatch did not settle until
    // every sleep had run.
    vi.useFakeTimers();
    const fetchMock = vi.fn((_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      }));
    vi.stubGlobal('fetch', fetchMock);
    const flush = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };

    const ctrl = new AbortController();
    let settled: any;
    const pending = stack({ maxAttempts: 3 })
      .dispatch('orderPlace', { id: 1 }, undefined, { signal: ctrl.signal })
      .then((r) => { settled = r; });

    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1); // the request is in flight
    ctrl.abort();
    await flush();

    // Settled on the abort itself, with no backoff timer scheduled.
    expect(vi.getTimerCount()).toBe(0);
    expect(settled?.ok).toBe(false);
    expect(settled.error.name).toBe('AbortError');

    await vi.runAllTimersAsync();
    await pending;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('408 and 429 stay retryable - the same set the HTTP layer retries', async () => {
    for (const status of [408, 429]) {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(json(status, { ok: false, error: 'Slow down' }))
        .mockResolvedValueOnce(json(200, { ok: true, state: 'done' }));
      vi.stubGlobal('fetch', fetchMock);

      const result = await stack({ maxAttempts: 3, baseDelay: 0 }).dispatch('cartSync', {});
      expect(fetchMock, `status ${status}`).toHaveBeenCalledTimes(2);
      expect(result.ok).toBe(true);
    }
  });
});
