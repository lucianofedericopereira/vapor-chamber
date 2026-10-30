/**
 * A store across tabs carries commands, and an undo in any tab undoes the command in every tab.
 * Why: sending whole states with a per-tab count would drop one of two simultaneous writes and leave Undo in one tab unable to take back another tab's write; a state message also grows with the state where a command does not.
 * Shows: tabs end on one state after adds, undo, redo, simultaneous writes, a late-opening tab, a tab alone, a server state and a bfcache return; the receiving tab records the command in history with no dispatch; the wire carries only ask, lead and cmd messages (bye on leaving); an action the other tab lacks, and a history scoped away from it, are ignored.
 * See: log s36.F30, s36.F39.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope } from 'vue';
import { createAsyncCommandBus, createCommandBus, type Command } from '../src/command-bus';
import { useCommandHistory } from '../src/chamber';
import { httpTransport } from '../src/transports';
import { defineChamberStore } from '../src/store/core';
import { shareTabs } from '../src/store-share';
import { listen, quiet, traffic } from './tabs-quiet';
import { history } from '../src/plugins-core';

type Cart = { qty: Record<string, number> };
const reducers = {
  add: (s: Cart, name: string) => ({ qty: { ...s.qty, [name]: (s.qty[name] ?? 0) + 1 } }),
};

const closers: Array<() => void> = [];
/** The page's `pagehide` and `pageshow` handlers, by tab, so a test can close a tab. */
let pageHandlers: Array<{ type: string; fn: (e: { persisted?: boolean }) => void }> = [];
beforeEach(() => {
  pageHandlers = [];
  vi.stubGlobal('window', {});
  vi.stubGlobal('addEventListener', (type: string, fn: (e: { persisted?: boolean }) => void) => { pageHandlers.push({ type, fn }); });
  vi.stubGlobal('removeEventListener', () => {});
});
afterEach(() => { while (closers.length) closers.pop()!(); vi.unstubAllGlobals(); });

let n = 0;
/** One tab: its own bus, store and history, on the channel `name`. */
function tab(name: string, opts: { undo?: boolean } = {}) {
  const bus = createCommandBus();
  const sent: Command[] = [];
  bus.on('cart*', (cmd) => { sent.push(cmd); });
  const h = history({ bus });
  const handlersBefore = pageHandlers.length;
  const cart = defineChamberStore('cart', {
    state: (): Cart => ({ qty: { tea: 1 } }),
    reducers,
    undo: opts.undo ?? true,
    share: shareTabs(name),
  })(bus);
  const page = pageHandlers.slice(handlersBefore);
  closers.push(() => { cart.$dispose(); h.dispose(); });
  const fire = (type: string, persisted: boolean): void => {
    for (const p of page) if (p.type === type) p.fn({ persisted });
  };
  return { bus, cart, h, sent, hide: () => fire('pagehide', false), show: (persisted: boolean) => fire('pageshow', persisted) };
}

/** Every message on the channel `name`, as a listener that is not a tab reads it. */
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
const TEA = { qty: { tea: 1 } };
const TEA_COFFEE = { qty: { tea: 1, coffee: 1 } };

