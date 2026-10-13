/** A persist scoped by `actions` saves after those actions only, so a state another command's reply declares needs that command in scope. Rationale at the end. */
import { describe, expect, it, vi } from 'vitest';
import { createAsyncCommandBus } from '../src/command-bus';
import { persist } from '../src/plugins-io';
import { defineChamberStore } from '../src/store';
import { createHttpBridge } from '../src/transports';

type Cart = { items: number[] };

/** `checkout` goes to the server, whose reply declares the cart. */
const reply = { state: { order: 7 }, stores: { cart: { items: [9] } } };
const client = () => ({ post: vi.fn(async () => ({ ok: true, status: 200, data: reply, headers: {} })) });
const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); }, saved: () => m.get('vc:cart') ?? null };
};

async function checkoutWith(actions: string[] | undefined) {
  const storage = memory();
  const bus = createAsyncCommandBus({ retry: false });
  const cart = defineChamberStore('cart', { state: (): Cart => ({ items: [] }), reducers: { add: (s: Cart, id: number) => ({ items: [...s.items, id] }) } })(bus);
  bus.use(persist({ key: 'vc:cart', getState: () => cart.state.value, storage, actions }));
  bus.use(createHttpBridge({ endpoint: '/vc', httpClient: client() as never, actions: ['checkout'] }));
  await bus.dispatch('checkout', { id: 1 });
  const out = { state: cart.state.value, saved: storage.saved() };
  cart.$dispose();
  return out;
}

describe('a state another command declares, and a persist', () => {
  it('unscoped: saved', async () => {
    expect(await checkoutWith(undefined)).toEqual({ state: { items: [9] }, saved: '{"items":[9]}' });
  });

  it("scoped to the store's own actions: the state changes, nothing is saved", async () => {
    expect(await checkoutWith(['cart*'])).toEqual({ state: { items: [9] }, saved: null });
  });

  it('scoped with the replying command too: saved', async () => {
    expect(await checkoutWith(['cart*', 'checkout'])).toEqual({ state: { items: [9] }, saved: '{"items":[9]}' });
  });
});

/*
 * A reply declares a store's state under `stores`; the store writes it as a
 * step of the command that got the reply (here `checkout`), inside the
 * dispatch. docs/store.md said "so `persist` saves it", which holds for an
 * unscoped persist only: a persist scoped by `actions` runs for those actions,
 * and `checkout` is not one of the cart's, so the cart changed and a reload
 * showed the old one. The docs now say to name the replying command in the
 * scope or leave persist unscoped; the three cases are pinned here.
 */
