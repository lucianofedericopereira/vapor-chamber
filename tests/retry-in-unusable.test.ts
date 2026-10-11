/**
 * A declared `retryIn` a timer cannot keep (NaN, Infinity, negative) is no
 * declared wait, wherever it came from.
 *
 * 1.30 fixed rateLimit({ max: 0 }) declaring NaN, the one producer the library
 * had; the readers still trusted any number. A plugin or app failure declaring
 * NaN or Infinity made the outbox re-flush with no wait, forever (32 saves in
 * 50 ms), since a timer fires at once on both. The readers - the outbox, the
 * async bus's retry and pollWith - now apply one rule, isDelay (bounds.ts).
 */
import { describe, expect, it } from 'vitest';
import { createAsyncCommandBus } from '../src/command-bus';
import { createOutbox, type OutboxRecord } from '../src/outbox';
import type { AsyncPlugin } from '../src/command-bus';

describe('outbox - a declared wait that is not a usable delay', () => {
  it.each([[Number.POSITIVE_INFINITY], [Number.NaN], [-5]])('retryIn %s does not re-flush in a loop', async (retryIn) => {
    let saves = 0; let stored: OutboxRecord[] = [];
    const storage = { load: async () => stored, save: async (q: OutboxRecord[]) => { saves++; stored = q; }, clear: async () => { stored = []; } };
    let online = false;
    const bus = createAsyncCommandBus({ retry: false });
    bus.register('save', async () => 1);
    const ob = createOutbox({ storage, isOnline: () => online, actions: ['save'] });
    ob.install(bus);
    const busy: AsyncPlugin = (_cmd, _next, fail) => Promise.resolve({ ok: false, value: undefined, error: fail!('limited:action', 'busy', { context: { retryIn } }) } as never);
    bus.use(busy);
    await bus.dispatch('save', { id: 1 });
    online = true;
    await ob.flush();
    const after = saves;
    await new Promise((r) => setTimeout(r, 50));
    ob.dispose();
    expect(saves - after).toBeLessThan(3);
  });
});
