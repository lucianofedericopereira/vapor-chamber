/** retry.actionPolicies: the most specific match wins, whatever the written order (plan 1.27 item 9, B4). Rationale at the end. */
import { describe, expect, it, vi } from 'vitest';
import { BusError, createAsyncCommandBus, type RetryPolicy } from '../src/command-bus';
import { createAsyncSchemaCommandBus } from '../src/schema';

/** How many times `action`, which loses its reply, runs under these policies. */
async function runs(actionPolicies: Record<string, RetryPolicy>, action = 'cartAdd') {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const bus = createAsyncCommandBus({ retry: { baseDelay: 1, actionPolicies } });
  let n = 0;
  bus.register(action, async () => { n++; throw new BusError('lost:reply', 'no reply'); });
  await bus.dispatch(action, 1);
  vi.restoreAllMocks();
  return n;
}

describe('the most specific match wins', () => {
  it('an exact name beats a pattern written before it', async () => {
    expect(await runs({ 'cart*': 'idempotent', cartAdd: false })).toBe(1);
    expect(await runs({ cartAdd: false, 'cart*': 'idempotent' })).toBe(1);
  });

  it('the longer prefix beats the shorter, and any prefix beats *', async () => {
    expect(await runs({ 'c*': false, 'cart*': 'idempotent' })).toBe(3);
    expect(await runs({ '*': 'idempotent', 'cart*': false })).toBe(1);
  });

  it('integer-like names do not reorder the choice', async () => {
    expect(await runs({ '1*': 'idempotent', 12: false }, '12')).toBe(1);
  });
});

describe('controls', () => {
  it('one policy alone, as released', async () => {
    expect(await runs({ cartAdd: false })).toBe(1);
    expect(await runs({ 'cart*': 'idempotent' })).toBe(3);
    expect(await runs({ '*': 'idempotent' })).toBe(3);
  });

  it('resolved once per action: a second dispatch reads the same policy, and past 512 actions the cache starts over', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bus = createAsyncCommandBus({ retry: { baseDelay: 1, actionPolicies: { 'job*': false, cartAdd: 'idempotent' } } });
    // Fails once, then answers: an idempotent policy re-sends it once.
    let n = 0;
    bus.register('cartAdd', async () => { n++; if (n % 2) throw new BusError('lost:reply', 'no reply'); });
    await bus.dispatch('cartAdd', 1);
    await bus.dispatch('cartAdd', 1);
    expect(n).toBe(4);
    for (let i = 0; i < 513; i++) bus.register(`job${i}`, async () => 1);
    for (let i = 0; i < 513; i++) await bus.dispatch(`job${i}`, 1);
    await bus.dispatch('cartAdd', 1);
    expect(n).toBe(6);
    vi.restoreAllMocks();
  });

  it('an action no policy names gets the default', async () => {
    expect(await runs({ 'order*': 'idempotent' })).toBe(1);
  });

  it("the schema's exact name beats the bus's pattern; the bus's exact name wins over the schema's", async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const [busPolicies, expected] of [[{ 'cart*': false }, 3], [{ cartAdd: false }, 1]] as const) {
      const bus = createAsyncSchemaCommandBus({ cartAdd: { retry: 'idempotent' } }, { retry: { baseDelay: 1, actionPolicies: busPolicies } });
      let n = 0;
      bus.register('cartAdd', async () => { n++; throw new BusError('lost:reply', 'no reply'); });
      await bus.dispatch('cartAdd', {} as never);
      expect(n).toBe(expected);
    }
    vi.restoreAllMocks();
  });
});

/*
 * gRPC service_config.proto: "When determining which MethodConfig to use
 * for a given RPC, the most specific match wins", and each name is unique.
 * The map read its keys in object order, the first match winning, so `{
 * 'cart*': 'idempotent', cartAdd: false }` re-sent `cartAdd` after a lost
 * reply: a declared `false` re-sent is a double apply (audit B16). Object
 * order also puts integer-like keys first. The keys are now ranked once at
 * creation (an exact name, then the longest prefix, then `*`) and each
 * action's policy is resolved once and cached, which also removes the
 * per-dispatch scan (measured M1, decl50 0.48x). The map is named by
 * Apollo's key-kind and value-kind rule (`typePolicies`) and gRPC's
 * `retryPolicy`: `actionPolicies`, values `RetryPolicy`. Log s35.179.
 */
