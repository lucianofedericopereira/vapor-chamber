/**
 * createReaction: maxHops counts across every reaction on a bus, so an indirect cycle (A->B, B->A) stops.
 * Why: no install-time check sees an indirect cycle, so with per-reaction counts it would run to the dispatch depth bound (16) instead of maxHops.
 * Shows: a two-reaction cycle runs maxHops + 1 times on a sync and an async bus; a self loop, unrelated chains and separate buses keep their own counts; a self loop with a huge maxHops stops at depth 16 on both buses.
 * See: log s35.171
 */
import { describe, expect, it, vi } from 'vitest';
import { createAsyncCommandBus, createCommandBus } from '../src/command-bus';
import { createReaction } from '../src/utilities';

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A bus with handlers `a` and `b` counting runs. */
function counted(make: typeof createCommandBus | typeof createAsyncCommandBus) {
  const bus = (make as typeof createCommandBus)({} as never);
  let runs = 0;
  bus.register('a', () => { runs++; });
  bus.register('b', () => { runs++; });
  return { bus, runs: () => runs };
}

describe('an indirect cycle', () => {
  it('sync: a -> b plus b -> a stops at maxHops', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { bus, runs } = counted(createCommandBus);
    createReaction('a', 'b', { maxHops: 3 }).install(bus);
    createReaction('b', 'a', { maxHops: 3 }).install(bus);
    bus.dispatch('a', {});
    expect(runs()).toBe(4);
    vi.restoreAllMocks();
  });

  it('async: a -> b plus b -> a stops at maxHops', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const bus = createAsyncCommandBus({ retry: false });
    let runs = 0;
    bus.register('a', async () => { runs++; });
    bus.register('b', async () => { runs++; });
    createReaction('a', 'b', { maxHops: 3 }).install(bus);
    createReaction('b', 'a', { maxHops: 3 }).install(bus);
    await bus.dispatch('a', {});
    await tick(30);
    expect(runs).toBe(4);
    vi.restoreAllMocks();
  });
});

describe('controls', () => {
  it('a self loop stops at maxHops, as released', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const bus = createCommandBus();
    let runs = 0;
    bus.register('cartRecalculate', () => { runs++; });
    createReaction('cart*', 'cartRecalculate', { allowSelfMatch: true, maxHops: 3 }).install(bus);
    bus.dispatch('cartRecalculate', {});
    expect(runs).toBe(4);
    vi.restoreAllMocks();
  });

  it('two unrelated chains on one bus each get their own count', () => {
    const { bus, runs } = counted(createCommandBus);
    createReaction('a', 'b', { maxHops: 1 }).install(bus);
    bus.dispatch('a', {});
    bus.dispatch('a', {});
    expect(runs()).toBe(4);
  });

  it('two buses keep separate counts', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const r1 = counted(createCommandBus);
    const r2 = counted(createCommandBus);
    const ab = createReaction('a', 'b', { maxHops: 3 });
    const ba = createReaction('b', 'a', { maxHops: 3 });
    for (const { bus } of [r1, r2]) { ab.install(bus); ba.install(bus); }
    r1.bus.dispatch('a', {});
    r2.bus.dispatch('a', {});
    expect([r1.runs(), r2.runs()]).toEqual([4, 4]);
    vi.restoreAllMocks();
  });

  it('D12: an async self loop whose listener re-dispatches synchronously stops at depth 16', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bus = createAsyncCommandBus({ retry: false });
    let runs = 0;
    bus.register('cartRecalculate', async () => { runs++; });
    createReaction('cart*', 'cartRecalculate', { allowSelfMatch: true, maxHops: 100_000 }).install(bus);
    await bus.dispatch('cartRecalculate', {});
    // The listener re-dispatches synchronously, so MAX_DISPATCH_DEPTH bounds it; one that re-dispatches after an await would escape.
    await tick(100);
    const settled = runs;
    await tick(100);
    expect([settled, runs]).toEqual([16, 16]);
    vi.restoreAllMocks();
  });

  it('D12: a sync self loop stops at depth 16 too', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bus = createCommandBus();
    let runs = 0;
    bus.register('cartRecalculate', () => { runs++; });
    createReaction('cart*', 'cartRecalculate', { allowSelfMatch: true, maxHops: 100_000 }).install(bus);
    bus.dispatch('cartRecalculate', {});
    expect(runs).toBe(16);
    vi.restoreAllMocks();
  });
});
