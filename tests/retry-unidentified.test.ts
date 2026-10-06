/** An unidentified request that got no reply is not re-sent, and is reported; a declared wait decides when, never whether (plan 1.27 item 3). Rationale at the end. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BusError, createAsyncCommandBus, type AsyncCommandBusOptions, type CommandResult } from '../src/command-bus';
import { createHttpClient, invalidateCsrfCache, postCommand } from '../src/http';
import { optimisticUndo } from '../src/plugins-core';
import { createHttpBridge } from '../src/transports';
import { stubEnv } from '../src/vitest-pure';

type Answer = { status: number; body?: unknown; headers?: Record<string, string> };

/** A fetch that answers each call from `answers` (the last one repeats); 'hang' never answers until aborted. */
function fetchAnswering(...answers: Array<Answer | 'hang'>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch = vi.fn((url: string, init: RequestInit) => {
    calls.push({ url, init });
    const a = answers[Math.min(calls.length - 1, answers.length - 1)];
    if (a === 'hang') {
      return new Promise((_res, rej) => init.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))));
    }
    const headers = { 'content-type': 'application/json', ...a.headers };
    const text = a.body === undefined ? '' : typeof a.body === 'string' ? a.body : JSON.stringify(a.body);
    return Promise.resolve(new Response(text, { status: a.status, headers }));
  });
  vi.stubGlobal('fetch', fetch);
  return calls;
}

let warn: { mock: { calls: unknown[][] } };
const warnings = () => warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('unidentified'));

