/** A cancel whose reason is the caller's own Error is read as a cancel (audit D4). Rationale at the end. */
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

/*
 * An abort with the caller's own Error comes back as that Error (abortedResult,
 * docs/performance.md), so its name is the app's, not `AbortError`. Every
 * reader that told a cancel by name took it for a failure: failureCondition
 * answered `failed`, the async retry loop counted it uncertain and spent a
 * token on each one (eight cancels left a real 503 un-retried), and
 * circuitBreaker counted it (tests/circuit-breaker-cancel.test.ts).
 *
 * The rule is the platform's: a failure is the caller's cancel when it IS the
 * signal's reason. `throwIfAborted()` and Fetch reject with `signal.reason`
 * itself. Identity, not "the signal is aborted": a real failure that lands
 * after an abort is not the reason, and it still counts (the control in the
 * breaker file). One reader, `_isCancel` in src/failure.ts, used at each site.
 */