describe('the owner story: tea, coffee, undo in any tab', () => {
  it('tab A adds coffee: both tabs show tea and coffee', async () => {
    const name = `prop-${n++}`;
    net.watch(name);
    const a = tab(name);
    const b = tab(name);
    await settle();
    a.cart.add('coffee');
    await settle();
    expect(a.cart.state.value).toEqual(TEA_COFFEE);
    expect(b.cart.state.value).toEqual(TEA_COFFEE);
  });

  it("undo in tab B names A's coffee and both tabs show tea", async () => {
    const name = `prop-${n++}`;
    net.watch(name);
    const a = tab(name);
    const b = tab(name);
    await settle();
    a.cart.add('coffee');
    await settle();
    const undone = b.h.undo();
    expect(undone?.action).toBe('cartAdd');
    expect(undone?.meta?.id).toBe(a.sent[0]!.meta!.id);
    await settle();
    expect(b.cart.state.value).toEqual(TEA);
    expect(a.cart.state.value).toEqual(TEA);
    expect(a.h.getState().past).toEqual([]);
    expect(a.h.getState().future.map((c) => c.meta?.id)).toEqual([a.sent[0]!.meta!.id]);
  });

  it('B adds sugar, undo in A names sugar, both tabs show tea', async () => {
    const name = `prop-${n++}`;
    net.watch(name);
    const a = tab(name);
    const b = tab(name);
    await settle();
    a.cart.add('coffee');
    await settle();
    b.h.undo();
    await settle();
    b.cart.add('sugar');
    await settle();
    expect(a.cart.state.value).toEqual({ qty: { tea: 1, sugar: 1 } });
    const undone = a.h.undo();
    expect(undone?.meta?.id).toBe(b.sent.find((c) => c.action === 'cartAdd' && c.target === 'sugar')!.meta!.id);
    await settle();
    expect(a.cart.state.value).toEqual(TEA);
    expect(b.cart.state.value).toEqual(TEA);
  });

  it('redo in A after the undo in B: both show coffee, and B can undo it again', async () => {
    const name = `prop-${n++}`;
    net.watch(name);
    const a = tab(name);
    const b = tab(name);
    await settle();
    a.cart.add('coffee');
    await settle();
    b.h.undo();
    await settle();
    a.h.redo();
    await settle();
    expect(a.cart.state.value).toEqual(TEA_COFFEE);
    expect(b.cart.state.value).toEqual(TEA_COFFEE);
    expect(b.h.getState().past.map((c) => c.meta?.id)).toEqual([a.sent[0]!.meta!.id]);
    b.h.undo();
    await settle();
    expect(a.cart.state.value).toEqual(TEA);
    expect(b.cart.state.value).toEqual(TEA);
  });

  it('two tabs adding before they hear each other end on the same cart', async () => {
    const name = `prop-${n++}`;
    net.watch(name);
    const a = tab(name);
    const b = tab(name);
    await settle();
    a.cart.add('coffee');
    b.cart.add('sugar');
    await settle();
    expect(a.cart.state.value).toEqual({ qty: { tea: 1, coffee: 1, sugar: 1 } });
    expect(b.cart.state.value).toEqual({ qty: { tea: 1, coffee: 1, sugar: 1 } });
    // Each press names the command it reverses, in both tabs.
    const undone = a.h.undo();
    await settle();
    const without = undone?.target === 'sugar' ? TEA_COFFEE : { qty: { tea: 1, sugar: 1 } };
    expect(a.cart.state.value).toEqual(without);
    expect(b.cart.state.value).toEqual(without);
  });

  it("the receiving tab's history records the command with no dispatch: no listener or plugin sees it", async () => {
    const name = `prop-${n++}`;
    net.watch(name);
    const a = tab(name);
    const b = tab(name);
    const ran: string[] = [];
    b.bus.use({ started: (cmd) => { ran.push(cmd.action); } });
    await settle();
    a.cart.add('coffee');
    await settle();
    expect(b.sent).toEqual([]);
    expect(ran).toEqual([]);
    expect(b.h.getState().past.map((c) => c.meta?.id)).toEqual([a.sent[0]!.meta!.id]);
  });

  it('a store without undo carries the command too', async () => {
    const name = `prop-${n++}`;
    net.watch(name);
    const a = tab(name, { undo: false });
    const b = tab(name, { undo: false });
    await settle();
    a.cart.add('coffee');
    b.cart.add('sugar');
    await settle();
    expect(a.cart.state.value).toEqual({ qty: { tea: 1, coffee: 1, sugar: 1 } });
    expect(b.cart.state.value).toEqual({ qty: { tea: 1, coffee: 1, sugar: 1 } });
  });
});

