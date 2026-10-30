/**
 * One reader for a response's declared wait: every bridge and the client's failure carry the wait the client sleeps.
 * Why: the wait is Retry-After, else RateLimit `t` with no quota left, else X-RateLimit-Reset; a bridge reading less re-sends inside the server's window.
 * Shows: each source and its precedence sets retryIn, on single, batched and app-client bridges, the outbox and postCommand; the bus and the client wait it, not a backoff.
 * See: docs/retry.md, log 36.42, RFC 9110 10.2.3, RFC 6585 4, draft-ietf-httpapi-ratelimit-headers-11.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type BusError, createAsyncCommandBus, type CommandResult } from '../src/command-bus';
import { invalidateCsrfCache, postCommand } from '../src/http';
import { createOutbox } from '../src/outbox';
import { httpTransport } from '../src/transports';
import { batchServer, singleServer } from './backend-stubs';

/** 2026-10-14 12:00:00 UTC, a whole second. */
const NOW = Date.UTC(2026, 9, 14, 12);
/** A Unix time `s` seconds after NOW, as Laravel and GitHub write X-RateLimit-Reset; digits a timer can wait read as delay seconds. */
const unix = (s: number) => String(NOW / 1000 + s);

/** A fetch answering each call from `answers` (the last one repeats), a 429 or a 200. */
function answering(...answers: Array<Record<string, string> | 'ok'>) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push(url);
    const a = answers[Math.min(calls.length - 1, answers.length - 1)];
    return a === 'ok'
      ? new Response('{"state":1}', { status: 200, headers: { 'content-type': 'application/json' } })
      : new Response('{"status":429,"code":"too_many"}', { status: 429, headers: { 'content-type': 'application/problem+json', ...a } });
  }));
  return calls;
}

const errorOf = (r: CommandResult) => r.error as BusError;
const bridged = (retry: false | { baseDelay: number } = false) => {
  const bus = createAsyncCommandBus({ retry, transport: httpTransport({ endpoint: '/vc' }) });
  return bus;
};

afterEach(() => {
  invalidateCsrfCache();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const declared: Array<[string, Record<string, string>, number]> = [
  ['Retry-After (control)', { 'Retry-After': '2' }, 2000],
  ['RateLimit t for a policy with no quota left', { RateLimit: '"default";r=0;t=2' }, 2000],
  ['X-RateLimit-Reset as delay seconds', { 'X-RateLimit-Reset': '2' }, 2000],
  ['X-RateLimit-Reset as Unix seconds', { 'X-RateLimit-Reset': unix(2) }, 2000],
  ['Retry-After over RateLimit and X-RateLimit-Reset', { 'Retry-After': '1', RateLimit: '"default";r=0;t=5', 'X-RateLimit-Reset': unix(9) }, 1000],
  ['RateLimit over X-RateLimit-Reset', { RateLimit: '"default";r=0;t=3', 'X-RateLimit-Reset': unix(9) }, 3000],
];
const none: Array<[string, Record<string, string>]> = [
  ['no field', {}],
  ['RateLimit with quota left', { RateLimit: '"default";r=5;t=30' }],
  ['an X-RateLimit-Reset already past', { 'X-RateLimit-Reset': unix(-5) }],
  ['an X-RateLimit-Reset no timer can hold', { 'X-RateLimit-Reset': unix(3_000_000) }],
];

describe('a bridged command carries the declared wait as retryIn', () => {
  it.each(declared)('%s', async (_label, headers, ms) => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    answering(headers);
    expect(errorOf(await bridged().dispatch('cartAdd', 1)).context?.retryIn).toBe(ms);
  });

  it.each(none)('control, no wait: %s', async (_label, headers) => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    answering(headers);
    const e = errorOf(await bridged().dispatch('cartAdd', 1));
    expect(e.code).toBe('remote:limited:too_many');
    expect(e.context?.retryIn).toBeUndefined();
  });

  it('the bus waits it: a 429 with RateLimit t=2 is re-sent after 2 s, not after its backoff', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const calls = answering({ RateLimit: '"default";r=0;t=2' }, 'ok');
    const p = bridged({ baseDelay: 1 }).dispatch('cartAdd', 1);
    await vi.advanceTimersByTimeAsync(1999);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect((await p).ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('the batching bridge: a whole-batch 429 with X-RateLimit-Reset as Unix seconds', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    answering({ 'X-RateLimit-Reset': unix(4) });
    const bus = createAsyncCommandBus({ retry: false, transport: httpTransport({ endpoint: '/batch', batch: {} }) });
    expect(errorOf(await bus.dispatch('cartAdd', 1)).context?.retryIn).toBe(4000);
  });
});

describe("a batched result's own headers are read as a response's", () => {
  const bus = () => {
    const b = createAsyncCommandBus({ retry: false, transport: httpTransport({ endpoint: '/batch', batch: {} }) });
    return b;
  };
  const limited = { problem: { status: 429, code: 'too_many' } };

  it('RateLimit and X-RateLimit-Reset, the names in any case', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    batchServer(() => ({ ...limited, headers: { ratelimit: '"default";r=0;t=2' } }));
    expect(errorOf(await bus().dispatch('save', 1)).context?.retryIn).toBe(2000);
    batchServer(() => ({ ...limited, headers: { 'X-RATELIMIT-RESET': unix(3) } }));
    expect(errorOf(await bus().dispatch('save', 1)).context?.retryIn).toBe(3000);
  });

  it('control: Retry-After still wins there, and a value that is not a string is no field', async () => {
    batchServer(() => ({ ...limited, headers: { 'Retry-After': '1', RateLimit: '"default";r=0;t=5' } }));
    expect(errorOf(await bus().dispatch('save', 1)).context?.retryIn).toBe(1000);
    batchServer(() => ({ ...limited, headers: { 'Retry-After': 1, RateLimit: '"default";r=0;t=5' } }));
    expect(errorOf(await bus().dispatch('save', 1)).context?.retryIn).toBe(5000);
  });
});

