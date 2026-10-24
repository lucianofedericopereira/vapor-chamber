// Workload for scripts/ab/ab.mjs (step 3d): a router loader read. The in-box preset's URL
// handler (`fetchLoaders`) as the router calls it, through an app's client, with fetch
// stubbed so only the library's work is timed: the template, the client's GET, the answer.
// Both arms are given the client explicitly, the shape 1.31 has.
import { createHttpClient } from '__DIST__/index.js';
import { fetchLoaders } from '__DIST__/router-fetch/index.js';

const text = JSON.stringify({ items: [1, 2, 3] });
const h = { 'content-type': 'application/json' };
const ok = {
  ok: true, status: 200, url: '', redirected: false,
  headers: { entries: () => Object.entries(h), get: (k) => h[k.toLowerCase()] ?? null },
  json: async () => JSON.parse(text), text: async () => text,
};
let sent = 0;
globalThis.fetch = async () => { sent++; return ok; };

const loaders = fetchLoaders({ http: createHttpClient() });
const record = { name: 'list', meta: {}, queryDefs: { page: { type: 'number', default: 1 } } };
const signal = new AbortController().signal;
const ctx = { revalidate() {}, refresh: false };
const at = (i) => ({ params: { id: String(i & 7) }, query: { page: String(i & 3) } });

const seq = async (n) => { let s = 0; for (let i = 0; i < n; i++) s += (await loaders.url('/api/items/{id}?page={page}', at(i), record, signal, ctx)).items.length; return s; };

export const ASYNC = true;
export const N = { loader_read: 20_000 };
export const loader_read = (n) => seq(n);

/** Self-check: each read reaches the wire and answers three items. */
export const check = async () => {
  sent = 0;
  const items = await seq(4);
  if (sent !== 4 || items !== 12) throw new Error(`sent ${sent} items ${items}, want 4 12`);
  return [items];
};
