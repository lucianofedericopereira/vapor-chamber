/** persist({ actions, actionFilter }) saves only for the actions it names. The long note is at the end. */
import { describe, expect, it } from 'vitest';
import { createActionFilter } from '../src/action-filter';
import { createCommandBus, inspectBus } from '../src/command-bus';
import { history } from '../src/plugins-core';
import { persist } from '../src/plugins-io';
import { defineChamberStore } from '../src/store';

const useCart = defineChamberStore('cart', {
  state: () => ({ items: [] as number[] }),
  reducers: { add: (s, id: number) => ({ items: [...s.items, id] }) },
  undo: true,
});

function setup(scope: { actions?: string[]; actionFilter?: ReturnType<typeof createActionFilter> }) {
  const bus = createCommandBus();
  const cart = useCart(bus);
  bus.register('userSet', () => true);
  const hist = history({ maxSize: 10, bus });
  bus.use(hist);
  const saves: string[] = [];
  bus.use(
    persist({
      key: 'vc:cart',
      getState: () => cart.state.value,
      storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
      filter: (cmd) => {
        saves.push(cmd.action);
        return true;
      },
      ...scope,
    }),
  );
  return { bus, cart, hist, saves };
}

function drive(s: ReturnType<typeof setup>): string[] {
  s.cart.add(1);
  s.hist.undo();
  s.cart.$reset();
  s.bus.dispatch('userSet', 'u1');
  return s.saves;
}

describe('persist action scope', () => {
  it('actions: cart* saves on cartAdd, its undo and cart$reset, not on userSet', () => {
    expect(drive(setup({ actions: ['cart*'] }))).toEqual(['cartAdd', 'cartAdd$undo', 'cart$reset']);
  });

  it('actionFilter: the same scope as a filter expression', () => {
    const actionFilter = createActionFilter([{ prefix: { action: 'cart' } }]);
    expect(drive(setup({ actionFilter }))).toEqual(['cartAdd', 'cartAdd$undo', 'cart$reset']);
  });

  it('control: an unscoped persist saves on every successful dispatch', () => {
    expect(drive(setup({}))).toEqual(['cartAdd', 'cartAdd$undo', 'cart$reset', 'userSet']);
  });

  it('inspectBus reports the scope it declared', () => {
    const { bus } = setup({ actions: ['cart*'] });
    const entry = inspectBus(bus).plugins.find((p) => p.id === 'persist');
    expect(entry?.actions).toEqual(['cart*']);
  });
});

/*
 * Plan .probes/1.28-plan.md item 9b. Before it, persist declared no scope, so
 * the bus ran it on every dispatch and an app narrowed it with `filter(cmd)`,
 * which runs after the handler on every success. The scope is the bus's own
 * per-action chain (perAction in src/command-bus.ts), as for the outbox and
 * the bridges. `filter` here records which actions reached persist: it runs
 * only once the bus has run persist for that action.
 */
