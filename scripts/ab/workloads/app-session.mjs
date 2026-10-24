// Workload for scripts/ab/ab.mjs: an app session, the question "does an app run slower on 1.32
// than on 1.31" (.probes/machine.md, ORDERS for app-session). The shopping-cart example's app
// (examples/shopping-cart.ts at each release) on a bus as pattern 2 builds it, through the Vue entry.
// One seeded list of 50 operations, varied products and quantities, run in order and again:
// adds, updates, removes, local and sent queries, a sent save, a validation refusal, a failed
// checkout, an undo, and a clear that ends each pass. Half the cart calls go through the store's
// methods, half through useCommand(); queries through useCommandQuery(); after each operation
// the app reads the total through fieldRef(). Buses, stores and composables are built at import.
// Rows: app_async (async bus, the HTTP transport for `order*`, `product*` and `wish*` on a fetch
// that answers at once), app_sync (the same app on a sync bus, the sent actions local) and
// app_control (the same operations through the same reducers, no library code: reads 1.000).
// app_async_control is app_control as the async app awaits it: one await per operation, and for
// a sent one the fake fetch's own work (the call, the headers walk, `text()`, `JSON.parse`). The
// split rows run one app per list: app_async_local (the 41 local operations) and app_async_sent
// (the 9 sent ones), each with its control. No control runs library code.
// Each arm in its own API for the same intention:
// - transport: arm A (1.31) installs createHttpBridge plugins after the others, as
//   transport-mixed.mjs does; arm B declares httpTransport by pattern on the bus.
// - logger scope: arm A `filter`, arm B `actions`. history: arm A a plugin with `filter` that
//   the app installs, arm B `history({ bus, actions })`, which records on its own.
// The logger runs whole: the console methods it calls are no-ops, so the workload prints nothing.
import { effectScope } from 'vue';
import * as V from '__DIST__/vue.js';
import * as T from '__DIST__/transports.js';
import { defineChamberStore, fieldRef } from '__DIST__/store.js';

const quiet = () => {};
console.group = console.groupCollapsed = console.groupEnd = console.log = console.error = quiet;

const reply = (status, body) => {
  const text = JSON.stringify(body);
  const h = { 'content-type': status < 300 ? 'application/json' : 'application/problem+json' };
  return {
    ok: status >= 200 && status < 300, status, url: '', redirected: false,
    headers: { entries: () => Object.entries(h), get: (k) => h[k.toLowerCase()] ?? null },
    json: async () => JSON.parse(text), text: async () => text,
  };
};
const answers = {
  '/api/product': reply(200, { state: 1 }),
  '/api/wish': reply(200, { state: true }),
  '/api/checkout': reply(409, { status: 409, code: 'stale', detail: 'The cart changed meanwhile' }),
};
let sent = 0;
globalThis.fetch = async (url) => { sent++; return answers[url]; };

// The catalogue: twelve products, prices of several magnitudes, one with no price (refused).
const catalogue = [];
for (let id = 1; id <= 12; id++) catalogue.push({ id, name: `Product ${id}`, price: Math.round(((id * 37) % 101) * 100 + 99) / 100 });
const free = { id: 99, name: 'Sample', price: 0 };

const totalOf = (items) => items.reduce((sum, i) => sum + i.price * i.quantity, 0);
const withItems = (items) => ({ items, total: totalOf(items) });
const reducers = {
  add: (s, product, p) => {
    const quantity = p?.quantity ?? 1;
    const found = s.items.some((i) => i.id === product.id);
    return withItems(found
      ? s.items.map((i) => (i.id === product.id ? { ...i, quantity: i.quantity + quantity } : i))
      : [...s.items, { ...product, quantity }]);
  },
  remove: (s, product) => withItems(s.items.filter((i) => i.id !== product.id)),
  update: (s, product, p) => withItems(p.quantity === 0
    ? s.items.filter((i) => i.id !== product.id)
    : s.items.map((i) => (i.id === product.id ? { ...i, quantity: p.quantity } : i))),
  clear: () => withItems([]),
};

