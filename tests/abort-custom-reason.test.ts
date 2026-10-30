/**
 * A cancel whose reason is the caller's own Error, read by failureCondition and the async retry budget.
 * Why: a failure is a cancel when it IS the signal's reason; read by name, it counts as a failure and spends retry tokens.
 * Shows: the own-Error reason reads as aborted given the signal, a different Error stays failed, cancels spend no retry token.
 * See: audit D4, src/failure.ts, tests/circuit-breaker-cancel.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { BusError, createAsyncCommandBus, failureCondition, type Command } from '../src/command-bus';

/** Answers after 20 ms, or rejects with the signal's reason when aborted. */
const slow = (cmd: Command) => new Promise((resolve, reject) => {
  const t = setTimeout(() => resolve('done'), 20);
  cmd.signal?.addEventListener('abort', () => { clearTimeout(t); reject(cmd.signal!.reason); }, { once: true });
});

async function cancelled(bus: ReturnType<typeof createAsyncCommandBus>, action: string, reason?: unknown) {
  const ac = new AbortController();
  const p = bus.dispatch(action, null, undefined, { signal: ac.signal });
  setTimeout(() => (reason === undefined ? ac.abort() : ac.abort(reason)), 2);
  return { result: await p, signal: ac.signal };
}

describe('failureCondition(error, signal)', () => {
  it('reads the caller\'s own Error reason as aborted, given the signal', async () => {
    const bus = createAsyncCommandBus({ retry: false });
    bus.register('search', slow);
    const mine = new Error('user cancelled');
    const { result, signal } = await cancelled(bus, 'search', mine);
    expect(result.error).toBe(mine); // the app still gets its own Error
    expect(failureCondition(result.error, signal)).toBe('aborted');
  });

  it('control: without the signal it answers as before, and a different Error is not the reason', async () => {
    const mine = new Error('user cancelled');
    const ac = new AbortController();
    ac.abort(mine);
    expect(failureCondition(mine)).toBe('failed');
    expect(failureCondition(new Error('HTTP 500'), ac.signal)).toBe('failed');
    expect(failureCondition(new DOMException('x', 'AbortError'))).toBe('aborted');
  });
});

describe('the async retry budget', () => {
  it('cancels with an Error reason spend no retry tokens', async () => {
    const bus = createAsyncCommandBus({ retry: { actionPolicies: { search: 'idempotent' }, baseDelay: 1 } });
    bus.register('search', slow);
    let calls = 0;
    bus.register('save', async () => {
      calls++;
      if (calls === 1) throw new BusError('limited:save', 'busy', { context: { retryIn: 1 } });
      return 'saved';
    });
    for (let i = 0; i < 8; i++) await cancelled(bus, 'search', new Error('user cancelled'));
    const saved = await bus.dispatch('save', null);
    expect({ ok: saved.ok, calls }).toEqual({ ok: true, calls: 2 });
  });

  it('control: the same with ac.abort() and no reason', async () => {
    const bus = createAsyncCommandBus({ retry: { actionPolicies: { search: 'idempotent' }, baseDelay: 1 } });
    bus.register('search', slow);
    let calls = 0;
    bus.register('save', async () => {
      calls++;
      if (calls === 1) throw new BusError('limited:save', 'busy', { context: { retryIn: 1 } });
      return 'saved';
    });
    for (let i = 0; i < 8; i++) await cancelled(bus, 'search');
    const saved = await bus.dispatch('save', null);
    expect({ ok: saved.ok, calls }).toEqual({ ok: true, calls: 2 });
  });
});
