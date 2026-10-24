// Workload for scripts/ab/ab.mjs (.probes/plan-1.32.md step 3c): a dispatch answered 202
// with a Location, single and batched, fetch stubbed so only the library's work is timed.
// Arm A (1.31, no pollWith installed) answers a plain success, arm B an `Accepted` whose
// `done` is never read, so nothing is polled: the row times the answer, not a follow.
// `single_200` is the same send answered 200, the normal path beside it. `followed_202`
// installs pollWith on arm A.
// Arm A installs the bridges, arm B declares the transports.
import * as I from '__DIST__/index.js';
import * as T from '__DIST__/transports.js';

const { createAsyncCommandBus } = I;

const sending = (endpoint, batch) => {
  if (T.httpTransport) return createAsyncCommandBus({ retry: false, transport: T.httpTransport({ endpoint, ...(batch ? { batch: {} } : {}) }) });
  const bus = createAsyncCommandBus({ retry: false });
  bus.use(batch ? T.createBatchingHttpBridge({ endpoint }) : T.createHttpBridge({ endpoint }));
  return bus;
};

const reply = (status, headers, text) => {
  const h = { 'content-type': 'application/json', ...headers };
  return { ok: true, status, url: 'https://api.test/vc', redirected: false, headers: { entries: () => Object.entries(h), get: (k) => h[k.toLowerCase()] ?? null }, json: async () => JSON.parse(text), text: async () => text };
};
const ok = reply(200, {}, JSON.stringify({ state: 1 }));
const accepted = reply(202, { location: '/jobs/7', 'retry-after': '2' }, '{}');
const ID = /"id":"([^"]+)"/g;
let sent = 0;
globalThis.fetch = async (url, init) => {
  sent++;
  if (url === '/one') return ok;
  if (url === '/accept') return accepted;
  const ids = Array.from(init.body.matchAll(ID), (m) => m[1]);
  return reply(200, {}, JSON.stringify({ results: ids.map((id) => ({ id, status: 202, headers: { Location: '/jobs/7', 'Retry-After': '2' } })) }));
};

const single200 = sending('/one', false);
const single202 = sending('/accept', false);
const batch202 = sending('/batch', true);
// The feature against the feature: 1.31 with pollWith installed, which follows at the answer
// (maxWait 0 ends each follow at once, with no timer: a lower bound of its cost), against
// the Accepted, whose follow waits for `done`.
const followed202 = sending('/accept', false);
if (I.pollWith) followed202.use(I.pollWith({ bus: followed202, maxWait: 0 }));

const seq = async (n, one) => { let s = 0; for (let i = 0; i < n; i++) s += await one(i); return s; };
const burst = (bus, i) => Promise.all([0, 1, 2, 3].map((j) => bus.dispatch('reportExport', { i: i * 4 + j }).then((r) => (r.ok ? 1 : 0))));

export const ASYNC = true;
export const N = { single_200: 20_000, single_202: 20_000, batch_202: 5_000, followed_202: 20_000 };
export const single_200 = (n) => seq(n, (i) => single200.dispatch('noteSave', { i }).then((r) => (r.ok ? 1 : 0)));
export const single_202 = (n) => seq(n, (i) => single202.dispatch('reportExport', { i }).then((r) => (r.ok ? 1 : 0)));
export const batch_202 = (n) => seq(n, (i) => burst(batch202, i).then((a) => a[0] + a[1] + a[2] + a[3]));
export const followed_202 = (n) => seq(n, (i) => followed202.dispatch('reportExport', { i }).then((r) => (r.ok ? 1 : 0)));

/** Self-check: every answer read as a success, one request per send and per burst, nothing polled. */
export const check = async () => {
  sent = 0;
  const r = [await single_200(2), await single_202(2), await batch_202(2), await followed_202(2)];
  return [...r, sent];
};
