/** A handler's child that declares its cause is undone with its parent and applied once on redo (B3). The long note is at the end. */
import { describe, expect, it } from 'vitest';
import { type BaseBus, type Command, createAsyncCommandBus, createCommandBus } from '../src/command-bus';
import { useCommandHistory } from '../src/chamber';
import { history } from '../src/plugins-core';
import { defineChamberStore } from '../src/store/core';
import { createReaction } from '../src/utilities';

const BUSES = [['sync', createCommandBus], ['async', createAsyncCommandBus]] as const;
const settle = () => new Promise((r) => setTimeout(r, 0));
const names = (cmds: readonly Command[]) => cmds.map((c) => c.action);

/**
 * `cartAdd`'s handler dispatches `statsBump` before it returns (M5), declaring its cause when
 * `declare` is set. Each action counts its runs and has an inverse; `refuse` fails cartAdd.
 */
function world(make: () => BaseBus, declare: boolean) {
  const bus = make();
  const n = { cart: 0, stats: 0 };
  const state = { refuse: false };
  bus.register('statsBump', () => { n.stats++; }, { undo: () => { n.stats--; } });
  bus.register('cartAdd', (cmd: Command) => {
    if (state.refuse) throw new Error('refused');
    void bus.dispatch('statsBump', null, declare ? { __causationId: cmd.meta?.id } : undefined);
    n.cart++;
  }, { undo: () => { n.cart--; } });
  return { bus, n, state };
}

describe('history.clear() during a press of several steps', () => {
  /** cartAdd's handler dispatches its declared child; cartAdd's own steps wait on `gate`. */
  function gated() {
    const bus = createAsyncCommandBus({ retry: false });
    let open!: () => void;
    let gate = Promise.resolve();
    const hold = (): void => { gate = new Promise<void>((r) => { open = r; }); };
    bus.register('statsBump', async () => 1, { undo: () => {} });
    bus.register('cartAdd', async (cmd: Command) => {
      // The child first: a dispatch after the handler's own await is outside the origin's scope.
      void bus.dispatch('statsBump', null, { __causationId: cmd.meta?.id });
      await gate;
      return 1;
    }, { undo: async () => { await gate; } });
    return { bus, hold, open: () => open() };
  }

  it('an undo: the step still to move finds nothing, and the history stays cleared', async () => {
    const { bus, hold, open } = gated();
    const h = history({ bus });
    await bus.dispatch('cartAdd', {});
    await settle();
    expect(names(h.getState().past)).toEqual(['statsBump', 'cartAdd']);
    hold();
    h.undo(); // cartAdd's undo waits on the gate; statsBump is next
    h.clear();
    open();
    await settle();
    expect([h.getState().past, h.getState().future]).toEqual([[], []]);
  });

  it('a redo: the child to carry back finds nothing, and the history stays cleared', async () => {
    const { bus, hold, open } = gated();
    const h = history({ bus });
    await bus.dispatch('cartAdd', {});
    await settle();
    h.undo();
    await settle();
    expect(names(h.getState().future)).toHaveLength(2);
    hold();
    h.redo(); // cartAdd's redo waits on the gate; its child is carried after
    h.clear();
    open();
    await settle();
    await settle();
    expect([h.getState().past, h.getState().future]).toEqual([[], []]);
  });
});

