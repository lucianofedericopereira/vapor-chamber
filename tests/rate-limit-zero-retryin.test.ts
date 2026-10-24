/**
 * rateLimit({ max: 0 }) - a refusal with no slot to wait for declares no wait.
 *
 * `max: 0` keeps its meaning (refuse every dispatch, bounds.ts), but the
 * refusal computed `retryIn` from the oldest dispatch in the window, and an
 * empty window has none: `retryIn` was NaN ("Retry in NaNms"). Readers of
 * `context.retryIn` test `typeof === 'number'`, so the outbox read it as a
 * declared wait, kept the record, and slept NaN ms - no wait - before flushing
 * again, forever, re-saving the queue each time. With no slot that frees up,
 * the refusal declares no `retryIn`. Since 1.32 step 4i the outbox holds at the
 * work step, below every plugin, so the refusal never reaches it at all.
 */
import { describe, expect, it } from 'vitest';
import type { BusError } from '../src/command-bus';
import { createAsyncCommandBus } from '../src/command-bus';
import { createOutbox } from '../src/outbox';
import { rateLimit } from '../src/plugins-extra';
import { defineTransport } from '../src/transports';
import { queueStorage } from './outbox-storage';

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

  it('refuses before the outbox holds anything, so nothing can flush in a loop', async () => {
    const storage = queueStorage();
    const ob = createOutbox({ storage, isOnline: () => false, actions: ['save'] });
    const bus = createAsyncCommandBus({ retry: false, transport: defineTransport(async () => ({ ok: true, value: 1, error: undefined })), outbox: ob });
    bus.use(rateLimit({ max: 0, actions: ['save'] }));
    expect((await bus.dispatch('save', { id: 1 })).ok).toBe(false);
    expect([ob.pending.value, storage.saves]).toEqual([0, 0]);
    ob.dispose();
  });
});
