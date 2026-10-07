/** A batched result or a frame carries its own `headers`, and its `Retry-After` sets the wait as a response's does. Rationale at the end. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAsyncCommandBus, type BusError, type CommandResult } from '../src/command-bus';
import { problemOf } from '../src/http-errors';
import { createBatchingHttpBridge, createWsBridge } from '../src/transports';
import { batchServer, MockWebSocket } from './backend-stubs';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const inProgress = { problem: { status: 409, code: 'in_progress', detail: 'Still running' } };
/** The first answer is `first`, every later one a success. */
const thenSaved = (first: Record<string, unknown>) => {
  let n = 0;
  return batchServer(() => (n++ === 0 ? first : { state: 'saved' }));
};
const bus = (idempotent: boolean) => {
  const b = createAsyncCommandBus({ retry: idempotent ? { actionPolicies: { save: 'idempotent' } } : {} });
  b.use(createBatchingHttpBridge({ endpoint: '/batch' }));
  return b;
};
const errorOf = (r: CommandResult) => r.error as BusError;

describe('a batched result with its own Retry-After', () => {
  it('an idempotent action waits the declared seconds, then lands', async () => {
    vi.useFakeTimers();
    const sent = thenSaved({ ...inProgress, headers: { 'Retry-After': '1' } });
    const p = bus(true).dispatch('save', { id: 1 });
    await vi.advanceTimersByTimeAsync(999);
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await p).toMatchObject({ ok: true, value: 'saved' });
    expect(sent).toHaveLength(2);
  });

  it('the name in any case, an HTTP-date as the header grammar reads it', async () => {
    vi.useFakeTimers();
    const sent = thenSaved({ ...inProgress, headers: { 'retry-after': new Date(Date.now() + 2000).toUTCString() } });
    const p = bus(true).dispatch('save', { id: 1 });
    await vi.advanceTimersByTimeAsync(2000);
    expect((await p).ok).toBe(true);
    expect(sent).toHaveLength(2);
  });

  it('an action not declared idempotent is not re-sent: the wait is reported, the problem unchanged', async () => {
    const sent = thenSaved({ ...inProgress, headers: { 'Retry-After': '1' } });
    const e = errorOf(await bus(false).dispatch('save', { id: 1 }));
    expect(e.code).toBe('remote:conflict:in_progress');
    expect(e.context?.retryIn).toBe(1000);
    expect(problemOf(e)).toEqual({ status: 409, code: 'in_progress', detail: 'Still running' });
    expect(sent).toHaveLength(1);
  });

  it('never from the body: a `retryAfter` member on the problem is a member, not a wait', async () => {
    thenSaved({ problem: { ...inProgress.problem, retryAfter: 1 } });
    const e = errorOf(await bus(false).dispatch('save', { id: 1 }));
    expect(e.context?.retryIn).toBeUndefined();
    expect(e.context?.retryAfter).toBe(1);
  });

  it('a value off the grammar, or not a string, is no wait', async () => {
    for (const value of ['-1', '1.5', 'soon', 1, ['1']]) {
      thenSaved({ ...inProgress, headers: { 'Retry-After': value } });
      expect(errorOf(await bus(false).dispatch('save', { id: 1 })).context?.retryIn).toBeUndefined();
    }
    for (const headers of [null, 'Retry-After: 1', ['1']]) {
      thenSaved({ ...inProgress, headers });
      expect(errorOf(await bus(false).dispatch('save', { id: 1 })).context?.retryIn).toBeUndefined();
    }
  });

  it('control: no headers, no wait, settled after one request', async () => {
    const sent = thenSaved(inProgress);
    const e = errorOf(await bus(true).dispatch('save', { id: 1 }));
    expect(e.code).toBe('remote:conflict:in_progress');
    expect(e.context?.retryIn).toBeUndefined();
    expect(sent).toHaveLength(1);
  });
});

describe('a WebSocket frame with its own Retry-After', () => {
  it('is read as a batched result is', async () => {
    let socket!: MockWebSocket;
    vi.stubGlobal('WebSocket', class extends MockWebSocket { constructor(url: string) { super(url); socket = this; } });
    const ws = createWsBridge({ url: 'ws://x', reconnect: false });
    const b = createAsyncCommandBus({ retry: false });
    b.use(ws);
    ws.connect();
    await Promise.resolve();
    const p = b.dispatch('save', { id: 1 });
    await Promise.resolve();
    const { id } = JSON.parse(socket.sent[0]) as { id: string };
    socket.receive({ id, ...inProgress, headers: { 'Retry-After': '1' } });
    expect(errorOf(await p).context?.retryIn).toBe(1000);
    ws.disconnect();
  });
});

/*
 * A single request declares its wait with a `Retry-After` header (RFC 9110
 * 10.2.3), and the contract reads it from the response, never from the body
 * (docs/plan-failures-and-contract.md 4.4). A batch answers 200 with one result
 * per command, so a command's failure has no response of its own. The standard
 * batch shape gives each result its own `headers`: OData's JSON batch response
 * (OData JSON Format 4.01, section 19), and Microsoft Graph's JSON batching,
 * which tells a client to read a throttled result's `retry-after` there. The
 * bridges read that object as a response's headers, by the same grammar
 * (delay-seconds or an HTTP-date) and case-insensitively (RFC 9110 5.1).
 * A `retryAfter` member on the problem was the proposal once recorded in 4.4.
 * No RFC defines it, and it would have read a wait from the body, so it stays
 * an ordinary problem member. The reference controller's `batch()` sends the
 * headers its command's own response would have had (`Retry-After: 1` on an
 * `in_progress`).
 */
