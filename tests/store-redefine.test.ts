/** A store id defined again takes over, as register() does for a handler (log s35.101). Rationale at the end. */
import { describe, expect, vi } from 'vitest';
import { effectScope } from 'vue';
import { createCommandBus, inspectBus } from '../src/command-bus';
import { defineChamberStore } from '../src/store';
import { it } from '../src/vitest';

const v1 = () =>
  defineChamberStore('cart', {
    state: () => ({ items: [] as number[] }),
    actions: { add: (s, n: number) => ({ items: [...s.items, n] }), clear: () => ({ items: [] }) },
  });
const v2 = () =>
  defineChamberStore('cart', {
    state: () => ({ items: [] as number[] }),
    actions: { add: (s, n: number) => ({ items: [...s.items, n * 10] }), bump: (s) => s },
  });

describe('one definition', () => {
  it('control: called again, it joins the one store', ({ bus }) => {
    const useCart = v1();
    expect(useCart(bus)).toBe(useCart(bus));
    useCart(bus).$dispose();
  });
});

describe('another definition of a held id', () => {
  it('takes over: its actions and reducers apply, from its own state()', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bus = createCommandBus();
    const old = v1()(bus); // outside any scope: pinned, as a module-level store is
    old.add(1);
    const next = v2()(bus);

    expect(next).not.toBe(old);
    expect(typeof next.bump).toBe('function');
    next.add(3);
    expect(next.state.value.items).toEqual([30]);
    // register()'s own DEV warning, one per action the new definition takes over.
    expect(warn.mock.calls.map((c) => String(c[0]))).toEqual([
      expect.stringContaining('Handler for "cartAdd" already exists'),
      expect.stringContaining('Handler for "cart$reset" already exists'),
    ]);
    next.$dispose();
    old.$dispose();
    bus.dispose();
  });

  it("the old store's $dispose removes only what it still owns", () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bus = createCommandBus();
    const useNext = v2();
    const old = v1()(bus);
    const next = useNext(bus);
    // `cartClear` is the old definition's alone, so it stays until its owner leaves.
    expect(inspectBus(bus).actions.sort()).toEqual(['cart$reset', 'cartAdd', 'cartBump', 'cartClear']);

    old.$dispose();
    expect(inspectBus(bus).actions.sort()).toEqual(['cart$reset', 'cartAdd', 'cartBump']);
    expect(useNext(bus)).toBe(next);
    next.add(2);
    expect(next.state.value.items).toEqual([20]);
    next.$dispose();
    bus.dispose();
  });

  it('a scope that held the old store, ending after the takeover, leaves the new one', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bus = createCommandBus();
    const page = effectScope();
    page.run(() => v1()(bus));
    const useNext = v2();
    const next = useNext(bus);
    page.stop(); // the old store's last holder leaves: it disposes the OLD store

    expect(useNext(bus)).toBe(next);
    next.add(1);
    expect(next.state.value.items).toEqual([10]);
    next.$dispose();
    bus.dispose();
  });
});

/*
 * Log s35.101. Before, `useStore` returned whatever the registry held for the
 * id, so a second DEFINITION of an id that was still held got the first
 * store: without its own actions, running the old reducers, with no word.
 * Measured on a real hot update (tests/vapor/store-hmr.test.ts): a component
 * that holds a store is unmounted before its reloaded setup runs, so it was
 * already fine; a store created at module load (pinned) kept the first
 * definition through every edit.
 *
 * The rule is the core's for `register()` (plan settled item 8): last wins,
 * with ownership. The new definition builds its own store and registers its
 * actions over the old ones - `register()` warns per action in DEV, the
 * signal that two definitions claim one id - and the old store's `$dispose`
 * removes only what it still owns: the handlers no newer one replaced, and
 * the registry entry only while it is still its own (log s35.88).
 */
