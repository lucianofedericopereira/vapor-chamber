/**
 * A store created outside any scope is not disposed by scoped holders.
 *
 * docs/store.md: "the last holder out disposes, not the first one in", and a
 * caller outside a scope "owns $dispose()". The code counted scoped holders
 * only, so a module-level store (the cookbook panel's db/store.js holds its
 * rows store this way) was disposed by the first component that joined and
 * left: its actions answered ok: false, and the next useStore built a fresh
 * store with its state reset. Measured on 1.24. The tests covered two scoped
 * holders, never an unscoped owner plus a scoped one.
 * docs/plan-failures-and-contract.md, 2.1.
 */
import { expect } from 'vitest';
import { effectScope } from 'vue';
import { defineChamberStore } from '../src/store';
import { it } from '../src/vitest';

const useCart = defineChamberStore('cart', {
  state: () => ({ n: 0 }),
  actions: { add: (s: { n: number }) => ({ n: s.n + 1 }) },
});

it('a scoped holder leaving does not dispose a store held outside any scope', ({ bus }) => {
  const moduleStore = useCart(bus); // e.g. a store.js imported at app start
  moduleStore.add();

  const page = effectScope();
  const joined = page.run(() => useCart(bus));
  expect(joined).toBe(moduleStore);
  page.stop(); // the page unmounts

  expect(moduleStore.add()).toSucceedWith({ n: 2 });
  expect(useCart(bus)).toBe(moduleStore);
});

it('the unscoped owner can still dispose it', ({ bus }) => {
  const store = useCart(bus);
  store.$dispose();
  expect(store.add()).toFailWith('core:missing:handler');
  expect(useCart(bus)).not.toBe(store);
});

it('scoped holders alone still dispose it when the last one leaves', ({ bus }) => {
  const a = effectScope();
  const b = effectScope();
  const first = a.run(() => useCart(bus))!;
  b.run(() => useCart(bus));
  a.stop();
  expect(first.add()).toSucceedWith({ n: 1 }); // b still holds it
  b.stop();
  expect(first.add()).toFailWith('core:missing:handler'); // last holder out
});
