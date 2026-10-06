/** ERROR_CODE_REGISTRY's `retryable` names a transient condition; the bus re-sends only what the call it retries produced (plan 1.27 section 10.12, B15). Rationale at the end. */
import { describe, expect, it } from 'vitest';
import { createAsyncCommandBus, BusError } from '../src/command-bus';
import { rateLimit } from '../src/plugins-extra';
import { isRetryableCode } from '../src/schema';

describe('retryable codes the bus does not re-send', () => {
  it('a register({ throttle }) refusal: retryable, never re-sent', async () => {
    expect(isRetryableCode('core:limited:handler')).toBe(true);
    const bus = createAsyncCommandBus({ retry: { baseDelay: 1, maxAttempts: 3 } });
    let runs = 0;
    bus.register('t', async () => { runs++; }, { throttle: 30 });
    await bus.dispatch('t', 1);
    const r = await bus.dispatch('t', 1);
    expect([r.ok ? 'ok' : (r.error as BusError).code, runs]).toEqual(['core:limited:handler', 1]);
  });

  it("a plugin's refusal: retryable, never re-sent", async () => {
    expect(isRetryableCode('rateLimit:limited:action')).toBe(true);
    const bus = createAsyncCommandBus({ retry: { baseDelay: 1, maxAttempts: 3, maxDelay: 2000 } });
    let runs = 0;
    bus.register('api', async () => { runs++; });
    bus.use(rateLimit({ max: 1, window: 40 }));
    await bus.dispatch('api', 1);
    const r = await bus.dispatch('api', 1);
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
 */
