/** `<id>$reset` keeps its ownership on a takeover, stays per bus, and answers a dispatch by name. Rationale at the end. */
import { describe, expect, it, vi } from 'vitest';
import { createCommandBus, inspectBus, type CommandResult } from '../src/command-bus';
import { defineChamberStore } from '../src/store/core';

type C = { n: number };
const define = (step: number) => defineChamberStore('cart', { state: (): C => ({ n: 0 }), reducers: { add: (s: C) => ({ n: s.n + step }) } });

describe('$reset', () => {
  it("a store taken over and then disposed leaves the newer store's $reset registered", () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bus = createCommandBus();
    const old = define(1)(bus);
    const next = define(10)(bus);
    next.add();
    old.$dispose();
    expect(inspectBus(bus).actions).toContain('cart$reset');
    expect((next.$reset() as CommandResult).ok).toBe(true);
    expect(next.state.value).toEqual({ n: 0 });
    next.$dispose();
    expect(inspectBus(bus).actions).not.toContain('cart$reset');
    vi.restoreAllMocks();
  });

  it('two buses with a store of one id reset only their own', () => {
    const a = createCommandBus();
    const b = createCommandBus();
    const onA = define(1)(a);
    const onB = define(1)(b);
    onA.add();
    onB.add();
    onA.$reset();
    expect([onA.state.value.n, onB.state.value.n]).toEqual([0, 1]);
    onA.$dispose();
    onB.$dispose();
  });

  it('a reset dispatched by name before any $reset() call resets', () => {
    const bus = createCommandBus();
    const cart = define(1)(bus);
    cart.add();
    expect((bus.dispatch('cart$reset', null) as CommandResult).ok).toBe(true);
    expect(cart.state.value).toEqual({ n: 0 });
    cart.$dispose();
  });
});

/*
 * Pinned while the store's creation cost was recovered (plan 1.32 4e, log
 * 36.62). One candidate registered `<id>$reset` as one handler per bus that
 * found its store by id; every store of a bus then registered the same
 * function, and register()'s cleanup removes by identity, so a store taken
 * over and disposed later removed the newer store's `$reset` (the first case,
 * red when the ownership guard was left out). The candidate read slower on
 * the reset path (+25 ns) and was dropped; the three behaviours hold for any
 * shape: a takeover keeps the newer `$reset`, a bus resets only its own store
 * of an id, and `cart$reset` dispatched by name resets before any `$reset()`.
 */