// The session: 50 operations from a seeded generator (mulberry32), the clear last.
let seed = 0x5eed;
const rand = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = (xs) => xs[Math.floor(rand() * xs.length)];
const kinds = [
  ...Array(18).fill('add'), ...Array(10).fill('update'), ...Array(5).fill('remove'),
  ...Array(5).fill('count'), ...Array(5).fill('product'), ...Array(3).fill('wish'),
  'refuse', 'checkout', 'undo',
];
for (let i = kinds.length - 1; i > 0; i--) {
  const j = Math.floor(rand() * (i + 1));
  [kinds[i], kinds[j]] = [kinds[j], kinds[i]];
}
// The undo follows a cart change of this pass, so it never reaches back past the last clear.
const firstChange = kinds.indexOf('add');
const undoAt = kinds.indexOf('undo');
if (undoAt < firstChange) [kinds[undoAt], kinds[firstChange]] = [kinds[firstChange], kinds[undoAt]];
const OPS = kinds.map((kind) => ({ kind, product: pick(catalogue), quantity: 1 + Math.floor(rand() * 5), viaComposable: rand() < 0.5 }));
OPS.push({ kind: 'clear', product: null, quantity: 0, viaComposable: false });
const LEN = OPS.length;
const SENT = new Set(['product', 'wish', 'checkout']);
const LOCAL_OPS = OPS.filter((op) => !SENT.has(op.kind));
const SENT_OPS = OPS.filter((op) => SENT.has(op.kind));
const URL_OF = { product: '/api/product', wish: '/api/wish', checkout: '/api/checkout' };

/** One app: its bus, plugins, store, listeners and composables. */
const app = (async) => {
  const wire = (endpoint, actions) => (T.httpTransport ? T.httpTransport({ endpoint }) : T.createHttpBridge({ endpoint, actions }));
  let bus;
  if (!async) bus = V.createCommandBus();
  else if (T.httpTransport) bus = V.createAsyncCommandBus({ transport: { 'order*': wire('/api/checkout'), 'product*': wire('/api/product'), 'wish*': wire('/api/wish') } });
  else bus = V.createAsyncCommandBus();
  bus.use(V.authGuard({ isAuthenticated: () => true, protected: ['order*', 'wish*'] }));
  bus.use(T.httpTransport ? V.logger({ actions: ['cart*'] }) : V.logger({ filter: (cmd) => cmd.action.startsWith('cart') }));
  bus.use(V.validator({
    cartAdd: (cmd) => (cmd.target?.price > 0 ? null : 'Invalid product'),
    cartUpdate: (cmd) => (cmd.payload?.quantity >= 0 ? null : 'Invalid quantity'),
  }));
  let cartHistory;
  if (T.httpTransport) cartHistory = V.history({ bus, actions: ['cart*'], maxSize: 50 });
  else {
    cartHistory = V.history({ bus, filter: (cmd) => cmd.action.startsWith('cart'), maxSize: 50 });
    bus.use(cartHistory);
  }
  if (async && !T.httpTransport) {
    bus.use(wire('/api/checkout', ['order*']));
    bus.use(wire('/api/product', ['product*']));
    bus.use(wire('/api/wish', ['wish*']));
  }
  const cart = defineChamberStore('cart', { state: () => withItems([]), reducers, undo: true })(bus);
  bus.register('countGet', () => cart.state.value.items.length);
  if (!async) {
    bus.register('productGet', () => 1);
    bus.register('wishSave', () => true);
    bus.register('orderCheckout', () => { throw new Error('The cart changed meanwhile'); });
  }
  const heard = { cart: 0, wish: 0 };
  bus.on('cart*', () => { heard.cart++; });
  bus.on('wish*', () => { heard.wish++; });
  const ui = effectScope().run(() => ({
    command: V.useCommand({ bus }),
    query: V.useCommandQuery({ bus }),
    errors: V.useCommandError({ bus }),
    total: fieldRef(cart, 'total'),
  }));
  return { bus, cart, cartHistory, heard, ui, pos: 0 };
};

/** One operation: 1 when it succeeds (the undo: when it undid a command), else 0. */
const ok = (r) => (r.ok ? 1 : 0);
const opSync = (a, op) => {
  const { cart, ui } = a;
  switch (op.kind) {
    case 'add': return ok(op.viaComposable ? ui.command.dispatch('cartAdd', op.product, { quantity: op.quantity }) : cart.add(op.product, { quantity: op.quantity }));
    case 'update': return ok(op.viaComposable ? ui.command.dispatch('cartUpdate', op.product, { quantity: op.quantity }) : cart.update(op.product, { quantity: op.quantity }));
    case 'remove': return ok(op.viaComposable ? ui.command.dispatch('cartRemove', op.product) : cart.remove(op.product));
    case 'count': return ok(ui.query.query('countGet', null));
    case 'product': return ok(ui.query.query('productGet', op.product));
    case 'wish': return ok(ui.command.dispatch('wishSave', op.product));
    case 'refuse': return ok(cart.add(free));
    case 'checkout': return ok(ui.command.dispatch('orderCheckout', { items: cart.state.value.items.length }));
    case 'undo': return a.cartHistory.undo() ? 1 : 0;
    default: return ok(cart.clear());
  }
};
const opAsync = async (a, op) => {
  const { cart, ui } = a;
  switch (op.kind) {
    case 'add': return ok(await (op.viaComposable ? ui.command.dispatch('cartAdd', op.product, { quantity: op.quantity }) : cart.add(op.product, { quantity: op.quantity })));
    case 'update': return ok(await (op.viaComposable ? ui.command.dispatch('cartUpdate', op.product, { quantity: op.quantity }) : cart.update(op.product, { quantity: op.quantity })));
    case 'remove': return ok(await (op.viaComposable ? ui.command.dispatch('cartRemove', op.product) : cart.remove(op.product)));
    case 'count': return ok(await ui.query.query('countGet', null));
    case 'product': return ok(await ui.query.query('productGet', op.product));
    case 'wish': return ok(await ui.command.dispatch('wishSave', op.product));
    case 'refuse': return ok(await cart.add(free));
    case 'checkout': return ok(await ui.command.dispatch('orderCheckout', { items: cart.state.value.items.length }));
    case 'undo': return a.cartHistory.undo() ? 1 : 0;
    default: return ok(await cart.clear());
  }
};

