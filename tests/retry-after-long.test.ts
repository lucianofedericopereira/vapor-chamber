/** A Retry-After over 30 s is read as declared and never waited out short. Rationale at the end. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { _failures, createAsyncCommandBus, type BusError } from '../src/command-bus';
import { postCommand, _parseRetryAfter } from '../src/http';
import { createOutbox } from '../src/outbox';
import { createHttpBridge } from '../src/transports';
import { singleServer } from './backend-stubs';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function mockResponse(status: number, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300, status, statusText: 'x',
    headers: { entries: () => Object.entries(headers), get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: async () => null, text: async () => '', blob: async () => new Blob([]),
  };
}

describe('the parser reads what was declared', () => {
  it('delay-seconds and an HTTP-date past 30 s', () => {
    vi.useFakeTimers({ now: Date.parse('Wed, 01 Oct 2026 12:00:00 GMT') });
    expect(_parseRetryAfter('31')).toBe(31_000);
    expect(_parseRetryAfter('120')).toBe(120_000);
    expect(_parseRetryAfter('Wed, 01 Oct 2026 12:02:00 GMT')).toBe(120_000);
  });

  it('ignores only a wait no timer can hold (over 2^31 - 1 ms)', () => {
    expect(_parseRetryAfter('2147483')).toBe(2_147_483_000);
    expect(_parseRetryAfter('2147484')).toBeUndefined();
  });
});

describe('the HTTP client does not retry inside a request sooner than declared', () => {
  it('a 503 with Retry-After 120 is not retried in-request: one fetch, the failure thrown', async () => {
    const fetch = vi.fn().mockResolvedValue(mockResponse(503, { 'retry-after': '120' }));
    vi.stubGlobal('fetch', fetch);
    vi.useFakeTimers();
    const settled = postCommand('/api/cmd', {}, { retry: 2 }).then(() => 'resolved', (e) => (e as { context?: { status?: number } }).context?.status);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await settled).toBe(503);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('control: Retry-After 2 is waited out and retried', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(mockResponse(503, { 'retry-after': '2' }))
      .mockResolvedValueOnce(mockResponse(200, { 'content-type': 'application/json' }));
    vi.stubGlobal('fetch', fetch);
    vi.useFakeTimers();
    const pending = postCommand('/api/cmd', {}, { retry: 1 });
    await vi.advanceTimersByTimeAsync(2000);
    expect((await pending).status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe('the async bus does not re-send sooner than declared', () => {
  const busy = (retryIn: number) => _failures('app')('limited:quota', 'busy', { context: { retryIn } });

  it('a declared retryIn over maxDelay (25 s against 20 s) is returned, not re-sent at 20 s', async () => {
    vi.useFakeTimers();
    const bus = createAsyncCommandBus();
    let calls = 0;
    bus.register('save', async () => { calls++; throw busy(25_000); });
    const pending = bus.dispatch('save', {});
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await pending).toFailWith('app:limited:quota');
    expect(calls).toBe(1);
  });

  it('control: a declared retryIn under maxDelay is waited out and re-sent', async () => {
    vi.useFakeTimers();
    const bus = createAsyncCommandBus();
    let calls = 0;
    bus.register('save', async () => { calls++; if (calls === 1) throw busy(1000); return 'saved'; });
    const pending = bus.dispatch('save', {});
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toSucceedWith('saved');
    expect(calls).toBe(2);
  });
});

describe('the outbox gets the long wait', () => {
  it('a 409 with Retry-After 120 is kept and flushed again 120 s later', async () => {
    vi.useFakeTimers();
    let nth = 0;
    const sent = singleServer(() => (++nth === 1
      ? new Response(JSON.stringify({ status: 409, code: 'in_progress', detail: 'x' }), {
        status: 409, headers: { 'content-type': 'application/problem+json', 'retry-after': '120' },
      })
      : [200, { state: 1 }]));
    let online = false;
    const outbox = createOutbox({ storage: { load: () => null, save: () => {}, clear: () => {} }, isOnline: () => online });
    const bus = createAsyncCommandBus();
    outbox.install(bus);
    bus.use(createHttpBridge({ endpoint: '/api/vc' }));
    await bus.dispatch('orderA', {});
    online = true;
    const rejected: string[] = [];
    bus.on('outboxRejected', (cmd) => rejected.push((cmd.target as { error: BusError }).error.code));

    expect(await outbox.flush()).toEqual({ replayed: 0, failed: 1, rejected: 0 });
    expect(rejected).toEqual([]);
    await vi.advanceTimersByTimeAsync(119_999);
    expect(sent.length).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent.length).toBe(2);
    expect(outbox.pending.value).toBe(0);
    outbox.dispose();
  });
});

/*
 * Log s35.89. `_parseRetryAfter` returned undefined for any wait over 30 s
 * (`MAX_RETRY_AFTER_MS`), a policy of the HTTP client's in-request retry
 * living in the parser every caller shares. RFC 9110 10.2.3 makes Retry-After
 * the minimum time to wait, and its grammar has no ceiling (decision 13: the
 * exact grammar). Three consequences, each red before:
 * - the HTTP client read a 120 s header as "no header" and retried at once on
 *   its backoff, sooner than the server asked;
 * - the outbox saw no `retryIn`, so a 409 sent with `Retry-After: 120` was
 *   rejected as a verdict (a4f84fe's rule: a declared Retry-After is not one);
 * - the async bus slept `min(retryIn, maxDelay)`: a declared 25 s was re-sent
 *   at 20 s, also sooner than asked.
 * Now the parser reads what was declared, ignoring only what no timer can hold
 * (setTimeout fires at once past 2^31 - 1 ms, bounds.ts MAX_TIMEOUT_MS); each
 * caller applies its own policy: the client does not wait over 30 s inside one
 * request (it throws, with the header on the response for the bridge), the
 * bus returns a declared wait over its `maxDelay`, the outbox waits it out.
 */
