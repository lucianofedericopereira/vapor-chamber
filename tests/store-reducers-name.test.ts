/**
 * A store's map of reducers is the `reducers` option; each key becomes a method and an action named store plus key.
 * Why: `actions` means an action scope everywhere else in the library, so a store whose reducer map is not `reducers` would not generate its methods and handlers; defining a store must also stay silent.
 * Shows: `add` on store `cart` returns an ok result, updates state and registers the `cartAdd` handler; defining a store does not call console.warn.
 * See: log s35.146, log s35.147, log s35.156.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCommandBus, type CommandResult } from '../src/command-bus';
import { defineChamberStore } from '../src/store';

afterEach(() => vi.restoreAllMocks());

describe('reducers', () => {
  it('reducers: each key becomes the method and the action', () => {
    const bus = createCommandBus();
    const cart = defineChamberStore('cart', { state: () => ({ items: [] as number[] }), reducers: { add: (s, id: number) => ({ items: [...s.items, id] }) } })(bus);
    expect((cart.add(4) as CommandResult).ok).toBe(true);
    expect(cart.state.value.items).toEqual([4]);
    expect(bus.hasHandler('cartAdd')).toBe(true);
  });

  it('a store prints nothing when it is defined', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    defineChamberStore('quiet', { state: () => ({ n: 0 }), reducers: { inc: (s) => ({ n: s.n + 1 }) } });
    expect(warn).not.toHaveBeenCalled();
  });
});
