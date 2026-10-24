/** One undo reverses a command and the recorded commands it caused; one redo replays them (I2). The long note is at the end. */
import { describe, expect, it, vi } from 'vitest';
import { _appliedRemotely } from '../src/applied-remotely';
import { type BaseBus, type Command, createAsyncCommandBus, createCommandBus } from '../src/command-bus';
import { useCommandHistory } from '../src/chamber';
import { history } from '../src/plugins-core';
import { defineChamberStore } from '../src/store/core';
import { createReaction } from '../src/utilities';

const BUSES = [['sync', createCommandBus], ['async', createAsyncCommandBus]] as const;
const settle = () => new Promise((r) => setTimeout(r, 0));
const names = (cmds: readonly Command[]) => cmds.map((c) => c.action);

/** Actions that count themselves, each with an inverse; `canUndo` and the undo's answer per action. */
function world(make: () => BaseBus, opts: { canUndo?: Record<string, boolean>; undoFails?: string } = {}) {
  const bus = make();
  const n: Record<string, number> = {};
  const add = (action: string) => {
    n[action] = 0;
    bus.register(action, () => { n[action]++; return n[action]; }, {
      undo: () => {
        if (opts.undoFails === action) throw new Error('refused');
        n[action]--;
      },
      ...(opts.canUndo?.[action] === false ? { canUndo: () => false } : {}),
    });
  };
  for (const a of ['click', 'follow', 'second', 'third', 'other']) add(a);
  return { bus, n, h: history({ bus: bus as never }) };
}

describe.each(BUSES)('one undo per click on the %s bus', (_name, make) => {
  it('a reaction chain: one undo reverses it, one redo replays it, both return the root', async () => {
    const w = world(make);
    createReaction('click', 'follow').install(w.bus);
    createReaction('follow', 'second').install(w.bus);
    await w.bus.dispatch('click', {});
    await settle();
    expect(names(w.h.getState().past)).toEqual(['click', 'follow', 'second']);
    const undone = w.h.undo();
    await settle();
    expect(undone?.action).toBe('click');
    expect(w.n).toMatchObject({ click: 0, follow: 0, second: 0 });
    expect(w.h.getState().past).toEqual([]);
    const redone = w.h.redo();
    await settle();
    expect(redone?.action).toBe('click');
    expect(w.n).toMatchObject({ click: 1, follow: 1, second: 1 });
    expect(names(w.h.getState().past)).toEqual(['click', 'follow', 'second']);
    expect(w.h.getState().future).toEqual([]);
  });

  it('a fan out: two follow-ups of one click are one step', async () => {
    const w = world(make);
    createReaction('click', 'follow').install(w.bus);
    createReaction('click', 'second').install(w.bus);
    await w.bus.dispatch('click', {});
    await settle();
    w.h.undo();
    await settle();
    expect(w.n).toMatchObject({ click: 0, follow: 0, second: 0 });
    w.h.redo();
    await settle();
    expect(w.n).toMatchObject({ click: 1, follow: 1, second: 1 });
  });

  it('control: plain clicks stay one step each', async () => {
    const w = world(make);
    await w.bus.dispatch('click', {});
    await w.bus.dispatch('other', {});
    w.h.undo();
    await settle();
    expect(w.n).toMatchObject({ click: 1, other: 0 });
  });

  it('an unrelated command between a cause and its follow-up ends the step', async () => {
    const w = world(make);
    await w.bus.dispatch('click', {});
    const id = w.h.getState().past[0].meta?.id;
    await w.bus.dispatch('other', {});
    await w.bus.dispatch('follow', {}, { __causationId: id });
    w.h.undo();
    await settle();
    expect(w.n).toMatchObject({ click: 1, other: 1, follow: 0 });
  });

  it('a redo stops at a step that another cause caused', async () => {
    const w = world(make);
    await w.bus.dispatch('follow', {}, { __causationId: 'x' });
    await w.bus.dispatch('second', {}, { __causationId: 'y' });
    w.h.undo();
    await settle();
    w.h.undo();
    await settle();
    expect(w.n).toMatchObject({ follow: 0, second: 0 });
    w.h.redo();
    await settle();
    expect(w.n).toMatchObject({ follow: 1, second: 0 });
  });

  it('a cause the history does not hold still groups its follow-ups', async () => {
    const w = world(make);
    await w.bus.dispatch('follow', {}, { __causationId: 'gone' });
    await w.bus.dispatch('second', {}, { __causationId: 'gone' });
    w.h.undo();
    await settle();
    expect(w.n).toMatchObject({ follow: 0, second: 0 });
  });

  it('a member that cannot be undone, read before the run, ends the step and stays', async () => {
    const w = world(make, { canUndo: { click: false } });
    createReaction('click', 'follow').install(w.bus);
    await w.bus.dispatch('click', {});
    await settle();
    w.h.undo();
    await settle();
    expect(w.n).toMatchObject({ click: 1, follow: 0 });
    expect(names(w.h.getState().past)).toEqual(['click']);
  });

  it('a member a transport carried ends the step', async () => {
    const w = world(make);
    createReaction('click', 'follow').install(w.bus);
    await w.bus.dispatch('click', {});
    await settle();
    _appliedRemotely.set(w.h.getState().past[0], undefined);
    w.h.undo();
    await settle();
    expect(w.n).toMatchObject({ click: 1, follow: 0 });
  });

  it('a member refused when it runs moves back; the members undone stay undone', async () => {
    using _err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const w = world(make, { undoFails: 'click' });
    createReaction('click', 'follow').install(w.bus);
    await w.bus.dispatch('click', {});
    await settle();
    w.h.undo();
    await settle();
    expect(w.n).toMatchObject({ click: 1, follow: 0 });
    expect(names(w.h.getState().past)).toEqual(['click']);
    expect(names(w.h.getState().future)).toEqual(['follow']);
  });

  it('a follow-up dispatched from a handler through emit stays its own step', async () => {
    const w = world(make);
    w.bus.on('ping', () => { void w.bus.dispatch('follow', {}); });
    w.bus.register('emitter', () => { w.bus.emit('ping', {}); }, { undo: () => {} });
    await w.bus.dispatch('emitter', {});
    await settle();
    w.h.undo();
    await settle();
    expect(w.n.follow).toBe(1);
  });

  it('a store derived through a reaction stays right at every press', async () => {
    const bus = make();
    const h = history({ bus: bus as never });
    const cart = defineChamberStore('cart', { state: () => ({ items: [] as number[] }), reducers: { add: (s: { items: number[] }, id: number) => ({ items: [...s.items, id] }) }, undo: true })(bus as never);
    const totals = defineChamberStore('totals', { state: () => ({ t: 0 }), reducers: { set: (_s: { t: number }, t: number) => ({ t }) }, undo: true })(bus as never);
    const sum = () => cart.state.value.items.reduce((a, b) => a + b, 0);
    createReaction('cartAdd', 'totalsSet', { map: () => sum() }).install(bus);
    const seen = async () => { await settle(); return [cart.state.value.items.length, totals.state.value.t]; };
    await cart.add(5);
    expect(await seen()).toEqual([1, 5]);
    h.undo();
    expect(await seen()).toEqual([0, 0]);
    h.redo();
    expect(await seen()).toEqual([1, 5]);
    cart.$dispose();
    totals.$dispose();
  });

  it('useCommandHistory: the same press', async () => {
    const w = world(make);
    createReaction('click', 'follow').install(w.bus);
    const u = useCommandHistory({ bus: w.bus as never });
    await w.bus.dispatch('click', {});
    await settle();
    u.undo();
    await settle();
    expect(w.n).toMatchObject({ click: 0, follow: 0 });
    expect(u.past.value).toEqual([]);
    u.redo();
    await settle();
    expect(w.n).toMatchObject({ click: 1, follow: 1 });
    u.dispose();
  });
});

