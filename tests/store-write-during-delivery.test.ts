/**
 * A write made by a store subscriber while a field write is being delivered, on the Vue and core runtimes.
 * Why: a write made in a subscriber must be delivered after the current delivery, in write order, or subscribers, fieldRef and share would stay on a stale value.
 * Shows: every subscriber sees every write in order and ends on the state; a value overwritten within one delivery is skipped; a shared store sends it; fieldRef shows it; a subscriber's reads do not become dependencies of the writing effect.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { effect, effectScope, shallowRef } from 'vue';
import { createCommandBus } from '../src/command-bus';
import { defineChamberStore as defineVue, fieldRef } from '../src/store';
import { defineChamberStore as defineCore } from '../src/store/core';
import { shareTabs } from '../src/store-share';
import { listen, quiet } from './tabs-quiet';

type C = { n: number };
const state = (): C => ({ n: 0 });
const reducers = { add: (s: C) => ({ n: s.n + 1 }) };

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

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

    it('a shared store sends the write made in a subscriber', async () => {
      vi.stubGlobal('window', {}); // shareTabs opens only where there is a page
      const name = `delivery-${define === defineCore ? 'core' : 'vue'}`;
      const wire = listen(name);
      const peer = (define as typeof defineCore)('cart', { state, reducers, share: shareTabs(name) })(createCommandBus());
      const cart = (define as typeof defineCore)('cart', { state, reducers, share: shareTabs(name) })(createCommandBus());
      await quiet(wire.heard);
      cart.$onField('n', (v) => { if (v === 1) cart.add(); });
      cart.add();
      await quiet(wire.heard);
      expect(peer.state.value.n).toBe(2);
      cart.$dispose();
      peer.$dispose();
      wire.close();
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
