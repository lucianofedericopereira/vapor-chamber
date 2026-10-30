/**
 * A store shared across tabs (`share: shareTabs()`): each write crosses as its command, the receiving tab runs the store's own handler with no dispatch, and every tab converges on one state.
 * Why: if a receiving tab dispatched what another tab already ran, every plugin, listener and reaction there would see a mirror of a write that ran elsewhere; a tab with another tab open must send its writes, and a tab with none must send nothing. The tab holding the store's Web Lock runs every tab's command and posts it on.
 * Shows: a write in one tab becomes every tab's state; the receiver's listeners and plugins see nothing while its history and persist record the write; commands go out as { kind, value, tab } on a channel named vc:store:<id> by default, without echo; an undo reaches the other tab; $dispose, a missing share option, a server, a missing BroadcastChannel and a state that cannot be cloned keep a write in its tab (warning in development only); a worker shares.
 * See: log s36.F30, log s36.F39, tests/store-propagate-undo.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCommandBus, type Command } from '../src/command-bus';
import { defineChamberStore } from '../src/store';
import { defineChamberStore as defineCore } from '../src/store/core';
import { saveTo } from '../src/store-persist';
import { shareTabs } from '../src/store-share';
import { traffic } from './tabs-quiet';
import { history } from '../src/plugins-core';

type Cart = { items: string[] };
const reducers = {
  add: (s: Cart, item: string) => ({ items: [...s.items, item] }),
};

const closers: Array<() => void> = [];
// A page: shareTabs opens only where there are tabs.
beforeEach(() => { vi.stubGlobal('window', {}); });
afterEach(() => { while (closers.length) closers.pop()!(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

let n = 0;
// One "tab": its own bus and store instance, sharing over the channel `name`; tests open two tabs first because a tab alone sends no write.
function tab(name: string, opts: { share?: boolean; undo?: boolean; storage?: { getItem(k: string): string | null; setItem(k: string, v: string): void } } = {}) {
  const bus = createCommandBus();
  const useCart = defineChamberStore('cart', {
    state: (): Cart => ({ items: [] }),
    reducers,
    undo: opts.undo,
    share: opts.share === false ? undefined : shareTabs(name),
    ...(opts.storage ? { persist: saveTo<Cart>({ key: 'cart', storage: opts.storage }) } : {}),
  });
  const cart = useCart(bus);
  closers.push(() => cart.$dispose());
  return { bus, cart };
}

// Every message on the channel `name`, as another tab reads it.
function wire(name: string): Array<Record<string, unknown>> {
  const heard: Array<Record<string, unknown>> = [];
  const ch = new BroadcastChannel(name);
  ch.onmessage = (e) => { heard.push(e.data); };
  closers.push(() => ch.close());
  return heard;
}

// `settle` waits until the channels this file's tabs use carry nothing (tests/tabs-quiet.ts).
const net = traffic();
afterEach(() => net.close());
const settle = (): Promise<void> => net.settle();

describe('a shared store', () => {
  it("a write in one tab becomes every tab's state", async () => {
    const name = `share-${n++}`;
    net.watch(name);
    const a = tab(name);
    const b = tab(name);
    a.cart.add('milk');
    await settle();
    expect(b.cart.state.value).toEqual({ items: ['milk'] });
    b.cart.add('bread');
    await settle();
    expect(a.cart.state.value).toEqual({ items: ['milk', 'bread'] });
  });

  it('the core store shares the same way', async () => {
    const name = `share-${n++}`;
    net.watch(name);
    const make = () => defineCore('cart', { state: (): Cart => ({ items: [] }), reducers, share: shareTabs(name) })(createCommandBus());
    const a = make();
    const b = make();
    closers.push(() => a.$dispose(), () => b.$dispose());
    a.add('milk');
    await settle();
    expect(b.state.value).toEqual({ items: ['milk'] });
  });

  it('two tabs writing at once end on the same state', async () => {
    const name = `share-${n++}`;
    net.watch(name);
    const a = tab(name);
    const b = tab(name);
    a.cart.add('from-a');
    b.cart.add('from-b');
    await settle();
    await settle();
    expect(a.cart.state.value).toEqual(b.cart.state.value);
  });

  it('the receiving tab applies it with no dispatch: no listener or plugin sees it, its history records it', async () => {
    const name = `share-${n++}`;
    net.watch(name);
    const a = tab(name);
    const b = tab(name);
    const h = history({ bus: b.bus });
    const ran: string[] = [];
    b.bus.use({ started: (cmd) => { ran.push(cmd.action); } });
    const heard: string[] = [];
    b.bus.on('*', (cmd) => heard.push(cmd.action));
    await settle(); // both tabs open: b records what a runs from then on
    a.cart.add('milk');
    await settle();
    expect(b.cart.state.value).toEqual({ items: ['milk'] });
    expect(heard).toEqual([]);
    expect(ran).toEqual([]);
    expect(h.getState().past.map((c) => [c.action, c.target])).toEqual([['cartAdd', 'milk']]);
  });

  it("the receiving tab's persist saves the state it received", async () => {
    const name = `share-${n++}`;
    net.watch(name);
    let saved: string | null = null;
    const storage = { getItem: () => saved, setItem: (_k: string, v: string) => { saved = v; } };
    const a = tab(name);
    tab(name, { storage });
    a.cart.add('milk');
    await settle();
    expect(saved).toBe(JSON.stringify({ items: ['milk'] }));
  });
});

describe('the wire', () => {
  it('with another tab open, each write goes out as { kind: cmd, value, tab }', async () => {
    const name = `share-${n++}`;
    net.watch(name);
    const heard = wire(name);
    const a = tab(name);
    tab(name);
    await settle();
    a.cart.add('milk');
    a.cart.add('eggs');
    await settle();
    const cmds = heard.filter((m) => m.kind === 'cmd');
    expect(cmds.map((m) => Object.keys(m).sort())).toEqual([['kind', 'tab', 'value'], ['kind', 'tab', 'value']]);
    expect(cmds.map((m) => (m.value as { target: string }).target)).toEqual(['milk', 'eggs']);
  });

  it('one channel per store, named vc:store:<id> unless a name is given', async () => {
    const id = `named${n++}`;
    const heard = wire(`vc:store:${id}`);
    const make = () => defineCore(id, { state: (): Cart => ({ items: [] }), reducers, share: shareTabs() })(createCommandBus());
    const s = make();
    const t = make();
    closers.push(() => s.$dispose(), () => t.$dispose());
    await settle();
    s.add('milk');
    await settle();
    expect(heard.filter((m) => m.kind === 'cmd').map((m) => (m.value as { target: string }).target)).toEqual(['milk']);
    expect(t.state.value).toEqual({ items: ['milk'] });
  });

  it('a received command is not sent back (no echo)', async () => {
    const name = `share-${n++}`;
    net.watch(name);
    const heard = wire(name);
    const a = tab(name);
    tab(name);
    await settle();
    a.cart.add('milk');
    await settle();
    const cmds = heard.filter((m) => m.kind === 'cmd');
    expect(cmds).toHaveLength(1);
  });

  it('an undo goes out as the id of the command it reverses, and the other tab undoes it', async () => {
    const name = `share-${n++}`;
    net.watch(name);
    const a = tab(name, { undo: true });
    const b = tab(name, { undo: true });
    const seen: Command[] = [];
    b.bus.use({ settled: (cmd: Command) => { if (cmd.action === 'cartAdd') seen.push(cmd); } });
    a.cart.add('milk');
    await settle();
    b.cart.add('x');
    await settle();
    expect(a.cart.state.value).toEqual({ items: ['milk', 'x'] });
    b.bus.dispatch('cartAdd$undo', seen[0]);
    await settle();
    expect(b.cart.state.value).toEqual({ items: ['milk'] });
    expect(a.cart.state.value).toEqual({ items: ['milk'] });
  });

  it('$dispose closes the channel; a store without share sends nothing', async () => {
    const name = `share-${n++}`;
    net.watch(name);
    const heard = wire(name);
    const a = tab(name);
    const b = tab(name);
    const c = tab(name, { share: false });
    a.cart.$dispose();
    a.cart.add('ignored');
    c.cart.add('local only');
    await settle();
    expect(b.cart.state.value).toEqual({ items: [] });
    expect(heard.filter((m) => m.kind === 'cmd')).toEqual([]);
  });

  it('a command the structured clone cannot copy stays in its tab, with a warning', async () => {
    const name = `share-${n++}`;
    net.watch(name);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const heard = wire(name);
    const make = () => defineCore('fns', { state: () => ({ f: null as null | (() => void) }), reducers: { set: (_s: { f: null | (() => void) }, f: () => void) => ({ f }) }, share: shareTabs(name) })(createCommandBus());
    const s = make();
    const t = make();
    closers.push(() => s.$dispose(), () => t.$dispose());
    await settle();
    s.set(() => {});
    await settle();
    expect(typeof s.state.value.f).toBe('function');
    expect(t.state.value.f).toBe(null);
    expect(heard.filter((m) => m.kind === 'cmd')).toEqual([]);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('Store "fns": a change did not cross to the other tabs'))).toBe(true);
  });

  it('a channel never hears its own post; another channel of the name does (the fact shareTabs rests on)', async () => {
    const name = `share-${n++}`;
    net.watch(name);
    const self: unknown[] = [];
    const other: unknown[] = [];
    const a = new BroadcastChannel(name);
    const b = new BroadcastChannel(name);
    closers.push(() => a.close(), () => b.close());
    a.onmessage = (e) => { self.push(e.data); };
    b.onmessage = (e) => { other.push(e.data); };
    a.postMessage('hello');
    await settle();
    expect(self).toEqual([]);
    expect(other).toEqual(['hello']);
  });

  it('in production a state that cannot cross stays in its tab with no warning', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.resetModules();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const share = await import('../src/store-share');
      const core = await import('../src/store/core');
      const bus = await import('../src/command-bus');
      const name = `share-${n++}`;
      net.watch(name);
      const make = () => core.defineChamberStore('fnsprod', { state: () => ({ f: null as null | (() => void) }), reducers: { set: (_s: { f: null | (() => void) }, f: () => void) => ({ f }) }, share: share.shareTabs(name) })(bus.createCommandBus());
      const s = make();
      const t = make();
      await settle();
      s.set(() => {});
      expect(typeof s.state.value.f).toBe('function');
      expect(warn).not.toHaveBeenCalled();
      s.$dispose();
      t.$dispose();
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it('without BroadcastChannel nothing opens and the store writes as usual', () => {
    vi.stubGlobal('BroadcastChannel', undefined);
    const s = defineCore('ssr', { state: (): Cart => ({ items: [] }), reducers, share: shareTabs() })(createCommandBus());
    s.add('milk');
    expect(s.state.value).toEqual({ items: ['milk'] });
    s.$dispose();
  });

  it("on a server two requests' stores of one id do not share", async () => {
    vi.unstubAllGlobals(); // no window: Node, with its own BroadcastChannel
    const name = `share-${n++}`;
    net.watch(name);
    const heard = wire(name);
    const a = tab(name);
    const b = tab(name);
    a.cart.add('milk');
    await settle();
    expect(b.cart.state.value).toEqual({ items: [] });
    expect(heard).toEqual([]);
  });

  it('a worker shares', async () => {
    vi.unstubAllGlobals();
    vi.stubGlobal('WorkerGlobalScope', class {});
    const name = `share-${n++}`;
    net.watch(name);
    const a = tab(name);
    const b = tab(name);
    a.cart.add('milk');
    await settle();
    expect(b.cart.state.value).toEqual({ items: ['milk'] });
  });
});
