// Workload for scripts/ab/ab.mjs (log 36.F57): a core store's write with no subscriber, over plain
// cells. Rows: core_write; plain_row, the bus with no store, is the control.
import { createCommandBus } from '__DIST__/index.js';
import { defineChamberStore } from '__DIST__/store/core.js';

const bus = createCommandBus();
const store = defineChamberStore('n', { state: () => ({ n: 0 }), reducers: { inc: (s) => ({ n: s.n + 1 }) } })(bus);
const plain = createCommandBus();
plain.register('x', (cmd) => cmd.target + 1);
export const N = { core_write: 100_000, plain_row: 200_000 };
export const core_write = (n) => { for (let i = 0; i < n; i++) store.inc(); return store.state.value.n; };
export const plain_row = (n) => { let s = 0; for (let i = 0; i < n; i++) s += plain.dispatch('x', i).value; return s; };
export const check = () => [core_write(8) > 0, plain_row(8)];
