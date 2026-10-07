// Workload for scripts/ab/ab.mjs (plan 1.28 item 1, log s35.212): what the
// mark on a bridged success (`_appliedRemotely`) costs, against an arm that
// deletes its `set` line. Dense bridged successes, fetch stubbed as in
// http-failures.mjs, so only the library's own work is timed. Measured at
// 134 ns per dispatch with the tool's 32 MB young generation (an upper
// bound: thousands of marks live between two scavenges). Two app-rate
// variants could not resolve 50 ns, recorded in the log: a minor gc every 8
// dispatches inside the timed call (the gc is ~99% of it), and a 1 MB young
// generation (`--flags=--max-semi-space-size=1`, controls failed).
import { createAsyncCommandBus } from '__DIST__/index.js';
import { createHttpBridge } from '__DIST__/transports.js';

const text = JSON.stringify({ state: 1 });
const h = { 'content-type': 'application/json' };
const ok = {
  ok: true, status: 200, url: '', redirected: false,
  headers: { entries: () => Object.entries(h), get: (k) => h[k.toLowerCase()] ?? null },
  json: async () => JSON.parse(text), text: async () => text,
};
globalThis.fetch = async () => ok;

const bus = createAsyncCommandBus({ retry: false });
bus.use(createHttpBridge({ endpoint: '/ok' }));

const run = async (n) => {
  let s = 0;
  for (let i = 0; i < n; i++) s += (await bus.dispatch('orderSave', { i })).ok ? 1 : 0;
  return s;
};

export const ASYNC = true;
export const N = { bridge_ok: 20_000 };
export const bridge_ok = (n) => run(n);
export const check = async () => [await bridge_ok(4)];
