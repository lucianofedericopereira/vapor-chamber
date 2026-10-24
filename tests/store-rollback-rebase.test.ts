/** An `undo: true` store rolls back any step it holds and keeps every later write (log s35.157). Rationale at the end. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAsyncCommandBus, createCommandBus, type Command, type CommandResult } from '../src/command-bus';
import { history } from '../src/plugins-core';
import { defineChamberStore } from '../src/store';
import { saveTo } from '../src/store-persist';
import { shareTabs } from '../src/store-share';
import { listen, quiet } from './tabs-quiet';

type Cart = { items: string[] };
const reducers = {
  add: (s: Cart, item: string) => {
    if (item === 'needs-x' && !s.items.includes('x')) throw new Error('needs x first');
    if (item === 'bad') throw new Error('bad item');
    return { items: [...s.items, item] };
  },
};
const useCart = defineChamberStore('cart', { state: (): Cart => ({ items: [] }), reducers, undo: true });

const closers: Array<() => void> = [];
afterEach(() => { while (closers.length) closers.pop()!(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

/** The Commands a bus ran for `action`, in order. */
function recorder(bus: { use(p: any): unknown }, action: string): Command[] {
  const seen: Command[] = [];
  bus.use({ settled: (cmd: Command) => { if (cmd.action === action) seen.push(cmd); } });
  return seen;
}

describe('rollback of an older step', () => {
  it('sync: undoing A after A, B keeps B', () => {
    const bus = createCommandBus();
    const seen = recorder(bus, 'cartAdd');
    const cart = useCart(bus);
    cart.add('A');
    cart.add('B');
    const r = bus.dispatch('cartAdd$undo', seen[0]);
    expect(r.ok).toBe(true);
    expect(cart.state.value).toEqual({ items: ['B'] });
    cart.$dispose();
  });

  it('async: undoing A after A, B keeps B', async () => {
    const bus = createAsyncCommandBus({ retry: false });
    const seen = recorder(bus, 'cartAdd');
    const cart = useCart(bus);
    await cart.add('A');
    await cart.add('B');
    const r = await bus.dispatch('cartAdd$undo', seen[0]);
    expect(r.ok).toBe(true);
    expect(cart.state.value).toEqual({ items: ['B'] });
    cart.$dispose();
  });

  it("the store's persist saves the kept state", async () => {
    let stored: string | null = null;
    const storage = { getItem: () => stored, setItem: (_k: string, v: string) => { stored = v; } };
    const bus = createCommandBus();
    const seen = recorder(bus, 'cartAdd');
    const cart = defineChamberStore('cart', { state: (): Cart => ({ items: [] }), reducers, undo: true, persist: saveTo({ key: 'vc:cart', storage }) })(bus);
    cart.add('A');
    cart.add('B');
    bus.dispatch('cartAdd$undo', seen[0]);
    await Promise.resolve();
    expect(stored).toBe(JSON.stringify({ items: ['B'] }));
    cart.$dispose();
  });

  it('a step undone once is undone: a second $undo of it changes nothing', () => {
    const bus = createCommandBus();
    const seen = recorder(bus, 'cartAdd');
    const cart = useCart(bus);
    cart.add('A');
    cart.add('B');
    bus.dispatch('cartAdd$undo', seen[1]);
    cart.add('C');
    bus.dispatch('cartAdd$undo', seen[1]);
    expect(cart.state.value).toEqual({ items: ['A', 'C'] });
    cart.$dispose();
  });

  it('a rollback keeps the state a later $reset set', () => {
    const bus = createCommandBus();
    const seen = recorder(bus, 'cartAdd');
    const cart = useCart(bus);
    cart.add('A');
    cart.$reset();
    cart.add('B');
    bus.dispatch('cartAdd$undo', seen[0]);
    expect(cart.state.value).toEqual({ items: ['B'] });
    cart.$dispose();
  });

  it('a rollback passes over a step already undone', () => {
    const bus = createCommandBus();
    const seen = recorder(bus, 'cartAdd');
    const cart = useCart(bus);
    cart.add('A');
    cart.add('B');
    cart.add('C');
    bus.dispatch('cartAdd$undo', seen[1]);
    expect(cart.state.value).toEqual({ items: ['A', 'C'] });
    bus.dispatch('cartAdd$undo', seen[0]);
    expect(cart.state.value).toEqual({ items: ['C'] });
    cart.$dispose();
  });

  it('a rollback whose replay throws changes nothing, and the newest step still undoes', () => {
    const bus = createCommandBus();
    const seen = recorder(bus, 'cartAdd');
    const cart = useCart(bus);
    cart.add('x');
    cart.add('needs-x');
    const r = bus.dispatch('cartAdd$undo', seen[0]);
    expect(r.ok).toBe(false);
    expect(cart.state.value).toEqual({ items: ['x', 'needs-x'] });
    bus.dispatch('cartAdd$undo', seen[1]);
    expect(cart.state.value).toEqual({ items: ['x'] });
    cart.$dispose();
  });

  it('control: undoing the newest step restores its state exactly', () => {
    const bus = createCommandBus();
    const seen = recorder(bus, 'cartAdd');
    const cart = useCart(bus);
    cart.add('A');
    const afterA = cart.state.value;
    cart.add('B');
    bus.dispatch('cartAdd$undo', seen[1]);
    expect(cart.state.value).toBe(afterA);
    cart.$dispose();
  });

  it('control: history undo and redo go one step at a time', () => {
    const bus = createCommandBus();
    const h = history({ bus });
    const cart = useCart(bus);
    cart.add('A');
    cart.add('B');
    h.undo();
    expect(cart.state.value).toEqual({ items: ['A'] });
    h.redo();
    expect(cart.state.value).toEqual({ items: ['A', 'B'] });
    cart.$dispose();
  });
});

