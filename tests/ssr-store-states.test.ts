/**
 * SSR by the stores' states: storeStates reads the stores a request wrote, seedStores gives them to the client's stores, no replay.
 * Why: a client that replayed server commands would end on a different state (a minted id, a clock), and a store the server never wrote would overwrite the client's saved state on every load.
 * Shows: the page holds each written store by id and one request's page is its own; a store created before or after the seed starts from the server state, which wins over a persisted one; an unwritten store is left out of the page.
 * See: log s36.64, s36.65, docs/store.md
 */
import { describe, expect, it } from 'vitest';
import { _pushed } from '../src/applied-remotely';
import { createAsyncCommandBus, createCommandBus, inspectBus } from '../src/command-bus';
import { seedStores, serializeForScript, storeStates } from '../src/ssr';
import { defineChamberStore } from '../src/store/core';
import { saveTo } from '../src/store-persist';

type Cart = { items: Array<{ id: string; name: string }> };
const useCart = defineChamberStore('cart', {
  state: (): Cart => ({ items: [] }),
  // Mints an id: a replay on the client would mint another.
  reducers: { add: (s: Cart, name: string) => ({ items: [...s.items, { id: Math.random().toString(36).slice(2), name }] }) },
});
const useUser = defineChamberStore('user', { state: () => ({ name: '' }), reducers: { named: (_s: { name: string }, name: string) => ({ name }) } });

/** A server render: one bus per request, its stores written, their states read for the page. */
function render(names: string[]): string {
  const bus = createCommandBus();
  const cart = useCart(bus);
  const user = useUser(bus);
  for (const n of names) cart.add(n);
  user.named('ada');
  const page = serializeForScript(storeStates(bus));
  cart.$dispose();
  user.$dispose();
  return page;
}

describe('SSR by the stores states', () => {
  it('the server reads every store on the request bus, by id', () => {
    const states = JSON.parse(render(['tea'])) as Record<string, unknown>;
    expect(Object.keys(states).sort()).toEqual(['cart', 'user']);
    expect(states.user).toEqual({ name: 'ada' });
  });

  it('two requests, two buses: each page holds its own states', () => {
    expect((JSON.parse(render(['a'])) as { cart: Cart }).cart.items.map((i) => i.name)).toEqual(['a']);
    expect((JSON.parse(render(['b', 'c'])) as { cart: Cart }).cart.items.map((i) => i.name)).toEqual(['b', 'c']);
  });

  it('a store created after the seed starts from the server state, the minted id included', () => {
    const states = JSON.parse(render(['tea'])) as { cart: Cart };
    const bus = createCommandBus();
    seedStores(bus, states);
    const cart = useCart(bus);
    expect(cart.state.value).toEqual(states.cart);
    cart.$dispose();
  });

  it('a store created before the seed takes the server state through its own write, with its field event', () => {
    const states = JSON.parse(render(['tea'])) as { cart: Cart };
    const bus = createCommandBus();
    const cart = useCart(bus);
    const seen: unknown[] = [];
    cart.$onField('items', (v) => { seen.push(v); });
    seedStores(bus, states);
    expect(cart.state.value).toEqual(states.cart);
    expect(seen).toEqual([states.cart.items]);
    cart.$dispose();
  });

  it("the server state wins over persist's saved one, and persist then saves it", async () => {
    const states = JSON.parse(render(['tea'])) as { cart: Cart };
    let saved: string | null = JSON.stringify({ items: [{ id: 'old', name: 'stale' }] });
    const storage = { getItem: () => saved, setItem: (_k: string, v: string) => { saved = v; } };
    const usePersisted = defineChamberStore('cart', { state: (): Cart => ({ items: [] }), reducers: {}, persist: saveTo<Cart>({ key: 'cart', storage }) });
    const bus = createCommandBus();
    seedStores(bus, states);
    const cart = usePersisted(bus);
    expect(cart.state.value).toEqual(states.cart);
    await Promise.resolve();
    expect(JSON.parse(saved as string)).toEqual(states.cart);
    cart.$dispose();
  });

  it('a push for a seeded id with no store yet is the state the store starts from', () => {
    const bus = createAsyncCommandBus({ retry: false });
    seedStores(bus, { user: { name: 'ada' } });
    _pushed(bus, 'userRenamed', { stores: { user: { name: 'grace' } } });
    const user = useUser(bus);
    expect(user.state.value).toEqual({ name: 'grace' });
    user.$dispose();
  });

  it("a store the server never wrote is not in the page: the client's saved state stands", () => {
    const server = createCommandBus();
    const prefsOnServer = defineChamberStore('prefs', { state: () => ({ theme: 'light' }), reducers: {} })(server);
    const cartOnServer = useCart(server);
    cartOnServer.add('tea');
    const states = JSON.parse(serializeForScript(storeStates(server))) as Record<string, unknown>;
    expect(Object.keys(states)).toEqual(['cart']);

    let saved: string | null = JSON.stringify({ theme: 'dark' });
    const storage = { getItem: () => saved, setItem: (_k: string, v: string) => { saved = v; } };
    const client = createCommandBus();
    seedStores(client, states);
    const prefs = defineChamberStore('prefs', { state: () => ({ theme: 'light' }), reducers: {}, persist: saveTo({ key: 'prefs', storage }) })(client);
    const cart = useCart(client);
    expect(prefs.state.value).toEqual({ theme: 'dark' });
    expect(cart.state.value).toEqual(states.cart);
    for (const s of [prefsOnServer, cartOnServer, prefs, cart]) s.$dispose();
  });

  it('a bus that never had a store reads as no states', () => {
    expect(storeStates(createCommandBus())).toEqual({});
  });

  it('a push that is not an object leaves the seeded state as it was', () => {
    const bus = createAsyncCommandBus({ retry: false });
    seedStores(bus, { user: { name: 'ada' } });
    _pushed(bus, 'userRenamed', { stores: { user: null } });
    const user = useUser(bus);
    expect(user.state.value).toEqual({ name: 'ada' });
    user.$dispose();
  });

  it('control: a seed registers nothing on the bus, and storeStates skips an id with no store', () => {
    const bus = createCommandBus();
    seedStores(bus, { ghost: { a: 1 } });
    expect(inspectBus(bus).actions).toEqual([]);
    expect(storeStates(bus)).toEqual({});
  });
});