const syncApp = app(false);
const asyncApp = app(true);

const runSync = (a, n, kindsOut) => {
  let s = 0;
  for (let i = 0; i < n; i++) {
    const k = opSync(a, OPS[a.pos]);
    if (kindsOut) kindsOut.push(k);
    a.pos = a.pos + 1 === LEN ? 0 : a.pos + 1;
    s += k + a.ui.total.value;
  }
  return s;
};
const runAsync = async (a, n, kindsOut, ops = OPS) => {
  let s = 0;
  for (let i = 0; i < n; i++) {
    const k = await opAsync(a, ops[a.pos]);
    if (kindsOut) kindsOut.push(k);
    a.pos = a.pos + 1 === ops.length ? 0 : a.pos + 1;
    s += k + a.ui.total.value;
  }
  return s;
};
const localApp = app(true);
const sentApp = app(true);

// The control: the same operations through the same reducers and total, with no bus, store or
// composable. No library code runs, so both arms run the same code and it reads 1.000.
const plain = { state: withItems([]), past: [], pos: 0 };
const opPlain = (c, op) => {
  const s = c.state;
  let next;
  switch (op.kind) {
    case 'add': next = reducers.add(s, op.product, { quantity: op.quantity }); break;
    case 'update': next = reducers.update(s, op.product, { quantity: op.quantity }); break;
    case 'remove': next = reducers.remove(s, op.product); break;
    case 'count': return s.items.length >= 0 ? 1 : 0;
    case 'product': return op.product.price > 0 ? 1 : 0;
    case 'wish': return op.product.id > 0 ? 1 : 0;
    case 'refuse': return free.price > 0 ? 1 : 0;
    case 'checkout': return 0;
    case 'undo': {
      const prev = c.past.pop();
      if (prev === undefined) return 0;
      c.state = prev;
      return 1;
    }
    default: next = reducers.clear();
  }
  c.past.push(s);
  if (c.past.length > 50) c.past.shift();
  c.state = next;
  return 1;
};
const runPlain = (c, n, kindsOut) => {
  let s = 0;
  for (let i = 0; i < n; i++) {
    const k = opPlain(c, OPS[c.pos]);
    if (kindsOut) kindsOut.push(k);
    c.pos = c.pos + 1 === LEN ? 0 : c.pos + 1;
    s += k + c.state.total;
  }
  return s;
};

// The async control: opPlain behind an async function, awaited once per operation. A sent
// operation does the fake fetch's work in its place: the call, the headers walk, `text()` and
// `JSON.parse`, then answers what the app answers (a 2xx is 1, the 409 is 0).
const opPlainAsync = async (c, op) => {
  if (!SENT.has(op.kind)) return opPlain(c, op);
  const r = await fetch(URL_OF[op.kind]);
  let named = 0;
  for (const [k, v] of r.headers.entries()) named += k.length + v.length;
  const body = JSON.parse(await r.text());
  return r.ok && named > 0 && body !== null ? 1 : 0;
};
const runPlainAsync = async (c, n, kindsOut, ops = OPS) => {
  let s = 0;
  for (let i = 0; i < n; i++) {
    const k = await opPlainAsync(c, ops[c.pos]);
    if (kindsOut) kindsOut.push(k);
    c.pos = c.pos + 1 === ops.length ? 0 : c.pos + 1;
    s += k + c.state.total;
  }
  return s;
};
const plainAsync = { state: withItems([]), past: [], pos: 0 };
const plainLocal = { state: withItems([]), past: [], pos: 0 };
const plainSent = { state: withItems([]), past: [], pos: 0 };

