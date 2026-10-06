/** A store's map of reducers is `reducers` (log s35.147); no other name is read (log s35.156). */
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

/*
 * `actions` is an ActionScope everywhere else in the library (log s35.146):
 * a set of action names. A store's option was a map of functions
 * `(state, target, payload) => nextState`, and its own type was documented
 * "A reducer". Same word, different thing: renamed `reducers`, the word Redux
 * Toolkit's createSlice uses for the same map, whose keys generate the
 * actions as ours do (`add` on store `cart` dispatches `cartAdd`). The rename
 * is clean: no alias, no fallback, no warning; every caller in the repo moved
 * with it (log s35.156).
 */