describe('a tab that opens', () => {
  it('takes the state of an open tab', async () => {
    const name = `prop-${n++}`;
    net.watch(name);
    const a = tab(name);
    a.cart.add('coffee');
    const b = tab(name);
    await settle();
    expect(b.cart.state.value).toEqual(TEA_COFFEE);
  });

  it('keeps a write it made before the answer, and the other tab gets it', async () => {
    const name = `prop-${n++}`;
    net.watch(name);
    const a = tab(name);
    a.cart.add('coffee');
    const b = tab(name);
    b.cart.add('sugar');
    await settle();
    expect(b.cart.state.value).toEqual({ qty: { tea: 1, coffee: 1, sugar: 1 } });
    expect(a.cart.state.value).toEqual({ qty: { tea: 1, coffee: 1, sugar: 1 } });
  });

  it('beside a tab that wrote alone, with an undo and a $reset, ends on the same state', async () => {
    const name = `prop-${n++}`;
    net.watch(name);
    const a = tab(name);
    a.cart.add('coffee');
    a.cart.add('sugar');
    a.h.undo();
    a.cart.$reset();
    a.cart.add('coffee');
    a.cart.add('milk');
    const want = { qty: { tea: 1, coffee: 1, milk: 1 } };
    expect(a.cart.state.value).toEqual(want);
    const b = tab(name);
    await settle();
    expect(b.cart.state.value).toEqual(want);
    expect(a.cart.state.value).toEqual(want);
  });

  it("beside a tab that took a server's state alone, ends on the same state", async () => {
    const name = `prop-${n++}`;
    net.watch(name);
    const post = vi.fn(async () => ({ ok: true, status: 200, data: { state: 1, stores: { cart: { qty: { tea: 1, server: 1 } } } }, headers: {} }));
    const abus = createAsyncCommandBus({ retry: false, transport: { checkout: httpTransport({ endpoint: '/vc', httpClient: { post } as never }) } });
    const a = defineChamberStore('cart', { state: (): Cart => ({ qty: { tea: 1 } }), reducers, undo: true, share: shareTabs(name) })(abus);
    closers.push(() => a.$dispose());
    await abus.dispatch('checkout', null);
    await a.add('coffee');
    const want = { qty: { tea: 1, server: 1, coffee: 1 } };
    expect(a.state.value).toEqual(want);
    const b = tab(name);
    await settle();
    expect(b.cart.state.value).toEqual(want);
    expect(a.state.value).toEqual(want);
  });
});

describe('the wire', () => {
  it('a tab alone sends nothing but its ask and, granted the lock, its lead', async () => {
    const name = `prop-${n++}`;
    net.watch(name);
    const heard = wire(name);
    const a = tab(name);
    await settle();
    a.cart.add('coffee');
    a.cart.add('sugar');
    await settle();
    expect(heard.map((m) => m.kind)).toEqual(['ask', 'lead']);
  });

  it('with another tab open, a write goes out as its command, not its state', async () => {
    const name = `prop-${n++}`;
    net.watch(name);
    const heard = wire(name);
    const a = tab(name);
    tab(name);
    await settle();
    a.cart.add('coffee');
    await settle();
    const cmds = heard.filter((m) => m.kind === 'cmd');
    expect(cmds).toHaveLength(1);
    expect(cmds[0]!.value).toEqual({ action: 'cartAdd', target: 'coffee', payload: undefined, id: a.sent[0]!.meta!.id, causationId: undefined, ts: a.sent[0]!.meta!.ts });
    expect(Object.keys(cmds[0]!).sort()).toEqual(['kind', 'tab', 'value']);
  });

  it('a tab that leaves (pagehide) says so, and a tab left alone stops sending', async () => {
    const name = `prop-${n++}`;
    net.watch(name);
    const heard = wire(name);
    const a = tab(name);
    const b = tab(name);
    await settle();
    b.hide();
    await settle();
    const before = heard.length;
    a.cart.add('coffee');
    await settle();
    expect(heard.some((m) => m.kind === 'bye')).toBe(true);
    expect(heard.length).toBe(before);
  });
});

