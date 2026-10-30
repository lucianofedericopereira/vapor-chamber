/**
 * A Retry-After over 30 s is read as declared and never waited out short, by the parser, the HTTP client, the async bus and the outbox.
 * Why: RFC 9110 10.2.3 makes Retry-After the minimum wait, with no ceiling. If the parser dropped a long wait, the HTTP client would retry sooner than asked, the outbox would see no retryIn and reject a 409 as a verdict, and the bus would re-send at its maxDelay instead of the declared wait. Each caller applies its own policy: the client does not wait over 30 s inside one request (it throws), the bus returns a declared wait over its maxDelay, the outbox waits it out.
 * Shows: delay-seconds and an HTTP-date past 30 s are read, and only a wait over 2^31 - 1 ms (what a timer can hold) is ignored; a 503 with Retry-After 120 is fetched once and thrown; a short Retry-After is retried; a retryIn of 25 s over maxDelay is returned, one of 1 s is re-sent; an outbox keeps a 409 with Retry-After 120 and flushes again 120 s later.
 * See: log s35.89, RFC 9110 10.2.3, src/bounds.ts
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { _failures, createAsyncCommandBus } from '../src/command-bus';
import { postCommand, _parseRetryAfter } from '../src/http';
import { createOutbox } from '../src/outbox';
import { httpTransport } from '../src/transports';
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
    const settled = postCommand('/api/cmd', {}, { retry: { maxAttempts: 3 } }).then(() => 'resolved', (e) => (e as { context?: { status?: number } }).context?.status);
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
    const pending = postCommand('/api/cmd', {}, { retry: { maxAttempts: 2 } });
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
    const outbox = createOutbox({ storage: null, isOnline: () => online });
    const bus = createAsyncCommandBus({ transport: httpTransport({ endpoint: '/api/vc' }), outbox });
    await bus.dispatch('orderA', {});
    online = true;

    expect(await outbox.flush()).toEqual({ replayed: 0, failed: 1, rejected: 0 });
    await vi.advanceTimersByTimeAsync(119_999);
    expect(sent.length).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent.length).toBe(2);
    expect(outbox.pending.value).toBe(0);
    outbox.dispose();
  });
});
