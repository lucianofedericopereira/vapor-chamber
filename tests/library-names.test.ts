/** A name with `$` is the library's: an app's is refused, coded (log s35.117). */
import { describe, expect } from 'vitest';
import { BusError, createAsyncCommandBus, createCommandBus } from '../src/command-bus';
import { history } from '../src/plugins-core';
import { defineChamberStore } from '../src/store';
import { createTestBus } from '../src/testing';
import { it } from '../src/vitest';

const thrown = (fn: () => unknown): unknown => { try { fn(); } catch (e) { return e; } return undefined; };

describe("an app's $ name is refused", () => {
  it('register() on both buses and the test bus: core:invalid:name', () => {
    for (const bus of [createCommandBus(), createAsyncCommandBus(), createTestBus()] as const) {
      const error = thrown(() => (bus as ReturnType<typeof createCommandBus>).register('save$draft', () => 1));
      expect(error).toBeInstanceOf(BusError);
      expect((error as BusError).code).toBe('core:invalid:name');
      expect((error as BusError).context).toEqual({ action: 'save$draft' });
    }
  });

  it('a store id or action key with $: store:invalid:name, at definition', () => {
    const state = () => ({ n: 0 });
    expect((thrown(() => defineChamberStore('ca$rt', { state, actions: {} })) as BusError).code).toBe('store:invalid:name');
    expect((thrown(() => defineChamberStore('cart', { state, actions: { add$undo: (s: { n: number }) => s } })) as BusError).code).toBe('store:invalid:name');
  });

  it("the library's own still register: a store's $reset, an action's $undo, on a bus with a strict naming rule", () => {
    const bus = createCommandBus({ naming: { pattern: /^[a-z]+[A-Z][a-zA-Z]*$/, onViolation: 'throw' } });
    const useCart = defineChamberStore('cart', { state: () => ({ n: 0 }), actions: { set: (_s: { n: number }, n: number) => ({ n }) }, undo: true });
    const cart = useCart(bus);
    expect(bus.hasHandler('cart$reset')).toBe(true);
    expect(bus.hasHandler('cartSet$undo')).toBe(true);
    cart.$dispose();
  });

  it('a naming violation in throw mode is coded too', () => {
    const bus = createCommandBus({ naming: { pattern: /^[a-z]+[A-Z]/, onViolation: 'throw' } });
    const error = thrown(() => bus.register('save', () => 1)) as BusError;
    expect(error.code).toBe('core:invalid:name');
    expect(error.context).toMatchObject({ action: 'save' });
  });

  it('the test bus registers <action>$undo as the real bus does, so history undoes there too', () => {
    const bus = createTestBus({ passthroughHandlers: true });
    const h = history({ bus: bus as never });
    bus.use(h as never);
    let undone = 0;
    bus.register('add', () => 1, { undo: () => { undone++; } });
    bus.dispatch('add', 1);
    h.undo();
    expect(undone).toBe(1);
  });
});
