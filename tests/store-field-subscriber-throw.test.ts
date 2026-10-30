/**
 * A `$onField` subscriber that throws is logged; the write and the other subscribers go on.
 * Why: a throwing subscriber would fail a dispatch whose write already happened, so history would not record it, a persist would not save it, and later subscribers would miss it.
 * Shows: on both runtimes the dispatch is ok, the state is written, history records the command, later subscribers run, and the throw is logged once with the error as its own argument; the async bus behaves the same.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAsyncCommandBus, createCommandBus, type CommandResult } from '../src/command-bus';
import { defineChamberStore as defineVue } from '../src/store';
import { defineChamberStore as defineCore } from '../src/store/core';
import { history } from '../src/plugins-core';

type Cart = { items: number[]; n: number };
const state = (): Cart => ({ items: [], n: 0 });
const reducers = { add: (s: Cart, id: number) => ({ items: [...s.items, id], n: s.n + 1 }) };

afterEach(() => { vi.restoreAllMocks(); });

for (const [runtime, define] of [['vue', defineVue], ['core', defineCore]] as const) {
  describe(`${runtime} store: a field subscriber that throws`, () => {
    it('the dispatch is ok, the state is written, history records it, later subscribers run', () => {
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
      const bus = createCommandBus();
      const h = history({ bus });
      const cart = (define as typeof defineCore)('cart', { state, reducers })(bus);
      const boom = new Error('subscriber');
      const later: string[] = [];
      cart.$onField('items', () => { throw boom; });
      cart.$onField('items', () => { later.push('items'); });
      cart.$onField('n', (v) => { later.push(`n=${v as number}`); });

      const r = cart.add(1) as CommandResult;

      expect(r.ok).toBe(true);
      expect(cart.state.value).toEqual({ items: [1], n: 1 });
      expect(later).toEqual(['items', 'n=1']);
      expect(h.getState().past.map((c) => c.action)).toEqual(['cartAdd']);
      expect(logged).toHaveBeenCalledTimes(1);
      expect(logged).toHaveBeenCalledWith(expect.stringMatching(/^\[vapor-chamber\] \[ FAIL \] store:failed:subscriber: Store "cart": the \$onField subscriber for "items" threw/), boom);
      cart.$dispose();
    });

    it('on the async bus too', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const bus = createAsyncCommandBus({ retry: false });
      const cart = (define as typeof defineCore)('cart', { state, reducers })(bus);
      let later = 0;
      cart.$onField('n', () => { throw new Error('subscriber'); });
      cart.$onField('n', () => { later++; });

      const r = await cart.add(1);

      expect(r.ok).toBe(true);
      expect(cart.state.value.n).toBe(1);
      expect(later).toBe(1);
      cart.$dispose();
    });
  });
}
