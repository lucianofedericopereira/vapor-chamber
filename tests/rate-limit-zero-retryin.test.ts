/**
 * rateLimit({ max: 0 }) - a refusal with no slot to wait for declares no wait.
 *
 * `max: 0` keeps its meaning (refuse every dispatch, bounds.ts), but the
 * refusal computed `retryIn` from the oldest dispatch in the window, and an
 * empty window has none: `retryIn` was NaN ("Retry in NaNms"). Readers of
 * `context.retryIn` test `typeof === 'number'`, so the outbox read it as a
 * declared wait, kept the record, and slept NaN ms - no wait - before flushing
 * again, forever, re-saving the queue each time. With no slot that frees up,
 * the refusal declares no `retryIn`.
 */
import { describe, expect, it } from 'vitest';
import type { BusError } from '../src/command-bus';
import { createAsyncCommandBus } from '../src/command-bus';
import { createOutbox, type OutboxRecord } from '../src/outbox';
import { rateLimit } from '../src/plugins-extra';

describe('rateLimit({ max: 0 })', () => {
  it('refuses with no retryIn', async () => {
    const bus = createAsyncCommandBus({ retry: false });
    bus.register('save', async () => 1);
    bus.use(rateLimit({ max: 0, actions: ['save'] }));
    const r = await bus.dispatch('save', {});
    expect(r.ok).toBe(false);
    expect((r.error as BusError).context).not.toHaveProperty('retryIn');
    expect((r.error as BusError).message).not.toContain('NaN');
  });

  it('does not make the outbox flush in a loop', async () => {
    let saves = 0;
    let stored: OutboxRecord[] = [];
    const storage = { load: async () => stored, save: async (q: OutboxRecord[]) => { saves++; stored = q; }, clear: async () => { stored = []; } };
    let online = false;
    const bus = createAsyncCommandBus({ retry: false });
    bus.register('save', async () => 1);
    const ob = createOutbox({ storage, isOnline: () => online, actions: ['save'] });
    ob.install(bus);
    bus.use(rateLimit({ max: 0, actions: ['save'] }));
    await bus.dispatch('save', { id: 1 });
    online = true;
    await ob.flush();
    const after = saves;
    await new Promise((r) => setTimeout(r, 50));
    expect(saves - after).toBe(0);
    ob.dispose();
  });
});