describe('three tabs, and a tab that opens while others write', () => {
  it('a tab that opens beside two takes one answer: an answer to another tab, or a second one, changes nothing', async () => {
    const name = `prop-${n++}`;
    net.watch(name);
    const a = tab(name);
    const b = tab(name);
    await settle();
    a.cart.add('coffee');
    await settle();
    const c = tab(name);
    await settle();
    expect(c.cart.state.value).toEqual(TEA_COFFEE);
    c.cart.add('sugar');
    await settle();
    for (const t of [a, b, c]) expect(t.cart.state.value).toEqual({ qty: { tea: 1, coffee: 1, sugar: 1 } });
  });

  for (const by of ['a', 'b'] as const) {
    it(`an undo made in tab ${by} while a tab asks reaches it, by the state when it does not hold the command`, async () => {
      const name = `prop-${n++}`;
      net.watch(name);
      const a = tab(name);
      const b = tab(name);
      await settle();
      a.cart.add('coffee');
      await settle();
      const c = tab(name);
      (by === 'a' ? a : b).h.undo();
      await settle();
      for (const t of [a, b, c]) expect(t.cart.state.value).toEqual(TEA);
    });
  }

  for (const undo of [true, false]) {
    it(`a tab that adds and undoes before its answer sends both (undo ${undo})`, async () => {
      const name = `prop-${n++}`;
      net.watch(name);
      const a = tab(name, { undo });
      a.cart.add('coffee');
      const b = tab(name, { undo });
      b.cart.add('sugar');
      if (undo) b.h.undo();
      await settle();
      const want = undo ? TEA_COFFEE : { qty: { tea: 1, coffee: 1, sugar: 1 } };
      expect(a.cart.state.value).toEqual(want);
      expect(b.cart.state.value).toEqual(want);
    });
  }

  it('a tab alone holds 256 writes, then stops holding; a tab that opens later takes them all', async () => {
    const name = `prop-${n++}`;
    net.watch(name);
    const heard = wire(name);
    const a = tab(name, { undo: false });
    for (let i = 0; i < 300; i++) a.cart.add('tea');
    await settle();
    expect(heard.map((m) => m.kind)).toEqual(['ask', 'lead']);
    const b = tab(name, { undo: false });
    await settle();
    expect(b.cart.state.value).toEqual({ qty: { tea: 301 } });
    expect(heard.filter((m) => m.kind === 'cmd')).toEqual([]);
  });
});

describe('what else crosses', () => {
  it("a server's state in one tab reaches the others, and turns their Undo off when it moves their state", async () => {
    const name = `prop-${n++}`;
    net.watch(name);
    const post = vi.fn(async () => ({ ok: true, status: 200, data: { state: 1, stores: { cart: { qty: { tea: 1, server: 1 } } } }, headers: {} }));
    const abus = createAsyncCommandBus({ retry: false, transport: { checkout: httpTransport({ endpoint: '/vc', httpClient: { post } as never }) } });
    const a = defineChamberStore('cart', { state: (): Cart => ({ qty: { tea: 1 } }), reducers, undo: true, share: shareTabs(name) })(abus);
    closers.push(() => a.$dispose());
    const b = tab(name);
    const scope = effectScope();
    const h = scope.run(() => useCommandHistory({ bus: b.bus }))!;
    closers.push(() => scope.stop());
    const wire = listen(name);
    closers.push(wire.close);
    await quiet(wire.heard);
    b.cart.add('sugar');
    expect(h.canUndo.value).toBe(true);
    // The sugar must reach every tab before the checkout, or the lead may run it over the server state and Undo stays on.
    await quiet(wire.heard);
    await abus.dispatch('checkout', null);
    await quiet(wire.heard);
    expect(b.cart.state.value).toEqual({ qty: { tea: 1, server: 1 } });
    expect(h.canUndo.value).toBe(false);
  });

  it('an action the other tab does not define is ignored there', async () => {
    const name = `prop-${n++}`;
    net.watch(name);
    const make = (extra: boolean) => defineChamberStore('cart', {
      state: (): Cart => ({ qty: { tea: 1 } }),
      reducers: extra ? { ...reducers, clear: () => ({ qty: {} }) } : reducers,
      share: shareTabs(name),
    })(createCommandBus());
    const a = make(true) as ReturnType<typeof make> & { clear: () => unknown };
    const b = make(false);
    closers.push(() => a.$dispose(), () => b.$dispose());
    await settle();
    a.clear();
    await settle();
    expect(b.state.value).toEqual(TEA);
  });

  it('a history scoped away from the action does not record another tab\'s command', async () => {
    const name = `prop-${n++}`;
    net.watch(name);
    const a = tab(name);
    const b = tab(name);
    const scoped = history({ bus: b.bus, actions: ['cart$reset'] });
    closers.push(() => scoped.dispose());
    await settle();
    b.cart.$reset();
    // The reset reaches every tab first, so the add is a command b hears, not one that meets b's reset.
    await settle();
    a.cart.add('coffee');
    await settle();
    expect(scoped.getState().past.map((c) => c.action)).toEqual(['cart$reset']);
  });
});

