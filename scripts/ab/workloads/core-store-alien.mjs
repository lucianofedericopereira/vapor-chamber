// Workload for scripts/ab/ab.mjs (log 36.F57): core-store.mjs over alien-signals cells, where a read
// of the cell is a real call.
import { configureAlienSignals } from '__DIST__/alien-signals.js';
import { signal as alienSignal } from 'alien-signals';
import { createCommandBus } from '__DIST__/index.js';
import { defineChamberStore } from '__DIST__/store/core.js';

configureAlienSignals(alienSignal);
const bus = createCommandBus();
const store = defineChamberStore('n', { state: () => ({ n: 0 }), reducers: { inc: (s) => ({ n: s.n + 1 }) } })(bus);
const plain = createCommandBus();
plain.register('x', (cmd) => cmd.target + 1);
export const N = { core_write_alien: 100_000, plain_row: 200_000 };
export const core_write_alien = (n) => { for (let i = 0; i < n; i++) store.inc(); return store.state.value.n; };
export const plain_row = (n) => { let s = 0; for (let i = 0; i < n; i++) s += plain.dispatch('x', i).value; return s; };
export const check = () => [core_write_alien(8) > 0, plain_row(8)];