beforeEach(() => {
  invalidateCsrfCache();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** An async bus with the HTTP bridge, a short bridge timeout and a 1 ms backoff. */
function bridged(retry: AsyncCommandBusOptions['retry'] = { baseDelay: 1 }, key?: string) {
  const bus = createAsyncCommandBus({ retry });
  if (key) bus.use((cmd, next) => { cmd.meta!.idempotencyKey = key; return next(); }, { priority: 10 });
  bus.use(createHttpBridge({ endpoint: '/vc', timeout: 15 }));
  return bus;
}

const errorOf = (r: CommandResult) => r.error as BusError;

describe('the bus: no reply on an unidentified command', () => {
  it('a timeout is sent once, marked outcome unknown, with one warning for two failures', async () => {
    const calls = fetchAnswering('hang');
    const bus = bridged();
    const a = await bus.dispatch('cartAdd', { id: 1 }, { qty: 1 });
    const b = await bus.dispatch('cartAdd', { id: 2 }, { qty: 1 });
    expect(calls).toHaveLength(2);
    expect(errorOf(a).code).toBe('transport:timeout:reply');
    expect(errorOf(a).context?.outcome).toBe('unknown');
    expect(errorOf(b).context?.outcome).toBe('unknown');
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toContain('"cartAdd"');
  });

  it('a 504 and a 502 are sent once and marked', async () => {
    for (const status of [504, 502]) {
      const calls = fetchAnswering({ status, body: { detail: 'gateway' } });
      const r = await bridged().dispatch('cartAdd', { id: 1 });
      expect(calls, String(status)).toHaveLength(1);
      expect(errorOf(r).context?.outcome, String(status)).toBe('unknown');
    }
  });

  it('control: declared idempotent, it is re-sent and not marked', async () => {
    const calls = fetchAnswering('hang');
    const r = await bridged({ baseDelay: 1, actionPolicies: { cartAdd: 'idempotent' } }).dispatch('cartAdd', { id: 1 });
    expect(calls).toHaveLength(3);
    expect(errorOf(r).context?.outcome).toBeUndefined();
    expect(warnings()).toEqual([]);
  });

  it('control: a keyed command is re-sent', async () => {
    const calls = fetchAnswering('hang', 'hang', { status: 200, body: { state: 1 } });
    const r = await bridged({ baseDelay: 1 }, 'k1').dispatch('cartAdd', { id: 1 });
    expect(calls).toHaveLength(3);
    expect(r.ok).toBe(true);
  });

  it('retry: false marks nothing and warns nothing', async () => {
    fetchAnswering('hang');
    const r = await bridged(false).dispatch('cartAdd', { id: 1 });
    expect(errorOf(r).code).toBe('transport:timeout:reply');
    expect(errorOf(r).context?.outcome).toBeUndefined();
    expect(warnings()).toEqual([]);
  });

  it('control: 429, 503 and 408 are re-sent unkeyed; a 500 is sent once and not marked', async () => {
    for (const status of [429, 503, 408]) {
      const calls = fetchAnswering({ status, body: { detail: 'later' } }, { status: 200, body: { state: 1 } });
      const r = await bridged().dispatch('cartAdd', { id: 1 });
      expect(calls, String(status)).toHaveLength(2);
      expect(r.ok, String(status)).toBe(true);
    }
    const calls = fetchAnswering({ status: 500, body: { detail: 'broke' } });
    const r = await bridged().dispatch('cartAdd', { id: 1 });
    expect(calls).toHaveLength(1);
    expect(errorOf(r).context?.outcome).toBeUndefined();
    expect(warnings()).toEqual([]);
  });

  it('optimisticUndo rolls back, and onRollback reads the outcome', async () => {
    fetchAnswering('hang');
    const bus = bridged();
    let count = 0;
    bus.register('cartAdd', async () => { count++; }, { undo: () => { count--; } });
    const seen: unknown[] = [];
    bus.use(optimisticUndo(bus, ['cartAdd'], { onRollback: (_cmd, err) => seen.push((err as BusError).context?.outcome) }), { priority: 100 });
    count++; // the optimistic write the bridge's failure must take back
    expect((await bus.dispatch('cartAdd', { id: 1 })).ok).toBe(true); // the prediction, at once
    await vi.waitFor(() => expect(seen).toEqual(['unknown']));
    expect(count).toBe(0);
  });
});

describe('the bus: a declared wait decides when, never whether', () => {
  it('a 409 with Retry-After on an unkeyed command is not re-sent: retryIn kept, not marked, one warning', async () => {
    const calls = fetchAnswering({ status: 409, body: { detail: 'busy' }, headers: { 'retry-after': '0' } });
    const r = await bridged().dispatch('cartAdd', { id: 1 });
    expect(calls).toHaveLength(1);
    expect(errorOf(r).context?.retryIn).toBe(0);
    expect(errorOf(r).context?.outcome).toBeUndefined();
    expect(warnings()).toHaveLength(1);
  });

  it('control: keyed, the 409 with Retry-After is re-sent', async () => {
    const calls = fetchAnswering({ status: 409, body: { detail: 'in progress' }, headers: { 'retry-after': '0' } }, { status: 200, body: { state: 1 } });
    const r = await bridged({ baseDelay: 1 }, 'k1').dispatch('cartAdd', { id: 1 });
    expect(calls).toHaveLength(2);
    expect(r.ok).toBe(true);
  });
});

describe('the HTTP client', () => {
  it('a POST with no reply is sent once, marked, with one warning per method and URL', async () => {
    const calls = fetchAnswering('hang');
    const failures: BusError[] = [];
    for (let i = 0; i < 2; i++) await postCommand('/orders', { sku: 1 }, { retry: 2, timeout: 15 }).catch((e) => failures.push(e));
    expect(calls).toHaveLength(2);
    expect(failures.map((e) => [e.code, e.context?.outcome])).toEqual([['transport:timeout:reply', 'unknown'], ['transport:timeout:reply', 'unknown']]);
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toContain('POST "/orders"');
  });

  it('a 504 and a 502 on an unkeyed POST are sent once and marked', async () => {
    for (const status of [504, 502]) {
      const calls = fetchAnswering({ status, body: { detail: 'gateway' } });
      const e = await createHttpClient().post('/orders', { sku: 1 }, { retry: 2 }).catch((x) => x);
      expect(calls, String(status)).toHaveLength(1);
      expect((e as BusError).context?.outcome, String(status)).toBe('unknown');
    }
  });

  it('control: an Idempotency-Key in any case makes it re-sendable', async () => {
    vi.useFakeTimers();
    const calls = fetchAnswering('hang', 'hang', { status: 200, body: {} });
    const p = postCommand('/orders', { sku: 1 }, { retry: 2, timeout: 15, headers: { 'idempotency-key': '"k"' } });
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await p).ok).toBe(true);
    expect(calls).toHaveLength(3);
  });

  it('control: a GET with no reply is re-sent', async () => {
    vi.useFakeTimers();
    const calls = fetchAnswering('hang', { status: 200, body: { v: 1 } });
    const p = createHttpClient().get('/items', { timeout: 15 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await p).data).toEqual({ v: 1 });
    expect(calls).toHaveLength(2);
  });

  it('a 409 with Retry-After on an unkeyed POST fails once with retryIn; keyed, it is re-sent', async () => {
    let calls = fetchAnswering({ status: 409, body: { detail: 'busy' }, headers: { 'retry-after': '1' } });
    const e = await postCommand('/orders', {}, { retry: 1 }).catch((x) => x);
    expect(calls).toHaveLength(1);
    expect((e as BusError).context).toMatchObject({ status: 409, retryIn: 1000 });
    expect((e as BusError).context?.outcome).toBeUndefined();
    expect(warnings()).toHaveLength(1);
    vi.useFakeTimers();
    calls = fetchAnswering({ status: 409, body: null, headers: { 'retry-after': '1' } }, { status: 200, body: { state: 1 } });
    const p = postCommand('/orders', {}, { retry: 1, headers: { 'Idempotency-Key': '"k"' } });
    await vi.advanceTimersByTimeAsync(999);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect((await p).ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('RateLimit r=0 declares a wait of t seconds', async () => {
    vi.useFakeTimers();
    const calls = fetchAnswering({ status: 429, body: null, headers: { ratelimit: '"default";r=0;t=2' } }, { status: 200, body: {} });
    const p = postCommand('/orders', {}, { retry: 1 });
    await vi.advanceTimersByTimeAsync(1999);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect((await p).ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('control: RateLimit with quota left declares no wait (the backoff runs)', async () => {
    vi.useFakeTimers();
    const calls = fetchAnswering({ status: 429, body: null, headers: { ratelimit: '"default";r=5;t=30' } }, { status: 200, body: {} });
    const p = postCommand('/orders', {}, { retry: 1 });
    await vi.advanceTimersByTimeAsync(1200);
    expect((await p).ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('Retry-After takes precedence over RateLimit', async () => {
    vi.useFakeTimers();
    const calls = fetchAnswering({ status: 429, body: null, headers: { 'retry-after': '1', ratelimit: '"default";r=0;t=5' } }, { status: 200, body: {} });
    const p = postCommand('/orders', {}, { retry: 1 });
    await vi.advanceTimersByTimeAsync(1000);
    expect((await p).ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('control: a 2xx that is not JSON and a 500 are not marked', async () => {
    fetchAnswering({ status: 200, body: 'not json' });
    const a = await postCommand('/orders', {}, { retry: 2 }).catch((x) => x);
    expect((a as BusError).code).toBe('remote:unexpected:json');
    expect((a as BusError).context?.outcome).toBeUndefined();
    const calls = fetchAnswering({ status: 500, body: { detail: 'broke' } });
    const b = await postCommand('/orders', {}, { retry: 2 }).catch((x) => x);
    expect(calls).toHaveLength(1);
    expect((b as BusError).context?.outcome).toBeUndefined();
    expect(warnings()).toEqual([]);
  });
});

describe('production', () => {
  it('marks the failure and warns nothing', async () => {
    using _NODE_ENV = stubEnv('NODE_ENV', 'production');
    vi.resetModules();
    const { createAsyncCommandBus: bus } = await import('../src/command-bus');
    const { createHttpBridge: bridge } = await import('../src/transports');
    fetchAnswering('hang');
    const b = bus({ retry: { baseDelay: 1 } });
    b.use(bridge({ endpoint: '/vc', timeout: 15 }));
    const r = await b.dispatch('cartAdd', { id: 1 });
    expect((r.error as BusError).context?.outcome).toBe('unknown');
    expect(warnings()).toEqual([]);
    vi.resetModules();
  });
});

/*
 * RFC 9110 9.2.2: a client "SHOULD NOT automatically retry a request with a
 * non-idempotent method unless it has some means to know that the request
 * semantics are actually idempotent ... or some means to detect that the
 * original request was never applied." No reply in time (our transport's
 * timeout, a lost connection) and a gateway's 502 or 504 say nothing about
 * whether the request was applied, so only an identified command (an
 * idempotency key, a declared idempotent action, an idempotent method) is
 * sent again. The rest fails with its code, marked `outcome: 'unknown'`,
 * and development warns once per action (the bus) or per method and URL
 * (the client).
 *
 * RFC 9110 10.2.3: Retry-After is "how long the user agent ought to wait
 * before making a follow-up request". urllib3, gRPC A6 and ky read it as the
 * wait only. So a declared wait sets when, and identity decides whether.
 * The RateLimit field (draft-ietf-httpapi-ratelimit-headers-11) declares a
 * wait of `t` seconds when a policy's `r` is 0, and Retry-After "MUST take
 * precedence". Plan .probes/1.27-plan.md item 3, log s35.162.
 */
