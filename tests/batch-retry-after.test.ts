/**
 * A batched result or a frame carries its own `headers`, and its `Retry-After` sets the wait as a response's does.
 * Why: a batch answers 200 for every command, so a command's wait lives in its result's own headers; a wait is never read from the body.
 * Shows: an idempotent action waits the declared seconds or HTTP-date, any case; others report the wait; a body `retryAfter` or an off-grammar value is no wait; WS frames alike.
 * See: RFC 9110 10.2.3, docs/contract.md section 4, OData JSON Format 4.01 section 19.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAsyncCommandBus, type BusError, type CommandResult } from '../src/command-bus';
import { problemOf } from '../src/http-errors';
import { httpTransport, wsTransport } from '../src/transports';
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
  const b = createAsyncCommandBus({ retry: idempotent ? { actionPolicies: { save: 'idempotent' } } : {}, transport: httpTransport({ endpoint: '/batch', batch: {} }) });
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
    const ws = wsTransport({ url: 'ws://x', reconnect: false });
    const b = createAsyncCommandBus({ retry: false, transport: ws });
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
