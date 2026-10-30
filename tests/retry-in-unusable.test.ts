/**
 * A declared `retryIn` a timer cannot keep (NaN, Infinity, negative) is no declared wait, wherever it came from.
 * Why: a failure declaring NaN or Infinity would make the outbox re-flush with no wait, forever, since a timer fires at once on both. The readers (the outbox, the async bus's retry, pollWith) apply one rule, isDelay.
 * Shows: for retryIn Infinity, NaN and -5 from a transport, the outbox sends fewer than 3 more times in 50 ms after a flush. Only the outbox reader is exercised here.
 * See: src/bounds.ts
 */
import { describe, expect, it } from 'vitest';
import { _failures, createAsyncCommandBus } from '../src/command-bus';
import { createOutbox } from '../src/outbox';
import { defineTransport } from '../src/transports';

describe('outbox - a declared wait that is not a usable delay', () => {
  it.each([[Number.POSITIVE_INFINITY], [Number.NaN], [-5]])('retryIn %s does not re-flush in a loop', async (retryIn) => {
    let sends = 0;
    let online = false;
    const ob = createOutbox({ storage: null, isOnline: () => online, actions: ['save'] });
    // The transport answers busy with a wait no timer can keep.
    const busy = defineTransport(async () => {
      sends++;
      return { ok: false, value: undefined, error: _failures('transport')('limited:action', 'busy', { context: { retryIn } }) };
    });
    const bus = createAsyncCommandBus({ retry: false, transport: busy, outbox: ob });
    await bus.dispatch('save', { id: 1 });
    online = true;
    await ob.flush();
    const after = sends;
    await new Promise((r) => setTimeout(r, 50));
    ob.dispose();
    expect(sends - after).toBeLessThan(3);
  });
});
