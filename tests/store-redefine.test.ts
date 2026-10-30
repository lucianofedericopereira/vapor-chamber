/**
 * A store id defined again takes over, as register() does for a handler.
 * Why: a second definition of a held id would otherwise get the first store, without its own actions and running the old reducers with no warning, so a module-level store would keep its first definition through every edit.
 * Shows: the same definition called again joins its store; a new definition builds its own store with its own actions and reducers and starts from its own state(), with register()'s warning per taken-over action; the old store's $dispose removes only the handlers it still owns; the old store's last scope ending after the takeover leaves the new store.
 * See: log s35.101, s35.88, docs/contract.md rule 7, tests/vapor/store-hmr.test.ts.
 */
import { describe, expect, vi } from 'vitest';
import { effectScope } from 'vue';
import { createCommandBus, inspectBus } from '../src/command-bus';
import { defineChamberStore } from '../src/store';
import { it } from '../src/vitest';

const v1 = () =>
  defineChamberStore('cart', {
    state: () => ({ items: [] as number[] }),
    reducers: { add: (s, n: number) => ({ items: [...s.items, n] }), clear: () => ({ items: [] }) },
  });
const v2 = () =>
  defineChamberStore('cart', {
    state: () => ({ items: [] as number[] }),
    reducers: { add: (s, n: number) => ({ items: [...s.items, n * 10] }), bump: (s) => s },
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
    const old = v1()(bus); // outside any scope: pinned, like a module-level store
    old.add(1);
    const next = v2()(bus);

    expect(next).not.toBe(old);
    expect(typeof next.bump).toBe('function');
    next.add(3);
    expect(next.state.value.items).toEqual([30]);
    // register() warns in DEV once per action the new definition takes over.
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
    page.stop(); // disposes the OLD store, as its last holder

    expect(useNext(bus)).toBe(next);
    next.add(1);
    expect(next.state.value.items).toEqual([10]);
    next.$dispose();
    bus.dispose();
  });
});
