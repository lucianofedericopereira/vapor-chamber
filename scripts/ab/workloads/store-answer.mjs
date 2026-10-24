// Workload for scripts/ab/ab.mjs (.probes/fixup-1-7-pickup.md item 1): a command answer that
// carries a store's state (`stores`), a normal path. Arm A writes it by a direct call of the
// store's entry, arm B as a fact on the bus's stores' lane. Rows: answer_stores, a sent
// success whose reply declares the cart's state; answer_plain, the same send with no
// `stores` (a control: the lane is not reached).
import { createAsyncCommandBus } from '__DIST__/index.js';
import { defineChamberStore } from '__DIST__/store.js';
import * as T from '__DIST__/transports.js';

const h = { 'content-type': 'application/json' };
const reply = (text) => ({ ok: true, status: 200, url: '', redirected: false, headers: { entries: () => Object.entries(h), get: (k) => h[k.toLowerCase()] ?? null }, text: async () => text });
const withStores = reply(JSON.stringify({ state: 1, stores: { cart: { rev: 1, items: [] } } }));
const plain = reply(JSON.stringify({ state: 1 }));
let answer = withStores;
globalThis.fetch = async () => answer;

const bus = createAsyncCommandBus({ retry: false, transport: { 'order*': T.httpTransport({ endpoint: '/vc' }) } });
const cart = defineChamberStore('cart', { state: () => ({ rev: 0, items: [] }), reducers: { set: (_s, next) => next } })(bus);

const seq = async (n, one) => { let s = 0; for (let i = 0; i < n; i++) s += await one(i); return s; };

export const ASYNC = true;
export const N = { answer_stores: 20_000, answer_plain: 20_000 };
export const answer_stores = (n) => { answer = withStores; return seq(n, (i) => bus.dispatch('orderSave', { i }).then((r) => (r.ok ? cart.state.value.rev : 0))); };
export const answer_plain = (n) => { answer = plain; return seq(n, (i) => bus.dispatch('orderSave', { i }).then((r) => (r.ok ? 1 : 0))); };

/** Self-check: the reply's state lands in the store, a plain reply leaves it. */
export const check = async () => {
  const a = await answer_stores(2);
  const b = await answer_plain(2);
  if (a !== 2 || b !== 2 || cart.state.value.rev !== 1) throw new Error(`stores ${a} plain ${b} rev ${cart.state.value.rev}, want 2 2 1`);
  return [a, b];
};
