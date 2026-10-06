/** A server reply declares store states (`stores`, by store id): each named store takes its state, with no client option (plan 1.27 D3 rev 3). Rationale at the end. */
import { describe, expect, it, vi } from 'vitest';
import { createAsyncCommandBus } from '../src/command-bus';
import { history } from '../src/plugins-core';
import { persist } from '../src/plugins-io';
import { defineChamberStore } from '../src/store';
import { createBatchingHttpBridge, createHttpBridge } from '../src/transports';

type Cart = { rev: number; items: string[] };
type Stock = { left: number };
const useCart = defineChamberStore('cart', {
  state: (): Cart => ({ rev: 0, items: [] }),
  reducers: { add: (s: Cart, item: string) => ({ ...s, items: [...s.items, item] }) },
});
const useStock = defineChamberStore('stock', { state: (): Stock => ({ left: 10 }), reducers: { set: (_s: Stock, left: number) => ({ left }) } });

/** A client answering every command with `reply`. */
const client = (reply: object) => ({ post: vi.fn(async () => ({ ok: true, status: 200, data: reply, headers: {} })) }) as never;
const memoryStorage = () => {
  let stored: string | null = null;
  return { getItem: () => stored, setItem: (_k: string, v: string) => { stored = v; }, removeItem: () => { stored = null; }, read: () => stored };
};

describe('the server declares store states; the named stores take them', () => {
  it('a checkout reply updates the cart and the stock, with no client option', async () => {
    const bus = createAsyncCommandBus({ retry: false });
    bus.use(createHttpBridge({ endpoint: '/vc', httpClient: client({ state: { order: 7 }, stores: { cart: { rev: 3, items: [] }, stock: { left: 9 } } }) }));
    const cart = useCart(bus);
    const stock = useStock(bus);
    const r = await bus.dispatch('checkout', null);
    expect(r.value).toEqual({ order: 7 });
    expect(cart.state.value).toEqual({ rev: 3, items: [] });
    expect(stock.state.value).toEqual({ left: 9 });
    cart.$dispose();
    stock.$dispose();
  });

  it('a batched result carries its own stores', async () => {
    const post = vi.fn(async (_url: string, body: { commands: Array<{ id: string }> }) =>
      ({ ok: true, status: 200, data: { results: body.commands.map((c) => ({ id: c.id, state: 1, stores: { stock: { left: 4 } } })) }, headers: {} }));
    const bus = createAsyncCommandBus({ retry: false });
    bus.use(createBatchingHttpBridge({ endpoint: '/vc', httpClient: { post } as never }));
    const stock = useStock(bus);
    await bus.dispatch('checkout', null);
    expect(stock.state.value).toEqual({ left: 4 });
    stock.$dispose();
  });

  it('version orders a declared state: an older one never replaces a newer one, a newer one does', async () => {
    const replies = [{ stores: { cart: { rev: 1, items: ['old'] } } }, { stores: { cart: { rev: 3, items: ['newer'] } } }];
    const post = vi.fn(async () => ({ ok: true, status: 200, data: replies.shift(), headers: {} }));
    const bus = createAsyncCommandBus({ retry: false });
    bus.use(createHttpBridge({ endpoint: '/vc', httpClient: { post } as never }));
    const cart = defineChamberStore('cart', { state: (): Cart => ({ rev: 2, items: ['new'] }), reducers: {}, version: (s) => s.rev })(bus);
    await bus.dispatch('checkout', null);
    expect(cart.state.value).toEqual({ rev: 2, items: ['new'] });
    await bus.dispatch('checkout', null);
    expect(cart.state.value).toEqual({ rev: 3, items: ['newer'] });
    cart.$dispose();
  });

  it("the server's declared state wins over the command's own answer", async () => {
    const bus = createAsyncCommandBus({ retry: false });
    bus.use(createHttpBridge({ endpoint: '/vc', httpClient: client({ state: { rev: 1, items: ['mapped'] }, stores: { cart: { rev: 1, items: ['declared'] } } }) }));
    const cart = defineChamberStore('cart', {
      state: (): Cart => ({ rev: 0, items: [] }),
      reducers: { add: (s: Cart, item: string) => ({ ...s, items: [...s.items, item] }) },
      answer: (_s, v) => v as Cart,
    })(bus);
    await cart.add('milk');
    expect(cart.state.value.items).toEqual(['declared']);
    cart.$dispose();
  });

  it('persist outside the bridge saves the declared state; history cannot undo it', async () => {
    const storage = memoryStorage();
    const bus = createAsyncCommandBus({ retry: false });
    const h = history({ bus });
    bus.use(h);
    const stock = useStock(bus);
    bus.use(persist({ key: 'vc:stock', storage, getState: () => stock.state.value }), { priority: 10 });
    bus.use(createHttpBridge({ endpoint: '/vc', httpClient: client({ stores: { stock: { left: 2 } } }) }));
    await bus.dispatch('checkout', null);
    expect(JSON.parse(storage.read() as string)).toEqual({ left: 2 });
    expect(h.getState().canUndo).toBe(false);
    stock.$dispose();
  });

  it('a declared state that is not an object is not written, and development warns once', async () => {
    const replies = [{ stores: { stock: null } }, { stores: { stock: 3 } }];
    const post = vi.fn(async () => ({ ok: true, status: 200, data: replies.shift(), headers: {} }));
    const bus = createAsyncCommandBus({ retry: false });
    bus.use(createHttpBridge({ endpoint: '/vc', httpClient: { post } as never }));
    const stock = useStock(bus);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await bus.dispatch('checkout', null);
    await bus.dispatch('checkout', null);
    expect(stock.state.value).toEqual({ left: 10 });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('not an object');
    stock.$dispose();
  });

  it('a takeover receives; the old store dispose leaves the new receiver in place', async () => {
    const bus = createAsyncCommandBus({ retry: false });
    bus.use(createHttpBridge({ endpoint: '/vc', httpClient: client({ stores: { stock: { left: 5 } } }) }));
    const old = useStock(bus);
    const taken = defineChamberStore('stock', { state: (): Stock => ({ left: 20 }), reducers: {} })(bus);
    old.$dispose();
    await bus.dispatch('checkout', null);
    expect(taken.state.value).toEqual({ left: 5 });
    expect(old.state.value).toEqual({ left: 10 });
    taken.$dispose();
  });
});