export const ASYNC = true;
export const N = {
  app_async: 10_000, app_sync: 10_000, app_control: 10_000, app_async_control: 10_000,
  app_async_local: 10_000, app_async_local_control: 10_000, app_async_sent: 10_000, app_async_sent_control: 10_000,
};
export const app_async = (n) => runAsync(asyncApp, n);
export const app_sync = (n) => Promise.resolve(runSync(syncApp, n));
export const app_control = (n) => Promise.resolve(runPlain(plain, n));
export const app_async_control = (n) => runPlainAsync(plainAsync, n);
export const app_async_local = (n) => runAsync(localApp, n, null, LOCAL_OPS);
export const app_async_local_control = (n) => runPlainAsync(plainLocal, n, null, LOCAL_OPS);
export const app_async_sent = (n) => runAsync(sentApp, n, null, SENT_OPS);
export const app_async_sent_control = (n) => runPlainAsync(plainSent, n, null, SENT_OPS);

/**
 * Self-check: each row runs two whole passes from the start. Per operation the answer kind, the
 * cart before the clear, and the listeners' counts. Both rows give the same answers, the refusal
 * and the checkout fail, the undo undoes, the sent actions reached the fetch (async), and the
 * second pass repeats the first. The control gives the same answers and cart. Returns them, for the two arms to agree on.
 */
export const check = async () => {
  const out = [];
  for (const [a, run] of [[syncApp, (n, ks) => runSync(syncApp, n, ks)], [asyncApp, (n, ks) => runAsync(asyncApp, n, ks)]]) {
    a.pos = 0;
    const passes = [];
    for (let p = 0; p < 2; p++) {
      const ks = [];
      await run(LEN - 1, ks);
      const cart = JSON.stringify(a.cart.state.value);
      const heard = a.heard.cart;
      await run(1, ks);
      passes.push({ answers: ks.join(''), cart, heard: heard > 0 });
    }
    if (passes[0].answers !== passes[1].answers || passes[0].cart !== passes[1].cart) throw new Error('the second pass differs from the first');
    const kindAt = (kind) => passes[0].answers[OPS.findIndex((o) => o.kind === kind)];
    if (kindAt('refuse') !== '0' || kindAt('checkout') !== '0' || kindAt('undo') !== '1') throw new Error(`refuse ${kindAt('refuse')} checkout ${kindAt('checkout')} undo ${kindAt('undo')}, want 0 0 1`);
    if (!passes[0].heard || a.heard.wish === 0) throw new Error('a listener heard nothing');
    if (JSON.parse(passes[0].cart).items.length === 0) throw new Error('the cart is empty before the clear');
    if (a === asyncApp && sent === 0) throw new Error('no sent action reached the fetch');
    out.push(passes[0].answers, passes[0].cart);
  }
  plain.pos = 0;
  const ks = [];
  runPlain(plain, LEN - 1, ks);
  const plainCart = JSON.stringify(plain.state);
  runPlain(plain, 1, ks);
  if (ks.join('') !== out[0] || plainCart !== out[1]) throw new Error('the control differs from the app');
  if (out[0] !== out[2] || out[1] !== out[3]) throw new Error(`the rows differ:\n${out[0]}\n${out[2]}\n${out[1]}\n${out[3]}`);
  // The async control answers as the app does, and each split row as its own control on its list.
  plainAsync.pos = 0;
  const aks = [];
  await runPlainAsync(plainAsync, LEN, aks);
  if (aks.join('') !== out[0]) throw new Error('the async control differs from the app');
  for (const [a, c, ops] of [[localApp, plainLocal, LOCAL_OPS], [sentApp, plainSent, SENT_OPS]]) {
    a.pos = 0;
    c.pos = 0;
    const got = [];
    const want = [];
    await runAsync(a, ops.length, got, ops);
    await runPlainAsync(c, ops.length, want, ops);
    if (got.join('') !== want.join('') || JSON.stringify(a.cart.state.value) !== JSON.stringify(c.state)) {
      throw new Error(`a split row differs from its control:\n${got.join('')}\n${want.join('')}`);
    }
    out.push(got.join(''));
  }
  const local = out[4];
  const sentAnswers = out[5];
  if (local[LOCAL_OPS.findIndex((o) => o.kind === 'refuse')] !== '0' || local[LOCAL_OPS.findIndex((o) => o.kind === 'undo')] !== '1') throw new Error(`the local row: ${local}`);
  if (sentAnswers.replaceAll('1', '') !== '0' || sentAnswers[SENT_OPS.findIndex((o) => o.kind === 'checkout')] !== '0') throw new Error(`the sent row: ${sentAnswers}`);
  return out;
};
