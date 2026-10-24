// Workload for scripts/ab/ab.mjs (lead 8c, item 5): a step's ticket writes `signal` on a sync command whose literal
// has no slot. Arm A writes it late (today), arm B carries `signal: undefined` in every sync literal (the lead's fix).
// Rows: sync_step_signal (every command gets a signal from an own `begin` part), sync_step_mixed (one bus, half the
// actions get it: shared sites see both shapes), sync_bare (a bare sync dispatch: what B's slot costs everyone).
// A listener and the handler read the command, so the sites that see its shape run.
import { createCommandBus } from '__DIST__/index.js';

const ctrl = new AbortController();
const ticket = { signal: ctrl.signal };
let heard = 0;

const stepped = createCommandBus();
stepped.use({ id: 'own', begin: () => ticket });
stepped.on('*', (cmd) => { heard += cmd.action.length; });
for (const a of ['saveA', 'saveB', 'saveC', 'saveD']) stepped.register(a, (cmd) => (cmd.signal ? cmd.target.n + 1 : 0));

const mixed = createCommandBus();
mixed.use({ id: 'own', actions: ['save*'], begin: () => ticket });
mixed.on('*', (cmd) => { heard += cmd.action.length; });
for (const a of ['saveA', 'saveB', 'loadA', 'loadB']) mixed.register(a, (cmd) => cmd.target.n + 1);

const bare = createCommandBus();
for (const a of ['saveA', 'saveB', 'loadA', 'loadB']) bare.register(a, (cmd) => cmd.target.n + 1);

const TARGETS = Array.from({ length: 64 }, (_, i) => ({ n: i, tag: i % 3 === 0 ? 'x' : 'y' }));
const STEPPED = ['saveA', 'saveB', 'saveC', 'saveD'];
const MIXED = ['saveA', 'loadA', 'saveB', 'loadB'];

// A sync batch of four, the batch literal's path.
const BATCH = MIXED.map((action, i) => ({ action, target: TARGETS[i] }));
export const sync_batch = (n) => { let s = 0; for (let i = 0; i < n; i++) s += bare.dispatchBatch(BATCH).results.length; return s; };

export const N = { sync_step_signal: 100_000, sync_step_mixed: 100_000, sync_bare: 200_000, sync_batch: 50_000 };
export const sync_step_signal = (n) => { let s = 0; for (let i = 0; i < n; i++) s += stepped.dispatch(STEPPED[i & 3], TARGETS[i & 63]).value; return s + (heard & 1); };
export const sync_step_mixed = (n) => { let s = 0; for (let i = 0; i < n; i++) s += mixed.dispatch(MIXED[i & 3], TARGETS[i & 63]).value; return s + (heard & 1); };
export const sync_bare = (n) => { let s = 0; for (let i = 0; i < n; i++) s += bare.dispatch(MIXED[i & 3], TARGETS[i & 63]).value; return s; };

/** Each row answers ok with the handler's value, and the stepped commands carry the step's signal. */
export const check = () => {
  const a = stepped.dispatch('saveA', { n: 4 });
  const b = mixed.dispatch('saveA', { n: 4 });
  const c = mixed.dispatch('loadA', { n: 4 });
  const d = bare.dispatch('loadA', { n: 4 });
  if (a.value !== 5 || b.value !== 5 || c.value !== 5 || d.value !== 5) throw new Error(`values ${a.value} ${b.value} ${c.value} ${d.value}`);
  return [a.value, b.value, c.value, d.value].map(String);
};