describe('controls', () => {
  it('a reply without stores changes no store', async () => {
    const bus = createAsyncCommandBus({ retry: false });
    bus.use(createHttpBridge({ endpoint: '/vc', httpClient: client({ state: { order: 7 } }) }));
    const stock = useStock(bus);
    await bus.dispatch('checkout', null);
    expect(stock.state.value).toEqual({ left: 10 });
    stock.$dispose();
  });

  it('a disposed store, or one on a cleared bus, takes no declared state', async () => {
    const bus = createAsyncCommandBus({ retry: false });
    bus.use(createHttpBridge({ endpoint: '/vc', httpClient: client({ stores: { stock: { left: 1 } } }) }));
    const disposed = useStock(bus);
    disposed.$dispose();
    await bus.dispatch('checkout', null);
    expect(disposed.state.value).toEqual({ left: 10 });
    const cleared = useStock(bus);
    bus.clear();
    bus.use(createHttpBridge({ endpoint: '/vc', httpClient: client({ stores: { stock: { left: 1 } } }) }));
    await bus.dispatch('checkout', null);
    expect(cleared.state.value).toEqual({ left: 10 });
  });

  it('an unknown store id and inherited names are ignored', async () => {
    const bus = createAsyncCommandBus({ retry: false });
    bus.use(createHttpBridge({ endpoint: '/vc', httpClient: client(JSON.parse('{"stores":{"nope":{"left":1},"__proto__":{"left":1},"constructor":{"left":1}}}')) }));
    const stock = useStock(bus);
    const r = await bus.dispatch('checkout', null);
    expect(r.ok).toBe(true);
    expect(stock.state.value).toEqual({ left: 10 });
    stock.$dispose();
  });
});

/*
 * Whether a reply's `state` is a store's state is known by the server, not
 * guessed by the client. Opt-in, opt-out and no option each leave one side
 * guessing (owner, 2026-10-06: "the most correct"). So the server declares it
 * per reply, `stores` keyed by store id, as Livewire returns component
 * snapshots and Turbo Streams name what to replace; the app maps a command's
 * own answer with `answer` (store-bridged-answer.test.ts). Neither: nothing
 * changes, as in 1.26. A declared state is written at the transport's level
 * as a step of the command that got the reply, after the command's own
 * answer, ordered by `version`. Store ids are external strings: own keys only
 * (src/dict.ts). Log s35.186.
 *
 * The first block holds every test that fails before the change, 7 (log
 * s35.202: the non-object warning and the takeover sat under "controls"
 * though they assert the new behaviour). The controls pass before and after.
 */