describe('the page', () => {
  it('a tab back from the back-forward cache (pageshow, persisted) asks again and is in step', async () => {
    const name = `prop-${n++}`;
    net.watch(name);
    const a = tab(name);
    const b = tab(name);
    await settle();
    b.hide();
    await settle();
    a.cart.add('coffee');
    b.show(true);
    b.show(false);
    await settle();
    expect(b.cart.state.value).toEqual(TEA_COFFEE);
    a.cart.add('sugar');
    await settle();
    expect(b.cart.state.value).toEqual({ qty: { tea: 1, coffee: 1, sugar: 1 } });
  });

  it('a page with no addEventListener still propagates', async () => {
    vi.stubGlobal('addEventListener', undefined);
    const name = `prop-${n++}`;
    net.watch(name);
    const a = tab(name);
    const b = tab(name);
    await settle();
    a.cart.add('coffee');
    await settle();
    expect(b.cart.state.value).toEqual(TEA_COFFEE);
  });
});

describe('edges', () => {
  it('a tab alone undoes locally and sends nothing but its ask and its lead', async () => {
    const name = `prop-${n++}`;
    net.watch(name);
    const heard = wire(name);
    const a = tab(name);
    await settle();
    a.cart.add('coffee');
    a.h.undo();
    await settle();
    expect(a.cart.state.value).toEqual(TEA);
    expect(heard.map((m) => m.kind)).toEqual(['ask', 'lead']);
  });

  it('once the other tab left, an undo stays in its tab', async () => {
    const name = `prop-${n++}`;
    net.watch(name);
    const heard = wire(name);
    const a = tab(name);
    const b = tab(name);
    await settle();
    a.cart.add('coffee');
    b.hide();
    await settle();
    const sent = heard.length;
    a.h.undo();
    await settle();
    expect(a.cart.state.value).toEqual(TEA);
    expect(heard.length).toBe(sent);
  });

  it("a tab still asking keeps waiting when a tab that spoke leaves, and does not answer a newer tab's ask", async () => {
    const name = `prop-${n++}`;
    net.watch(name);
    const a = tab(name);
    const b = tab(name);
    await settle();
    const c = tab(name);
    a.cart.add('coffee');
    a.hide();
    const d = tab(name);
    await settle();
    await settle();
    for (const t of [b, c, d]) expect(t.cart.state.value).toEqual(TEA_COFFEE);
    b.cart.add('sugar');
    await settle();
    for (const t of [c, d]) expect(t.cart.state.value).toEqual({ qty: { tea: 1, coffee: 1, sugar: 1 } });
  });

  it("a history scoped away records nothing of another tab's command, with nothing of its own yet", async () => {
    const name = `prop-${n++}`;
    net.watch(name);
    const a = tab(name);
    const b = tab(name);
    const scoped = history({ bus: b.bus, actions: ['other'] });
    closers.push(() => scoped.dispose());
    await settle();
    a.cart.add('coffee');
    await settle();
    expect(scoped.getState().past).toEqual([]);
  });
});
