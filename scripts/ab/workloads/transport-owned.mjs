// Workload for scripts/ab/ab.mjs (.probes/plan-1.32.md step 3a): the cost of the bus owning
// the send. Arm A (1.31) installs the bridge as a chain link, arm B declares the transport
// at the bus, where it is the work. Both arms do the same work: every plugin wraps the send.
// Rows: a sent success with no plugin, the same with two plugins, a local dispatch on a bus
// whose transport covers other actions, and a bare local dispatch (a control: no transport).
import { createAsyncCommandBus, metrics, validator } from '__DIST__/index.js';
import * as T from '__DIST__/transports.js';

// Either arm: 1.32 declares the transport at the bus, by pattern; 1.31 installs the bridge,
// after the plugins, where it works in both.
const sending = (plugins, actions) => {
  if (T.httpTransport) {
    const t = T.httpTransport({ endpoint: '/vc' });
    const bus = createAsyncCommandBus({ retry: false, transport: actions ? Object.fromEntries(actions.map((p) => [p, t])) : t });
    for (const p of plugins) bus.use(p);
    return bus;
  }
  const bus = createAsyncCommandBus({ retry: false });
  for (const p of plugins) bus.use(p);
  bus.use(T.createHttpBridge({ endpoint: '/vc', actions }));
  return bus;
};

const text = JSON.stringify({ state: 1 });
const h = { 'content-type': 'application/json' };
const ok = { ok: true, status: 200, url: '', redirected: false, headers: { entries: () => Object.entries(h), get: (k) => h[k.toLowerCase()] ?? null }, text: async () => text };
let sent = 0;
globalThis.fetch = async () => { sent++; return ok; };

const bridged = sending([]);
const chained = sending([metrics({ maxSize: 64 }), validator({ orderSave: () => null })]);
const mixed = sending([], ['order*']);
mixed.register('cartAdd', async (cmd) => cmd.target.i);
const bare = createAsyncCommandBus({ retry: false });
bare.register('cartAdd', async (cmd) => cmd.target.i);

const seq = async (n, one) => { let s = 0; for (let i = 0; i < n; i++) s += await one(i); return s; };

export const ASYNC = true;
export const N = { bridged_ok: 20_000, bridged_two_plugins: 20_000, local_with_bridge: 50_000, control_bare: 50_000 };
export const bridged_ok = (n) => seq(n, (i) => bridged.dispatch('orderSave', { i }).then((r) => (r.ok ? 1 : 0)));
export const bridged_two_plugins = (n) => seq(n, (i) => chained.dispatch('orderSave', { i }).then((r) => (r.ok ? 1 : 0)));
export const local_with_bridge = (n) => seq(n, (i) => mixed.dispatch('cartAdd', { i }).then((r) => r.value));
export const control_bare = (n) => seq(n, (i) => bare.dispatch('cartAdd', { i }).then((r) => r.value));

/** Self-check: each sent row reaches the wire once per dispatch, the local rows never. */
export const check = async () => {
  sent = 0;
  const a = await bridged_ok(2);
  const b = await bridged_two_plugins(2);
  const wire = sent;
  const c = await local_with_bridge(2);
  const d = await control_bare(2);
  if (wire !== 4 || sent !== 4) throw new Error(`wire count ${wire}/${sent}, want 4/4`);
  return [a, b, c, d];
};
