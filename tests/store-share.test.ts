/** A store shared across tabs (`share: lane`): every tab converges on one state. Log s35.129. */
import { afterEach, describe, expect, it } from 'vitest';
import { createCommandBus } from '../src/command-bus';
import { createFastLane } from '../src/fast-lane';
import { history } from '../src/plugins-core';
import { createChannel, persist } from '../src/plugins-io';
import { defineChamberStore } from '../src/store';

type Cart = { items: string[] };
const reducers = {
  add: (s: Cart, item: string) => ({ items: [...s.items, item] }),
};

const closers: Array<() => void> = [];
afterEach(() => { while (closers.length) closers.pop()!(); });

let n = 0;
/** One "tab": its own bus, lane, channel and store instance, on a shared channel name. */
function tab(name: string, opts: { share?: boolean } = {}) {
  const lane = createFastLane();
  const ch = createChannel({ channel: name, lane, events: ['cart$state'] });
  closers.push(() => ch.dispose());
  const bus = createCommandBus();
  const useCart = defineChamberStore('cart', { state: (): Cart => ({ items: [] }), reducers, share: opts.share === false ? undefined : lane });
  const cart = useCart(bus);
  closers.push(() => cart.$dispose());
  return { bus, lane, cart };
}

/** BroadcastChannel delivers on a later task. */
const settle = () => new Promise((r) => setTimeout(r, 20));

describe('a shared store', () => {
  it("a write in one tab becomes every tab's state", async () => {
    const name = `share-${n++}`;
    const a = tab(name);
    const b = tab(name);
    a.cart.add('milk');
    await settle();
    expect(b.cart.state.value).toEqual({ items: ['milk'] });
    b.cart.add('bread');
    await settle();
    expect(a.cart.state.value).toEqual({ items: ['milk', 'bread'] });
  });

  it('two tabs writing at once end on the same state', async () => {
    const name = `share-${n++}`;
    const a = tab(name);
    const b = tab(name);
    a.cart.add('from-a');
    b.cart.add('from-b');
    await settle();
    await settle();
    expect(a.cart.state.value).toEqual(b.cart.state.value);
  });

  it('the receiving tab hears it as cart$sync with origin sync; its history does not record it', async () => {
    const name = `share-${n++}`;
    const a = tab(name);
    const b = tab(name);
    const h = history({ bus: b.bus });
    b.bus.use(h);
    const heard: string[] = [];
    b.bus.on('*', (cmd) => heard.push(`${cmd.action}:${cmd.meta?.origin}`));
    a.cart.add('milk');
    await settle();
    expect(heard).toEqual(['cart$sync:sync']);
    expect(h.getState().past).toEqual([]);
  });

  it("the receiving tab's persist saves the state it received", async () => {
    const name = `share-${n++}`;
    const a = tab(name);
    const b = tab(name);
    let saved: string | null = null;
    const storage = { getItem: () => saved, setItem: (_k: string, v: string) => { saved = v; }, removeItem: () => { saved = null; } };
    b.bus.use(persist({ key: 'cart', storage, getState: () => b.cart.state.value }));
    a.cart.add('milk');
    await settle();
    expect(saved).toBe(JSON.stringify({ items: ['milk'] }));
  });

  it('a received state is not sent back (no echo)', async () => {
    const name = `share-${n++}`;
    const a = tab(name);
    const b = tab(name);
    const sentByB: unknown[] = [];
    b.lane.on('cart$state', (m: { tab: string }) => sentByB.push(m));
    a.cart.add('milk');
    await settle();
    // b's lane carries a's fact in (the channel re-emits it locally), and a's
    // answer to b's open when a had written first; b sends nothing of its own
    expect(sentByB.length).toBeGreaterThan(0);
    expect(new Set(sentByB.map((m) => (m as { tab: string }).tab)).size).toBe(1);
    expect(sentByB.filter((m) => !(m as { to?: string }).to)).toHaveLength(1);
  });

  it('$dispose stops sharing; a store without share sends nothing', async () => {
    const name = `share-${n++}`;
    const a = tab(name);
    const b = tab(name);
    const c = tab(name, { share: false });
    a.cart.$dispose();
    a.cart.add('ignored');
    c.cart.add('local only');
    await settle();
    expect(b.cart.state.value).toEqual({ items: [] });
  });
});
