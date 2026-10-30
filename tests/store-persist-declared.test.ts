/**
 * A state another command's reply declares is saved by the store's own persist: there is no scope to name it in.
 * Why: a reply declares a store's state as a step of the command that got it, so a persist scoped to the store's own actions would miss the write and a reload would show the old state.
 * Shows: after a `checkout` reply declares the cart under `stores`, the cart state holds it and the storage holds the same JSON.
 */
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
