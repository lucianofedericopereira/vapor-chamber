/**
 * A reaction does not run on an undo, a redo or a mirrored ('sync') command, on the sync and the async bus.
 * Why: a redo already replays the recorded follow-up, so a reaction running again would apply it twice or record new work and empty the redo stack; a `cart*` pattern would also match `cartAdd$undo`.
 * Shows: after undo and redo the counts and the history past/future hold the recorded follow-up once, with `history()` and `useCommandHistory`; a `cart*` reaction stays silent in an undo; a `__origin: 'sync'` command does not trigger it; a plain user dispatch still does.
 * See: log s36.67
 */
import { describe, expect, it } from 'vitest';
import { type BaseBus, type Command, createAsyncCommandBus, createCommandBus } from '../src/command-bus';
import { useCommandHistory } from '../src/chamber';
import { history } from '../src/plugins-core';
import { createReaction } from '../src/utilities';

const BUSES = [['sync', createCommandBus], ['async', createAsyncCommandBus]] as const;
const settle = () => new Promise((r) => setTimeout(r, 0));
const actions = (cmds: readonly Command[]) => cmds.map((c) => c.action);

/** cartAdd and its follow-up, each with an inverse; the reaction runs the follow-up. */
function world(make: () => BaseBus, pattern = 'cartAdd') {
  const bus = make();
  const count = { cart: 0, follow: 0 };
  bus.register('cartAdd', () => { count.cart++; }, { undo: () => { count.cart--; } });
  bus.register('statsBump', () => { count.follow++; }, { undo: () => { count.follow--; } });
  createReaction(pattern, 'statsBump').install(bus);
  return { bus, count };
}

describe.each(BUSES)('a reaction and history on the %s bus', (_name, make) => {
  it('a redo applies the follow-up once (M2, M3)', async () => {
    const { bus, count } = world(make);
    const h = history({ bus: bus as never });
    await bus.dispatch('cartAdd', {});
    await settle();
    expect(actions(h.getState().past)).toEqual(['cartAdd', 'statsBump']);
    h.undo(); // one press takes the follow-up with its click
    await settle();
    expect(count).toEqual({ cart: 0, follow: 0 });
    h.redo();
    await settle();
    expect(count).toEqual({ cart: 1, follow: 1 });
    // The recorded follow-up is replayed, not recorded as new work.
    expect(actions(h.getState().past)).toEqual(['cartAdd', 'statsBump']);
    expect(h.getState().past[1].meta?.origin).toBeUndefined();
    expect(h.getState().future).toEqual([]);
  });

  it('a `cart*` reaction does not run inside an undo (M4 R2)', async () => {
    const { bus, count } = world(make, 'cart*');
    const h = history({ bus: bus as never });
    await bus.dispatch('cartAdd', {});
    await settle();
    h.undo(); // the follow-up, then cartAdd, whose `cartAdd$undo` matches `cart*`
    await settle();
    expect(count).toEqual({ cart: 0, follow: 0 });
  });

  it('a reaction does not run on a command a sync layer mirrored', async () => {
    const { bus, count } = world(make);
    await bus.dispatch('cartAdd', {}, { __origin: 'sync' });
    await settle();
    expect(count).toEqual({ cart: 1, follow: 0 });
  });

  it('useCommandHistory: a redo applies the follow-up once', async () => {
    const { bus, count } = world(make);
    const h = useCommandHistory({ bus: bus as never });
    await bus.dispatch('cartAdd', {});
    await settle();
    h.undo();
    await settle();
    h.redo();
    await settle();
    expect(count).toEqual({ cart: 1, follow: 1 });
    expect(actions(h.past.value)).toEqual(['cartAdd', 'statsBump']);
    expect(h.future.value).toEqual([]);
    h.dispose();
  });

  it('control: a user dispatch still runs the reaction', async () => {
    const { bus, count } = world(make);
    await bus.dispatch('cartAdd', {});
    await settle();
    expect(count).toEqual({ cart: 1, follow: 1 });
  });
});
