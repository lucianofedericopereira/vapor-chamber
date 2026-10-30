// Workload for scripts/ab/ab.mjs (log 36.F57): a command through two `authorize` rules that pass,
// distinct functions (V8-RULES 11), on a sync and an async bus. A closure in `_refusal`'s rare
// promise arm was read as costing its loop a context. Rows: rules2 and rules2_async; bare, no
// rule, is the control (a path the change does not run).
import { createAsyncCommandBus, createCommandBus } from '__DIST__/index.js';

const ruled = (bus) => {
  bus.register('x', (cmd) => cmd.target + 1);
  bus.use({ id: 'a', authorize: () => (cmd) => (cmd.target < 0 ? { ok: false, value: undefined, error: new Error('never') } : undefined) });
  bus.use({ id: 'b', authorize: () => (cmd) => (cmd.target > 1e9 ? { ok: false, value: undefined, error: new Error('never') } : undefined) });
  return bus;
};
const sync = ruled(createCommandBus());
const asyncBus = ruled(createAsyncCommandBus({ retry: false }));
const bare = createCommandBus();
bare.register('x', (cmd) => cmd.target + 1);

export const ASYNC = true;
export const N = { rules2: 200_000, rules2_async: 50_000, bare_row: 200_000 };
export const rules2 = async (n) => { let s = 0; for (let i = 0; i < n; i++) s += sync.dispatch('x', i & 3).value; return s; };
export const rules2_async = async (n) => { let s = 0; for (let i = 0; i < n; i++) s += (await asyncBus.dispatch('x', i & 3)).value; return s; };
export const bare_row = async (n) => { let s = 0; for (let i = 0; i < n; i++) s += bare.dispatch('x', i & 3).value; return s; };
export const check = async () => [await rules2(8), await rules2_async(8), await bare_row(8)];
