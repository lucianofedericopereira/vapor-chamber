// Workload for scripts/ab/ab.mjs (.probes/step-ritual.md item 14, step 3a): one bus as an
// app has it. Two plugins, a listener, two transports by pattern, local handlers. Each
// round runs eight kinds of call in turn: a sent success, a sent 409, a local success, a
// local refusal by the validator, a local throw, a local query, a sent query and a request.
// Row mixed_keyed (step 3b-bis) runs the same calls on a bus that keys them: the retry on,
// `order*` declared idempotent, and the idempotent plugin on `stock*`.
// Arm A (1.31) installs the bridges as chain links after the plugins, arm B declares them.
import { createAsyncCommandBus, idempotent, metrics, validator } from '__DIST__/index.js';
import * as T from '__DIST__/transports.js';

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
  '/ok': reply(200, { state: 1 }),
  '/stale': reply(409, { status: 409, code: 'stale', detail: 'Changed meanwhile', version: 3 }),
};
let sent = 0;
globalThis.fetch = async (url) => { sent++; return answers[url]; };

let heard = 0;
/** One app bus: `retry` as the bus option, `more` plugins after the shared two. */
const appBus = (retry, more) => {
  const plugins = [metrics({ maxSize: 64 }), validator({ cartAdd: (cmd) => (cmd.target.i % 16 === 3 ? 'bad' : null) }), ...more];
  let bus;
  if (T.httpTransport) {
    bus = createAsyncCommandBus({ retry, transport: { 'order*': T.httpTransport({ endpoint: '/ok' }), 'stock*': T.httpTransport({ endpoint: '/stale' }) } });
    for (const p of plugins) bus.use(p);
  } else {
    bus = createAsyncCommandBus({ retry });
    for (const p of plugins) bus.use(p);
    bus.use(T.createHttpBridge({ endpoint: '/ok', actions: ['order*'] }));
    bus.use(T.createHttpBridge({ endpoint: '/stale', actions: ['stock*'] }));
  }
  bus.register('cartAdd', async (cmd) => cmd.target.i);
  bus.register('cartRemove', async () => { throw new Error('gone'); });
  bus.register('profileGet', async (cmd) => cmd.target.i);
  bus.respond('priceGet', async (cmd) => cmd.target.i);
  bus.on('cart*', () => { heard++; });
  return bus;
};
const plainBus = appBus(false, []);
const keyedBus = appBus({ actionPolicies: { 'order*': 'idempotent' } }, [idempotent({ actions: ['stock*'] })]);

const ok = (r) => (r.ok ? 1 : 0);
const call = (bus, i) => {
  const t = { i };
  switch (i & 7) {
    case 0: return bus.dispatch('orderSave', t).then(ok);
    case 1: return bus.dispatch('stockMove', t).then(ok);
    case 2: return bus.dispatch('cartAdd', t).then(ok);
    case 3: return bus.dispatch('cartAdd', { i: 3 }).then(ok);
    case 4: return bus.dispatch('cartRemove', t).then(ok);
    case 5: return bus.query('profileGet', t).then(ok);
    case 6: return bus.query('orderGet', t).then(ok);
    default: return bus.request('priceGet', t).then(ok);
  }
};
const seq = async (bus, n) => { let s = 0; for (let i = 0; i < n; i++) s += await call(bus, i); return s; };

export const ASYNC = true;
export const N = { mixed_app: 16_000, mixed_keyed: 16_000 };
export const mixed_app = (n) => seq(plainBus, n);
export const mixed_keyed = (n) => seq(keyedBus, n);

/** Self-check, each bus: three of eight calls reach the wire, five succeed, the listener hears three. */
export const check = async () => {
  const counts = [];
  for (const run of [mixed_app, mixed_keyed]) {
    sent = 0; heard = 0;
    const okCount = await run(8);
    if (sent !== 3 || okCount !== 5 || heard !== 3) throw new Error(`sent ${sent} ok ${okCount} heard ${heard}, want 3 5 3`);
    counts.push(okCount);
  }
  return counts;
};
