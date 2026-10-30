/**
 * `<id>$reset` keeps its ownership on a takeover, stays per bus, and answers a dispatch by name.
 * Why: register()'s cleanup removes by identity, so if stores of one bus shared one `$reset` handler, a store taken over and disposed later would remove the newer store's `$reset`; a bus must reset only its own store of an id.
 * Shows: after a takeover and the old store's dispose, `cart$reset` stays registered, resets the newer store and is removed with it; two buses reset only their own store; `cart$reset` dispatched by name resets before any `$reset()` call.
 * See: log s36.62.
 */
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
