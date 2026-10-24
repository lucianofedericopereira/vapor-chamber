/** A state another command's reply declares is saved by the store's own persist: there is no scope to name it in. Rationale at the end. */
import { describe, expect, it, vi } from 'vitest';
import { createAsyncCommandBus } from '../src/command-bus';
import { defineChamberStore } from '../src/store';
import { httpTransport } from '../src/transports';
import { saveTo } from '../src/store-persist';

type Cart = { items: number[] };

/** `checkout` goes to the server, whose reply declares the cart. */
const reply = { state: { order: 7 }, stores: { cart: { items: [9] } } };
const client = () => ({ post: vi.fn(async () => ({ ok: true, status: 200, data: reply, headers: {} })) });
const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, saved: () => m.get('vc:cart') ?? null };
};

async function checkout() {
  const storage = memory();
  const bus = createAsyncCommandBus({ retry: false, transport: { checkout: httpTransport({ endpoint: '/vc', httpClient: client() as never }) } });
  const cart = defineChamberStore('cart', { state: (): Cart => ({ items: [] }), reducers: { add: (s: Cart, id: number) => ({ items: [...s.items, id] }) }, persist: saveTo({ key: 'vc:cart', storage }) })(bus);
  await bus.dispatch('checkout', { id: 1 });
  await Promise.resolve();
  const out = { state: cart.state.value, saved: storage.saved() };
  cart.$dispose();
  return out;
}

describe("a state another command declares, and the store's persist", () => {
  it('saved: the store saves every write, a declared one included', async () => {
    expect(await checkout()).toEqual({ state: { items: [9] }, saved: '{"items":[9]}' });
  });
});

/*
 * A reply declares a store's state under `stores`; the store writes it as a
 * step of the command that got the reply (here `checkout`), inside the
 * dispatch. The `persist()` plugin saved by the commands it ran for, so one
 * scoped to the cart's own actions missed this write and a reload showed the
 * old cart (bug B1, docs only until 1.32). The store's own `persist` saves
 * after every write of the store, whatever wrote it: there is no scope to miss.
 */