describe.each(BUSES)('a declared handler child on the %s bus', (_name, make) => {
  it('one undo takes the child with its parent; one redo applies it once (M5)', async () => {
    const { bus, n } = world(make, true);
    const h = history({ bus: bus as never });
    await bus.dispatch('cartAdd', {});
    await settle();
    expect(names(h.getState().past)).toEqual(['statsBump', 'cartAdd']);

    const undone = h.undo();
    await settle();
    expect(n).toEqual({ cart: 0, stats: 0 });
    expect(h.getState().past).toEqual([]);

    const redone = h.redo();
    await settle();
    expect(n).toEqual({ cart: 1, stats: 1 });
    expect(names(h.getState().past)).toEqual(['statsBump', 'cartAdd']);
    expect(h.getState().future).toEqual([]);
    expect([undone?.action, redone?.action]).toEqual(['cartAdd', 'cartAdd']);
  });

  it('control: an undeclared child keeps the released behaviour, its own step', async () => {
    const { bus, n } = world(make, false);
    const h = history({ bus: bus as never });
    await bus.dispatch('cartAdd', {});
    await settle();
    h.undo();
    await settle();
    expect(n).toEqual({ cart: 0, stats: 1 });
    expect(names(h.getState().past)).toEqual(['statsBump']);
  });

  it("the parent's redo refused: the child stays on the redo stack with it", async () => {
    const { bus, n, state } = world(make, true);
    const h = history({ bus: bus as never });
    await bus.dispatch('cartAdd', {});
    await settle();
    h.undo();
    await settle();
    state.refuse = true;
    h.redo();
    await settle();
    expect(n).toEqual({ cart: 0, stats: 0 });
    expect(names(h.getState().future)).toEqual(['cartAdd', 'statsBump']);
    expect(h.getState().past).toEqual([]);
  });

  it('a reaction follow-up and a handler child in one press', async () => {
    const { bus, n } = world(make, true);
    let follow = 0;
    bus.register('noteAdd', () => { follow++; }, { undo: () => { follow--; } });
    createReaction('cartAdd', 'noteAdd').install(bus);
    const h = history({ bus: bus as never });
    await bus.dispatch('cartAdd', {});
    await settle();
    expect(names(h.getState().past)).toEqual(['statsBump', 'cartAdd', 'noteAdd']);
    h.undo();
    await settle();
    expect([n.cart, n.stats, follow]).toEqual([0, 0, 0]);
    h.redo();
    await settle();
    expect([n.cart, n.stats, follow]).toEqual([1, 1, 1]);
    expect(names(h.getState().past)).toEqual(['statsBump', 'cartAdd', 'noteAdd']);
  });

  it('a store action declared in the handler is undone and redone with it', async () => {
    const bus: BaseBus = make();
    const stats = defineChamberStore('stats', { state: () => ({ n: 0 }), reducers: { bump: (s: { n: number }) => ({ n: s.n + 1 }) }, undo: true })(bus as never);
    let cart = 0;
    bus.register('cartAdd', (cmd: Command) => {
      void stats.bump(null, { __causationId: cmd.meta?.id });
      cart++;
    }, { undo: () => { cart--; } });
    const h = history({ bus: bus as never });
    await bus.dispatch('cartAdd', {});
    await settle();
    h.undo();
    await settle();
    expect([cart, stats.state.value.n]).toEqual([0, 0]);
    h.redo();
    await settle();
    expect([cart, stats.state.value.n]).toEqual([1, 1]);
    stats.$dispose();
  });

  it('two children and a grandchild come back in the order they were recorded', async () => {
    const bus: BaseBus = make();
    const n = { a: 0, b: 0, g: 0, root: 0 };
    const counted = (k: keyof typeof n) => ({ undo: () => { n[k]--; } });
    bus.register('grand', () => { n.g++; }, counted('g'));
    bus.register('childA', (cmd: Command) => { void bus.dispatch('grand', null, { __causationId: cmd.meta?.id }); n.a++; }, counted('a'));
    bus.register('childB', () => { n.b++; }, counted('b'));
    bus.register('root', (cmd: Command) => {
      const cause = { __causationId: cmd.meta?.id };
      void bus.dispatch('childA', null, cause);
      void bus.dispatch('childB', null, cause);
      n.root++;
    }, counted('root'));
    const h = history({ bus: bus as never });
    await bus.dispatch('root', {});
    await settle();
    const recorded = names(h.getState().past);
    h.undo();
    await settle();
    expect(n).toEqual({ a: 0, b: 0, g: 0, root: 0 });
    h.redo();
    await settle();
    expect(n).toEqual({ a: 1, b: 1, g: 1, root: 1 });
    expect(names(h.getState().past)).toEqual(recorded);
  });

  it('useCommandHistory: the same press', async () => {
    const { bus, n } = world(make, true);
    const u = useCommandHistory({ bus: bus as never });
    await bus.dispatch('cartAdd', {});
    await settle();
    u.undo();
    await settle();
    expect(n).toEqual({ cart: 0, stats: 0 });
    u.redo();
    await settle();
    expect(n).toEqual({ cart: 1, stats: 1 });
    u.dispose();
  });
});

/*
 * Interop plan B3 (probe M5). A handler that dispatches a child before it returns: the child
 * settles first, so it is recorded below its parent. Before, an undo took the parent only, and
 * a redo re-ran the parent's handler, which dispatched the child again on top of the child
 * still applied: the child applied twice. The library does not infer a child from the
 * dispatch depth: the record rejected inferring a nested dispatch (whitepaper.md, "infer root
 * from derived dispatches") and decided the side that knows declares. The handler declares
 * with the documented `__causationId: cmd.meta.id` (README "meta"). The ledger reads it at
 * press time: a member's declared child below it goes with the press; on redo it is not
 * dispatched, the parent's handler dispatches it again (origin redo, not recorded), and its
 * entry moves back once the parent lands. A child that declares nothing is its own step, as
 * released. A child dispatched after an await in the handler is outside the redo's origin
 * scope, the limit command-bus.ts states for that scope.
 */
