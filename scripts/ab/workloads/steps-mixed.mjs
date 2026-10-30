// Workload for scripts/ab/ab.mjs (log 36.F57): the MIXED check (V8-RULES 13) for a closure moved out
// of the dispatch functions: four actions, two with steps from distinct plugins and two with none,
// interleaved on one bus, sync and async. Rows: mixed_sync, mixed_async, query_mixed; bare is the
// control, a bus with no plugin, and async_control the async control (TESTING_PROCEDURE step 2): one
// await per operation and no library code, what the row's own promises cost.
import { createAsyncCommandBus, createCommandBus } from '__DIST__/index.js';

const parts = (id, seen) => ({ id, actions: ['step*'], reuse: () => undefined, admit: () => undefined, begin: () => { seen.n++; return undefined; } });
const seen = { n: 0 };
const wire = (bus) => {
  bus.register('stepA', (cmd) => cmd.target + 1);
  bus.register('stepB', (cmd) => cmd.target + 2);
  bus.register('plainA', (cmd) => cmd.target + 3);
  bus.register('plainB', (cmd) => cmd.target + 4);
  bus.use(parts('p1', seen));
  bus.use({ id: 'p2', actions: ['step*'], admit: () => undefined });
  bus.use({ id: 'p3', actions: ['stepA'], begin: () => undefined });
  return bus;
};
const sync = wire(createCommandBus());
const asyncBus = wire(createAsyncCommandBus({ retry: false }));
const ACTIONS = ['stepA', 'plainA', 'stepB', 'plainB'];
const bare = createCommandBus();
bare.register('plainA', (cmd) => cmd.target + 3);

export const ASYNC = true;
export const N = { mixed_sync: 200_000, query_mixed: 200_000, mixed_async: 50_000, bare_row: 200_000, async_control: 50_000 };
export const mixed_sync = async (n) => { let s = 0; for (let i = 0; i < n; i++) s += sync.dispatch(ACTIONS[i & 3], i & 7).value; return s; };
export const query_mixed = async (n) => { let s = 0; for (let i = 0; i < n; i++) s += sync.query(ACTIONS[i & 3], i & 7).value; return s; };
export const mixed_async = async (n) => { let s = 0; for (let i = 0; i < n; i++) s += (await asyncBus.dispatch(ACTIONS[i & 3], i & 7)).value; return s; };
export const bare_row = async (n) => { let s = 0; for (let i = 0; i < n; i++) s += bare.dispatch('plainA', i & 7).value; return s; };
const step = async (t) => t + 1;
export const async_control = async (n) => { let s = 0; for (let i = 0; i < n; i++) s += await step(i & 7); return s; };
export const check = async () => [await mixed_sync(8), await query_mixed(8), await mixed_async(8), await bare_row(8), seen.n > 0];