describe("an app's own httpClient: its header names in any case (RFC 9110 5.1)", () => {
  const bus = (httpClient: unknown) => {
    const b = createAsyncCommandBus({ retry: false, transport: httpTransport({ endpoint: '/vc', httpClient: httpClient as never }) });
    return b;
  };

  it('a non-2xx it returns', async () => {
    const client = { post: async () => ({ ok: false, status: 429, headers: { 'Retry-After': '2' }, data: { status: 429, code: 'too_many' } }) };
    expect(errorOf(await bus(client).dispatch('cartAdd', 1)).context?.retryIn).toBe(2000);
  });

  it('a failure it throws with a response', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const client = { post: async () => { throw Object.assign(new Error('429'), { response: { status: 429, headers: { 'X-RateLimit-Reset': unix(3) }, data: null } }); } };
    expect(errorOf(await bus(client).dispatch('cartAdd', 1)).context?.retryIn).toBe(3000);
  });

  it('the batching bridge, a non-2xx it returns', async () => {
    const b = createAsyncCommandBus({ retry: false, transport: httpTransport({ endpoint: '/batch', httpClient: { post: async () => ({ ok: false, status: 503, headers: { RateLimit: '"default";r=0;t=4' }, data: null }) } as never, batch: {} }) });
    expect(errorOf(await b.dispatch('cartAdd', 1)).context?.retryIn).toBe(4000);
  });
});

describe('the outbox reads the same wait', () => {
  it('a kept record is flushed again after a RateLimit t its answer declared', async () => {
    vi.useFakeTimers();
    let busy = true;
    const sent = singleServer(() => busy
      ? new Response('{"status":503,"code":"unavailable"}', { status: 503, headers: { 'content-type': 'application/problem+json', RateLimit: '"default";r=0;t=1' } })
      : [200, { state: 1 }]);
    let online = false;
    const outbox = createOutbox({ storage: null, isOnline: () => online });
    const bus = createAsyncCommandBus({ transport: httpTransport({ endpoint: '/api/vc' }), outbox });
    await bus.dispatch('orderA', {});
    online = true;
    expect(await outbox.flush()).toEqual({ replayed: 0, failed: 1, rejected: 0 });
    busy = false;
    await vi.advanceTimersByTimeAsync(999);
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toHaveLength(2);
    expect(outbox.pending.value).toBe(0);
    outbox.dispose();
  });
});

describe("the HTTP client's failure carries the wait it slept", () => {
  it.each(declared)('%s', async (_label, headers, ms) => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    answering(headers);
    const e = (await postCommand('/orders', {}, { retry: false }).catch((x) => x)) as BusError;
    expect(e.context?.retryIn).toBe(ms);
  });

  it('and sleeps a Unix-seconds X-RateLimit-Reset: re-sent at the reset, not after its backoff', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const calls = answering({ 'X-RateLimit-Reset': unix(2) }, 'ok');
    const p = postCommand('/orders', {}, { retry: { maxAttempts: 2 } });
    await vi.advanceTimersByTimeAsync(1999);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect((await p).ok).toBe(true);
    expect(calls).toHaveLength(2);
  });
});
