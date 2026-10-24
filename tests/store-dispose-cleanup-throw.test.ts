/** A cleanup that throws in `$dispose` is logged, and the store is still removed. Rationale at the end. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { effectScope } from 'vue';
import { createCommandBus, type CommandResult } from '../src/command-bus';
import { defineChamberStore as defineVue } from '../src/store';
import { defineChamberStore as defineCore } from '../src/store/core';

type C = { n: number };
const state = (): C => ({ n: 0 });
const reducers = { add: (s: C) => ({ n: s.n + 1 }) };
const boom = new Error('cleanup');
// A share whose dispose throws: an app-supplied cleanup in `$dispose`.
const throwingShare = () => ({ send: () => {}, dispose: () => { throw boom; }, ready: Promise.resolve() });

afterEach(() => { vi.restoreAllMocks(); });

for (const [runtime, define] of [['vue', defineVue], ['core', defineCore]] as const) {
  describe(`${runtime} store: a cleanup that throws in $dispose`, () => {
    it('is logged; the store is removed, and the next useStore builds one that works', () => {
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
      const bus = createCommandBus();
      const useCart = (define as typeof defineCore)('cart', { state, reducers, share: throwingShare });
      const first = useCart(bus);

      expect(() => first.$dispose()).not.toThrow();
      expect(bus.hasHandler('cartAdd')).toBe(false);
      expect(logged).toHaveBeenCalledWith(expect.stringMatching(/^\[vapor-chamber\] \[ FAIL \] store:failed:cleanup: Store "cart": a cleanup threw during \$dispose/), boom);

      const again = useCart(bus);
      expect(again).not.toBe(first);
      expect((again.add() as CommandResult).ok).toBe(true);
      expect(again.state.value.n).toBe(1);
      again.$dispose();
    });
  });
}

describe('vue store', () => {
  it("through the last holder's scope ending", () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const bus = createCommandBus();
    const useCart = defineVue('cart', { state, reducers, share: throwingShare });
    const page = effectScope();
    const held = page.run(() => useCart(bus))!;

    expect(() => page.stop()).not.toThrow();

    const again = useCart(bus);
    expect(again).not.toBe(held);
    expect((again.add() as CommandResult).ok).toBe(true);
    again.$dispose();
  });
});

/*
 * `$dispose` ran its cleanups in a plain
 * loop and cleared the registry entry after it. A cleanup that threw stopped
 * the loop before the registry line, so the entry stayed: the next
 * `useStore(bus)` of the same definition joined the disposed store, whose
 * handlers were already gone, and every action returned
 * `core:missing:handler`. That is the failure the StoreEntry docblock exists
 * to prevent. Each cleanup now runs in its own try, a throw is logged with the
 * error as its own argument, and the loop, the field watch's stop and the
 * registry line always run.
 */
