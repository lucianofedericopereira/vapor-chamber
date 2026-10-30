/**
 * rateLimit({ max: 0 }) refuses every dispatch and declares no wait.
 * Why: with no slot that ever frees up there is nothing to wait for, so a `retryIn` (or a NaN message) would be read by `typeof === 'number'` callers as a real wait and loop.
 * Shows: the refusal has no `context.retryIn` and no NaN in its message; with an outbox the refusal comes before it holds anything, so nothing is pending or saved.
 * See: src/bounds.ts
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
