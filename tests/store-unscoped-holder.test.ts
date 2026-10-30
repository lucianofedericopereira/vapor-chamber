/**
 * Store disposal is refcounted, and a holder outside any scope owns $dispose().
 * Why: a module-level store would be disposed by the first component that joins and leaves, so its actions would fail and its state reset.
 * Shows: a scoped holder leaving keeps an unscoped store alive; the unscoped owner can dispose it; scoped holders alone dispose it when the last leaves.
 * See: docs/store.md
 */
import { expect } from 'vitest';
import { effectScope } from 'vue';
import { defineChamberStore } from '../src/store';
import { it } from '../src/vitest';

const useCart = defineChamberStore('cart', {
  state: () => ({ n: 0 }),
  reducers: { add: (s: { n: number }) => ({ n: s.n + 1 }) },
});

it('a scoped holder leaving does not dispose a store held outside any scope', ({ bus }) => {
  const moduleStore = useCart(bus);
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
