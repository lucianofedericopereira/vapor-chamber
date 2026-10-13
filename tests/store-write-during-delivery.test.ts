/** A write made while a store's write is delivered is delivered after it, in order, on both runtimes. Rationale at the end. */
import { describe, expect, it } from 'vitest';
import { effect, effectScope, shallowRef } from 'vue';
import { createCommandBus } from '../src/command-bus';
import { createFastLane } from '../src/fast-lane';
import { defineChamberStore as defineVue, fieldRef } from '../src/store';
import { defineChamberStore as defineCore } from '../src/store/core';

type C = { n: number };
const state = (): C => ({ n: 0 });
const reducers = { add: (s: C) => ({ n: s.n + 1 }) };

for (const [runtime, define] of [['vue', defineVue], ['core', defineCore]] as const) {
  describe(`${runtime} store: a write made during a delivery`, () => {
    it('every subscriber sees every write, in write order, and ends on the state', () => {
      const cart = (define as typeof defineCore)('cart', { state, reducers })(createCommandBus());
      const a: number[] = [];
      const b: number[] = [];
      cart.$onField('n', (v) => { a.push(v as number); if (v === 1) cart.add(); });
      cart.$onField('n', (v) => { b.push(v as number); });
      cart.add();
      expect(cart.state.value.n).toBe(2);
      expect(a).toEqual([1, 2]);
      expect(b).toEqual([1, 2]);
      cart.$dispose();
    });

    it('a value written and overwritten within one delivery is skipped; the last one is delivered', () => {
      const cart = (define as typeof defineCore)('cart', { state, reducers })(createCommandBus());
      const b: number[] = [];
      cart.$onField('n', (v) => { if (v === 1) { cart.add(); cart.add(); } });
      cart.$onField('n', (v) => { b.push(v as number); });
      cart.add();
      expect(cart.state.value.n).toBe(3);
      expect(b).toEqual([1, 3]);
      cart.$dispose();
    });

    it('a shared store sends the write made in a subscriber', () => {
      const lane = createFastLane();
      const sent: number[] = [];
      lane.on('cart$state', (m: { ask?: true; state: C }) => { if (!m.ask) sent.push(m.state.n); });
      const cart = (define as typeof defineCore)('cart', { state, reducers, share: lane })(createCommandBus());
      cart.$onField('n', (v) => { if (v === 1) cart.add(); });
      cart.add();
      expect(sent).toEqual([1, 2]);
      cart.$dispose();
    });
  });
}

describe('vue store', () => {
  it('fieldRef shows the write made in a subscriber', () => {
    const cart = defineVue('cart', { state, reducers })(createCommandBus());
    const n = fieldRef(cart, 'n');
    cart.$onField('n', (v) => { if (v === 1) cart.add(); });
    cart.add();
    expect(n.value).toBe(2);
    cart.$dispose();
  });

  it("what a subscriber reads does not become a dependency of the effect that wrote", () => {
    const cart = defineVue('cart', { state, reducers })(createCommandBus());
    const x = shallowRef(0);
    cart.$onField('n', () => { void x.value; });
    let runs = 0;
    const outer = effectScope(true);
    outer.run(() => effect(() => { runs++; if (runs === 1) cart.add(); }));
    const before = runs;
    x.value = 1;
    expect(runs).toBe(before);
    outer.stop();
    cart.$dispose();
  });
});

/*
 * Two bugs, one rule. The Vue store called `fn` inside
 * its watch effect's run, and a running effect does not re-run for a write it
 * causes itself, so a write made in a subscriber was never delivered: every
 * subscriber, `fieldRef` and `share` stayed on the value before it until some
 * later write. The core store delivered such a write INSIDE the running
 * delivery, so a subscriber after the writing one saw the new value and then
 * the old one, and ended on the old one. Now, on both runtimes, a write made
 * during a delivery is delivered after that delivery ends, in write order,
 * and every subscriber ends on the current state; a value written and
 * overwritten within one delivery is skipped, as an effect batch skips it.
 * The rejected shape, a scheduler that calls `fn` after the effect's run,
 * delivered out of order on Vue too and let `fn`'s reads become dependencies
 * of whatever effect made the write: the last test pins that they do not.
 */
