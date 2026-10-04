// Workload for scripts/ab/ab.mjs (log s35.131-132): the HTTP client and the
// bridge, answered and failed, with fetch stubbed so only the library's own
// work is timed. Every row is async (ASYNC). The success rows are the control
// for the happy path; the failure rows time building and reading the failure.
import { createAsyncCommandBus, createHttpClient, postCommand } from '__DIST__/index.js';
import { createHttpBridge } from '__DIST__/transports.js';

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
  '/missing': reply(404, { status: 404, code: 'not_found', detail: 'Not here' }),
  '/stale': reply(409, { status: 409, code: 'stale', detail: 'Changed meanwhile', version: 3 }),
};
const lost = new TypeError('Failed to fetch');
globalThis.fetch = async (url) => {
  const a = answers[url];
  if (a === undefined) throw lost;
  return a;
};

const http = createHttpClient({ retry: 0, dedupe: false });
const okBus = createAsyncCommandBus({ retry: false });
okBus.use(createHttpBridge({ endpoint: '/ok' }));
const staleBus = createAsyncCommandBus({ retry: false });
staleBus.use(createHttpBridge({ endpoint: '/stale' }));

const status = (e) => e?.context?.status ?? e?.response?.status ?? 0;
const seq = async (n, one) => { let s = 0; for (let i = 0; i < n; i++) s += await one(i); return s; };

export const ASYNC = true;
export const N = { client_get_ok: 20_000, client_get_404: 20_000, client_get_lost: 20_000, post_409: 20_000, bridge_ok: 20_000, bridge_409: 20_000 };
export const client_get_ok = (n) => seq(n, () => http.get('/ok').then((r) => r.status));
export const client_get_404 = (n) => seq(n, () => http.get('/missing').then(() => 0, status));
export const client_get_lost = (n) => seq(n, () => http.get('/none').then(() => 0, () => 1));
export const post_409 = (n) => seq(n, () => postCommand('/stale', {}).then(() => 0, status));
export const bridge_ok = (n) => seq(n, (i) => okBus.dispatch('orderSave', { i }).then((r) => (r.ok ? 1 : 0)));
export const bridge_409 = (n) => seq(n, (i) => staleBus.dispatch('orderSave', { i }).then((r) => (r.ok ? 0 : 1)));
export const check = async () => [await client_get_ok(2), await client_get_404(2), await client_get_lost(2), await post_409(2), await bridge_ok(2), await bridge_409(2)];
