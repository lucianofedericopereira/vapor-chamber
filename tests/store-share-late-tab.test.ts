/** A shared store opened later asks for the current state, so its writes build on it (log s35.164). Rationale at the end. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCommandBus } from '../src/command-bus';
import { defineChamberStore } from '../src/store';
import { shareTabs } from '../src/store-share';
import { quiet, traffic } from './tabs-quiet';

type Cart = { items: string[] };
const reducers = { add: (s: Cart, item: string) => ({ items: [...s.items, item] }) };

const closers: Array<() => void> = [];
// A page: shareTabs opens only where there are tabs.
beforeEach(() => { vi.stubGlobal('window', {}); });
afterEach(() => { while (closers.length) closers.pop()!(); vi.unstubAllGlobals(); });

let n = 0;
/** One "tab": its own bus and store, sharing over the channel `name`; `writes` counts its state's changes. */
function tab(name: string) {
  const bus = createCommandBus();
  const cart = defineChamberStore('cart', { state: (): Cart => ({ items: [] }), reducers, share: shareTabs(name) })(bus);
  let writes = 0;
  cart.$onField('items', () => { writes++; });
  closers.push(() => cart.$dispose());
  return { cart, writes: () => writes };
}

/** Every message on the channel `name`, as another tab reads it. */
function wire(name: string): Array<Record<string, unknown>> {
  const heard: Array<Record<string, unknown>> = [];
  const ch = new BroadcastChannel(name);
  ch.onmessage = (e) => { heard.push(e.data); };
  closers.push(() => ch.close());
  return heard;
}

/** Every message on the channels this file's tabs use: `settle` waits until they carry nothing (tests/tabs-quiet.ts). */
const net = traffic();
afterEach(() => net.close());
const settle = (): Promise<void> => net.settle();

describe('a tab opened later', () => {
  it('catches up when it opens, and its write builds on the current state', async () => {
    const name = `late-${n++}`;
    net.watch(name);
    const a = tab(name);
    a.cart.add('milk');
    a.cart.add('eggs');
    a.cart.add('tea');
    await settle();
    const b = tab(name);
    await settle();
    expect(b.cart.state.value).toEqual({ items: ['milk', 'eggs', 'tea'] });
    b.cart.add('bread');
    await settle();
    expect(a.cart.state.value).toEqual({ items: ['milk', 'eggs', 'tea', 'bread'] });
    a.cart.add('jam');
    await settle();
    expect(b.cart.state.value).toEqual({ items: ['milk', 'eggs', 'tea', 'bread', 'jam'] });
  });

  it('peers already in step are not written again when a tab opens', async () => {
    const name = `late-${n++}`;
    net.watch(name);
    const a = tab(name);
    const c = tab(name);
    a.cart.add('milk');
    await settle();
    const before = [a.writes(), c.writes()];
    tab(name);
    await settle();
    expect([a.writes(), c.writes()]).toEqual(before);
  });

  it('a write made before the answer is kept, and every tab ends on one state', async () => {
    const name = `late-${n++}`;
    net.watch(name);
    const a = tab(name);
    a.cart.add('milk');
    a.cart.add('eggs');
    await settle();
    const b = tab(name);
    b.cart.add('bread');
    await settle();
    await settle();
    expect(b.cart.state.value).toEqual(a.cart.state.value);
  });
});

describe('the ask', () => {
  it('the tab holding the lock answers, written or not, and the asker takes the state', async () => {
    const name = `late-${n++}`;
    net.watch(name);
    const heard = wire(name);
    const a = tab(name);
    await settle();
    const b = tab(name);
    await settle();
    expect(a.writes()).toBe(0);
    expect(b.cart.state.value).toEqual({ items: [] });
    expect(heard.filter((m) => m.kind === 'answer').map((m) => m.value)).toEqual([{ items: [] }]);
  });

  it('is { kind: ask, tab }, answered by the tab holding the lock with its state', async () => {
    const name = `late-${n++}`;
    net.watch(name);
    const a = tab(name);
    a.cart.add('milk');
    await settle();
    const heard = wire(name);
    tab(name);
    await quiet(heard);
    const ask = heard.find((m) => m.kind === 'ask') as Record<string, unknown>;
    expect(ask).toEqual({ kind: 'ask', value: undefined, tab: expect.any(String) });
    expect(heard.filter((m) => m.kind === 'answer')).toEqual([{ kind: 'answer', value: { items: ['milk'] }, tab: expect.any(String), to: ask.tab }]);
    // Alone, a held its write until the lock came, then the write was the state: it is not sent.
    expect(heard.filter((m) => m.kind === 'cmd')).toEqual([]);
    expect(a.cart.state.value).toEqual({ items: ['milk'] });
  });
});

/*
 * A tab opened after another wrote started from its own first state, so its
 * first write built on the wrong state (log s35.164). It asks when it opens,
 * `{ kind: 'ask', tab }`, and the tab holding the store's Web Lock answers it
 * alone (`to`) with its state (log 36.F39). Until then the asker holds its own
 * writes, and over the answer it runs them again and sends them. A tab alone
 * holds its writes until the lock comes, and then they are the state. Peers in
 * step only answer, so they are not written again.
 */
