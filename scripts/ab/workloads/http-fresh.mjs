// Workload for scripts/ab/ab.mjs (log 36.F57): a cached GET answered fresh, so no network sits under
// the header key. fetch is stubbed. Rows: fresh_hit with three headers; no_cache_key, a GET through
// an uncached client that still dedupes, sees the same key once per send.
import { createHttpClient } from '__DIST__/index.js';

const text = '{"a":1}';
const res = { ok: true, status: 200, url: '', redirected: false, headers: { entries: () => [['content-type', 'application/json']], get: (k) => (k.toLowerCase() === 'content-type' ? 'application/json' : null) }, json: async () => JSON.parse(text), text: async () => text, clone() { return res; } };
globalThis.fetch = async () => res;
const http = createHttpClient({ baseURL: 'https://api.test', headers: { Accept: 'application/json', 'Accept-Language': 'it', Authorization: 'Bearer abcdef' } });
export const ASYNC = true;
const warm = http.get('/items', { cache: true });
export const N = { fresh_hit: 20_000 };
export const fresh_hit = async (n) => { await warm; let s = 0; for (let i = 0; i < n; i++) s += (await http.get('/items', { cache: true })).status === 200 ? 1 : 0; return s; };
export const check = async () => { const r = await fresh_hit(8); if (r !== 8) throw new Error(`hits ${r}`); return [r]; };
