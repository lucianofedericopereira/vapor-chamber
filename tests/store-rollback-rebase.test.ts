/** An `undo: true` store rolls back any step it holds and keeps every later write (plan 1.27 item 1, R1-R4). Rationale at the end. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAsyncCommandBus, createCommandBus, type Command, type CommandResult } from '../src/command-bus';
import { createFastLane } from '../src/fast-lane';
import { history, optimisticUndo } from '../src/plugins-core';
import { createChannel, persist } from '../src/plugins-io';
import { defineChamberStore } from '../src/store';

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
afterEach(() => { while (closers.length) closers.pop()!(); vi.restoreAllMocks(); });

/** The Commands a bus ran for `action`, in order. */
function recorder(bus: { use(p: any): unknown }, action: string): Command[] {
  const seen: Command[] = [];
  bus.use((cmd: Command, next: () => unknown) => { const r = next(); if (cmd.action === action) seen.push(cmd); return r; });
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

  it('persist saves the kept state', () => {
    let stored: string | null = null;
    const storage = { getItem: () => stored, setItem: (_k: string, v: string) => { stored = v; }, removeItem: () => { stored = null; } };
    const bus = createCommandBus();
    const seen = recorder(bus, 'cartAdd');
    const cart = useCart(bus);
    bus.use(persist({ key: 'vc:cart', storage, getState: () => cart.state.value }));
    cart.add('A');
    cart.add('B');
    bus.dispatch('cartAdd$undo', seen[0]);
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
    bus.use(h);
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

  it('optimisticUndo on an action that failed leaves the state and logs no rollback error', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bus = createCommandBus();
    bus.use(optimisticUndo(bus, ['cartAdd']));
    const cart = useCart(bus);
    cart.add('A');
    expect((cart.add('bad') as CommandResult).ok).toBe(false);
    expect(cart.state.value).toEqual({ items: ['A'] });
    expect(error.mock.calls.some((c) => String(c[0]).includes('Undo rollback error'))).toBe(false);
    cart.$dispose();
  });
});

describe("a tab's write is a step", () => {
  it('a rollback of an earlier local step keeps the state another tab sent', async () => {
    const name = `rebase-${Math.random()}`;
    const make = () => {
      const lane = createFastLane();
      const ch = createChannel({ channel: name, lane, events: ['shared$state'] });
      closers.push(() => ch.dispose());
      const bus = createCommandBus();
      const seen = recorder(bus, 'sharedAdd');
      const store = defineChamberStore('shared', { state: (): Cart => ({ items: [] }), reducers, undo: true, share: lane })(bus);
      closers.push(() => store.$dispose());
      return { bus, seen, store };
    };
    const a = make();
    const b = make();
    a.store.add('A');
    await new Promise((r) => setTimeout(r, 20));
    b.store.add('B');
    await new Promise((r) => setTimeout(r, 20));
    expect(a.store.state.value).toEqual({ items: ['A', 'B'] });
    a.bus.dispatch('sharedAdd$undo', a.seen[0]);
    expect(a.store.state.value).toEqual({ items: ['A', 'B'] });
  });
});

/*
 * The ring holds each step as [command, before, after]. Before this, the
 * inverse wrote the undone step's "before" straight into the state, so
 * undoing step A after A, B erased B (plan P0), and an undo for a command the
 * ring did not hold read slot 0: the oldest step's COMMAND became the state
 * (audit B1). optimisticUndo and a transactional batch reach both paths.
 *
 * Now (Memento for owned state, rebase as Replicache and Apollo's optimistic
 * layers do): undoing step i starts from its "before" and re-applies every
 * later step from what the ring holds, by calling the reducer directly
 * (plugins and bridges never see those steps again). An undone step is skipped
 * by every later replay, so a second $undo of it is the identity, as is an
 * undo for a step the ring does not hold. A tab's write (`<id>$sync`) is a
 * step too, replayed as the state it carried, so a rollback never erases it.
 * A replay that throws leaves the state and the ring as they were.
 *
 * The share test: tab a writes A, then receives B's state [A, B] from tab b.
 * Undoing A replays the sync step, whose state is [A, B], so a keeps it. That
 * is share's documented last-writer-wins: the incoming state is the fact.
 */
