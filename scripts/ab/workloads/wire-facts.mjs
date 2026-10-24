// Workload for scripts/ab/ab.mjs (.probes/plan-1.32.md step 3b): the wire facts on the
// paths that carry them, fetch stubbed so only the library's work is timed. A burst of
// four keyed commands in one batch (the key in each command's `headers`, in 1.31 its
// `meta`), with an id-shaped key and with the idempotent plugin's JSON-shaped one, the
// same burst unkeyed, a keyed single send (the header in both arms), and a
// batched failure answered as the 1.32 controller answers it (`status` on the result).
// The idempotent plugin itself, batched and single, with its default key (step 3b-bis).
// Arm A (1.31) installs the bridges after the key plugin, arm B declares the transports.
import * as V from '__DIST__/index.js';
const { createAsyncCommandBus, idempotent } = V;
import * as T from '__DIST__/transports.js';

// A plugin that writes the key: a `started` part from 1.32 step 8d, a chain function before.
const keying = (write) => (V.buildRunner ? (cmd, next) => { write(cmd); return next(); } : { started: write });
// A key of unreserved characters, as `meta.id` is (an action declared idempotent).
const keyed = keying((cmd) => { cmd.meta.idempotencyKey = `k${cmd.target.i}`; });
// An app's own JSON-shaped key: the action and the target as JSON, percent-encoded.
const keyedJson = keying((cmd) => { cmd.meta.idempotencyKey = `${cmd.action}:${JSON.stringify(cmd.target)}`; });
const sending = (endpoint, batch, plugins) => {
  if (T.httpTransport) {
    const bus = createAsyncCommandBus({ retry: false, transport: T.httpTransport({ endpoint, ...(batch ? { batch: {} } : {}) }) });
    for (const p of plugins) bus.use(p);
    return bus;
  }
  const bus = createAsyncCommandBus({ retry: false });
  for (const p of plugins) bus.use(p);
  bus.use(batch ? T.createBatchingHttpBridge({ endpoint }) : T.createHttpBridge({ endpoint }));
  return bus;
};

const h = { 'content-type': 'application/json' };
const reply = (text) => ({ ok: true, status: 200, url: '', redirected: false, headers: { entries: () => Object.entries(h), get: (k) => h[k.toLowerCase()] ?? null }, json: async () => JSON.parse(text), text: async () => text });
const single = reply(JSON.stringify({ state: 1 }));
const ID = /"id":"([^"]+)"/g;
const KEY = /Idempotency-Key|idempotencyKey/;
let sent = 0;
let keys = 0;
globalThis.fetch = async (url, init) => {
  sent++;
  if (url === '/one') {
    if (init.headers['Idempotency-Key']) keys++;
    return single;
  }
  // The ids only, by a scan: a JSON.parse here would time the stub's own parse of
  // each arm's body (1.32's escaped key quotes), not the library's work.
  const ids = Array.from(init.body.matchAll(ID), (m) => m[1]);
  keys += init.body.split(KEY).length - 1;
  const results = url === '/fail'
    ? ids.map((id) => ({ id, status: 409, headers: {}, problem: { status: 409, code: 'stale', detail: 'Changed meanwhile' } }))
    : ids.map((id) => ({ id, status: 200, headers: {}, state: 1 }));
  return reply(JSON.stringify({ results }));
};

const batchKeyed = sending('/batch', true, [keyed]);
const batchKeyedJson = sending('/batch', true, [keyedJson]);
const batchPlain = sending('/batch', true, []);
const singleKeyed = sending('/one', false, [keyed]);
const batchFail = sending('/fail', true, []);
const batchIdempotent = sending('/batch', true, [idempotent()]);
const singleIdempotent = sending('/one', false, [idempotent()]);

const burst = (bus, i, ok) => Promise.all([0, 1, 2, 3].map((j) => bus.dispatch('orderSave', { i: i * 4 + j }).then((r) => (r.ok === ok ? 1 : 0))));
const seq = async (n, one) => { let s = 0; for (let i = 0; i < n; i++) s += await one(i); return s; };
const sum = (a) => a[0] + a[1] + a[2] + a[3];

export const ASYNC = true;
export const N = { batch_keyed: 5_000, batch_keyed_json: 5_000, batch_plain: 5_000, single_keyed: 20_000, batch_fail: 5_000, batch_idempotent: 5_000, single_idempotent: 20_000 };
export const batch_keyed = (n) => seq(n, (i) => burst(batchKeyed, i, true).then(sum));
export const batch_keyed_json = (n) => seq(n, (i) => burst(batchKeyedJson, i, true).then(sum));
export const batch_plain = (n) => seq(n, (i) => burst(batchPlain, i, true).then(sum));
export const single_keyed = (n) => seq(n, (i) => singleKeyed.dispatch('orderSave', { i }).then((r) => (r.ok ? 1 : 0)));
export const batch_fail = (n) => seq(n, (i) => burst(batchFail, i, false).then(sum));
// Each call a new target: the plugin collapses nothing, every command is sent keyed.
let fresh = 0;
export const batch_idempotent = (n) => seq(n, () => burst(batchIdempotent, fresh++, true).then(sum));
export const single_idempotent = (n) => seq(n, () => singleIdempotent.dispatch('orderSave', { i: fresh++ }).then((r) => (r.ok ? 1 : 0)));

/** Self-check: one request per burst, every keyed command carries its key, every answer read. */
export const check = async () => {
  sent = 0; keys = 0;
  const r = [await batch_keyed(2), await batch_keyed_json(2), await batch_plain(2), await single_keyed(2), await batch_fail(2), await batch_idempotent(2), await single_idempotent(2)];
  return [...r, sent, keys];
};
