/**
 * A declared `retryIn` a timer cannot keep (NaN, Infinity, negative) is no
 * declared wait, wherever it came from.
 *
 * 1.30 fixed rateLimit({ max: 0 }) declaring NaN, the one producer the library
 * had; the readers still trusted any number. A plugin or app failure declaring
 * NaN or Infinity made the outbox re-flush with no wait, forever (32 saves in
 * 50 ms), since a timer fires at once on both. The readers - the outbox, the
 * async bus's retry and pollWith (now a 202's poll, src/transports.ts) - apply
 * one rule, isDelay (bounds.ts).
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
