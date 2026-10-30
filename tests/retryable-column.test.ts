/**
 * ERROR_CODE_REGISTRY's `retryable` names a transient condition; the bus re-sends only what the call it retries produced.
 * Why: the retry sits at the call that produced the outcome (a handler, a transport), inside the plugins. A retryable code raised outside it, such as a throttled second dispatch or a rateLimit refusal, would be re-sent if the column meant "the bus re-sends it for any action", and the handler would run again.
 * Shows: pace:limited:dispatch and rateLimit:limited:action are retryable codes yet leave the handler run once; a transient handler failure is re-sent.
 * See: log s35.177
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAsyncCommandBus, BusError } from '../src/command-bus';
import { rateLimit } from '../src/plugins-extra';
import { isRetryableCode } from '../src/error-registry';
import { pace } from '../src/pace';

describe('retryable codes the bus does not re-send', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a throttled call at the sender: retryable, never reaches the bus', async () => {
    expect(isRetryableCode('pace:limited:dispatch')).toBe(true);
    vi.useFakeTimers();
    const bus = createAsyncCommandBus({ retry: { baseDelay: 1, maxAttempts: 3 } });
    let runs = 0;
    bus.register('t', async () => { runs++; });
    const send = pace(bus.dispatch, { throttle: 30 });
    // Fake timers: the throttle gate reads Date.now(), so a real stall between the two dispatches would let the second run.
    await send('t', 1);
    const second = send('t', 1);
    await vi.runAllTimersAsync(); // a re-send would wait out the window here
    const r = await second;
    expect([r.ok ? 'ok' : (r.error as BusError).code, runs]).toEqual(['pace:limited:dispatch', 1]);
  });

  it("a plugin's refusal: retryable, never re-sent", async () => {
    expect(isRetryableCode('rateLimit:limited:action')).toBe(true);
    vi.useFakeTimers();
    const bus = createAsyncCommandBus({ retry: { baseDelay: 1, maxAttempts: 3, maxDelay: 2000 } });
    let runs = 0;
    bus.register('api', async () => { runs++; });
    // Fake timers: rateLimit reads Date.now(), so a real stall between the two dispatches would let the second run.
    bus.use(rateLimit({ max: 1, window: 40 }));
    await bus.dispatch('api', 1);
    const second = bus.dispatch('api', 1);
    await vi.runAllTimersAsync();
    const r = await second;
    expect([r.ok ? 'ok' : (r.error as BusError).code, runs]).toEqual(['rateLimit:limited:action', 1]);
  });

  it('control: a transient failure from the handler is re-sent', async () => {
    const bus = createAsyncCommandBus({ retry: { baseDelay: 1, maxAttempts: 3 } });
    let runs = 0;
    bus.register('x', async () => { runs++; if (runs < 3) throw new BusError('limited:upstream', 'busy'); return 'ok'; });
    const r = await bus.dispatch('x', 1);
    expect([r.ok, runs]).toEqual([true, 3]);
  });
});