describe('the async bus: a follow-up that settles after an unrelated command', () => {
  it('stays its own step', async () => {
    const bus = createAsyncCommandBus();
    const n = { click: 0, slow: 0, other: 0 };
    bus.register('click', async () => { n.click++; }, { undo: () => { n.click--; } });
    bus.register('slow', async () => { await new Promise((r) => setTimeout(r, 20)); n.slow++; }, { undo: () => { n.slow--; } });
    bus.register('other', async () => { n.other++; }, { undo: () => { n.other--; } });
    const h = history({ bus });
    createReaction('click', 'slow').install(bus);
    await bus.dispatch('click', {});
    await bus.dispatch('other', {});
    await new Promise((r) => setTimeout(r, 40));
    expect(names(h.getState().past)).toEqual(['click', 'other', 'slow']);
    h.undo();
    await settle();
    expect(n).toEqual({ click: 1, slow: 0, other: 1 });
  });
});

/*
 * Interop plan I2, owner D3 2026-10-13, in 1.32 by Q4 (2026-10-19). Read from the stacks at
 * press time, the record path unchanged. An undo reverses the top step and, while the new top
 * caused a reversed member or shares a defined cause with one, that step too. A redo replays the
 * top and each next step a member replayed in the same press caused, while each lands. A step
 * that cannot be undone (its `canUndo`, a transport carried it) or is refused when it runs ends
 * the press, and the members already moved stay moved. A follow-up an emit's listener dispatches
 * carries no cause (an emit stamps no meta), so it stays its own step: B3 owns a handler's child.
 */
