/** createReaction: maxHops counts across every reaction on a bus, so an indirect cycle stops (plan 1.27 section 10.1). Rationale at the end. */
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
    await tick(100);
    const settled = runs;
    await tick(100);
    expect([settled, runs]).toEqual([16, 16]);
    vi.restoreAllMocks();
  });
});

/*
 * `maxHops` "Catches INDIRECT cycles (A->B, B->A), which no install-time check
 * can see". Each reaction kept its own hop map, so reaction B->A never found
 * the id reaction A->B recorded, every hop read 1, and a two-reaction cycle
 * ran to the dispatch depth bound (16) instead of maxHops (audit B3, probe
 * p-reaction). Now every reaction installed on a bus shares one hop map (a
 * WeakMap keyed by the bus, read at install). Its cap and eviction are
 * unchanged.
 *
 * D12: the docs said an async self loop is unbounded. A reaction re-dispatches
 * synchronously from its listener, and the async fan-out runs at the
 * dispatch's depth, so MAX_DISPATCH_DEPTH stops it at 16 on both buses (probe
 * p-loop-hook). Only a listener that re-dispatches after an await escapes the
 * depth bound (p-loop-ctl); maxHops does not see that either. Log s35.171.
 */
