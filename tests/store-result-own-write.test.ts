/**
 * An action's dispatch result when a store subscriber writes during that action's delivery, on the Vue and core runtimes.
 * Why: a caller reading an action's result must get the state that action wrote, or it takes a later write for its own.
 * Shows: the outer result holds the outer write and the nested result the nested one, while the state holds the last, for a plain store, a store with undo, and $reset.
 * See: tests/store-write-during-delivery.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { createCommandBus } from '../src/command-bus';
import { defineChamberStore as defineVue } from '../src/store';
import { defineChamberStore as defineCore } from '../src/store/core';

type C = { n: number };
const state = (): C => ({ n: 0 });
const reducers = { add: (s: C) => ({ n: s.n + 1 }) };

for (const [runtime, define] of [['vue', defineVue], ['core', defineCore]] as const) {
  describe(`${runtime} store: the result of an action whose delivery writes`, () => {
    for (const [mode, undo] of [['plain', false], ['undo', true]] as const) {
      it(`${mode}: each result holds its own write, the state the last`, () => {
        const cart = (define as typeof defineCore)('cart', { state, reducers, undo })(createCommandBus());
        let nested: unknown;
        cart.$onField('n', (v) => { if (v === 1) nested = cart.add().value; });
        const outer = cart.add();
        expect(outer.value).toEqual({ n: 1 });
        expect(nested).toEqual({ n: 2 });
        expect(cart.state.value).toEqual({ n: 2 });
        cart.$dispose();
      });
    }

    it('$reset: the result holds the reset, the state the write made during it', () => {
      const cart = (define as typeof defineCore)('cart', { state, reducers })(createCommandBus());
      cart.add();
      cart.$onField('n', (v) => { if (v === 0) cart.add(); });
      const result = cart.$reset();
      expect(result.value).toEqual({ n: 0 });
      expect(cart.state.value).toEqual({ n: 1 });
      cart.$dispose();
    });

    it('with no nested write the result is the state itself', () => {
      const cart = (define as typeof defineCore)('cart', { state, reducers })(createCommandBus());
      expect(cart.add().value).toBe(cart.state.value);
      cart.$dispose();
    });
  });
}
