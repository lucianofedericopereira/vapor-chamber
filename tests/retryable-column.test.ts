/** ERROR_CODE_REGISTRY's `retryable` names a transient condition; the bus re-sends only what the call it retries produced (log s35.177). Rationale at the end. */
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

/*
 * ErrorCodeEntry.retryable read "Whether the async bus re-sends it for any
 * action", but the retry sits at the call that produced the outcome (a
 * handler, a transport), inside the plugins: a throttled second dispatch and
 * a rateLimit refusal both ran the handler once (audit B15, N4, D11, probe
 * P10). The column names a transient condition; the doc now says where the
 * bus re-sends it. Log s35.177.
 *
 * The two window tests run on fake timers. The throttle gate and rateLimit
 * read Date.now(), so on real timers a stall of 40 ms between the two
 * dispatches (a loaded machine) let the second one run: `['ok', 2]`. A
 * re-send still shows: it waits out the window inside runAllTimersAsync, and
 * the handler runs twice.
 */