describe('an undo for a step the store does not hold', () => {
  it('changes nothing and answers ok: never a Command as the state', () => {
    const bus = createCommandBus();
    const cart = useCart(bus);
    cart.add('A');
    const r = bus.dispatch('cartAdd$undo', { action: 'cartAdd', target: 'Z', meta: { id: 'never-ran', ts: 0 } });
    expect(r.ok).toBe(true);
    expect(cart.state.value).toEqual({ items: ['A'] });
    cart.$dispose();
  });

  it('an optimistic store action that failed leaves the state and reports no undo error', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const cart = defineChamberStore('cart', { state: (): Cart => ({ items: [] }), reducers, undo: true, optimistic: true })(createCommandBus());
    cart.add('A');
    expect((cart.add('bad') as CommandResult).ok).toBe(false);
    expect(cart.state.value).toEqual({ items: ['A'] });
    expect(error.mock.calls.some((c) => String(c[0]).includes('The undo of'))).toBe(false);
    cart.$dispose();
  });
});

describe("a tab's write is a step", () => {
  it("a rollback of an earlier local step re-applies another tab's later command, and reaches that tab", async () => {
    vi.stubGlobal('window', {}); // a page: shareTabs opens only where there are tabs
    const name = `rebase-${Math.random()}`;
    const wire = listen(name);
    closers.push(wire.close);
    const make = () => {
      const bus = createCommandBus();
      const seen = recorder(bus, 'sharedAdd');
      const store = defineChamberStore('shared', { state: (): Cart => ({ items: [] }), reducers, undo: true, share: shareTabs(name) })(bus);
      closers.push(() => store.$dispose());
      return { bus, seen, store };
    };
    const a = make();
    const b = make();
    a.store.add('A');
    await quiet(wire.heard);
    b.store.add('B');
    await quiet(wire.heard);
    expect(a.store.state.value).toEqual({ items: ['A', 'B'] });
    a.bus.dispatch('sharedAdd$undo', a.seen[0]);
    expect(a.store.state.value).toEqual({ items: ['B'] });
    await quiet(wire.heard);
    expect(b.store.state.value).toEqual({ items: ['B'] });
  });
});

/*
 * The ring holds each step as [command, before, after]. Before this, the
 * inverse wrote the undone step's "before" straight into the state, so
 * undoing step A after A, B erased B (plan P0), and an undo for a command the
 * ring did not hold read slot 0: the oldest step's COMMAND became the state
 * (audit B1). An optimistic action's failure and a transactional batch reach both paths.
 *
 * Now (Memento for owned state, rebase as Replicache and Apollo's optimistic
 * layers do): undoing step i starts from its "before" and re-applies every
 * later step from what the ring holds, by calling the reducer directly
 * (plugins and bridges never see those steps again). An undone step is skipped
 * by every later replay, so a second $undo of it is the identity, as is an
 * undo for a step the ring does not hold. A state another tab sent is a
 * step too, under a marker no action replays, so a rollback never erases it.
 * A replay that throws leaves the state and the ring as they were.
 *
 * The share test: tab a writes A, then receives B's state [A, B] from tab b.
 * Undoing A re-applies the received step as the state it set, [A, B], so a
 * keeps it. That is share's documented last-writer-wins: the incoming state
 * is the fact.
 */
