// Workload for scripts/ab/ab.mjs: a store action with `undo: true`, and without (log s35.112-114).
// Arm A predates the option, so `undo: true` is ignored there: the pair prices the option.
import { createCommandBus } from '__DIST__/index.js';
import { defineChamberStore } from '__DIST__/store.js';

const reducers = { set: (_s, n) => ({ n }) };
const useOn = defineChamberStore('on', { state: () => ({ n: 0 }), reducers, undo: true });
const useOff = defineChamberStore('off', { state: () => ({ n: 0 }), reducers });
const bus = createCommandBus();
const on = useOn(bus);
const off = useOff(bus);

const run = (store, n) => { let s = 0; for (let i = 0; i < n; i++) s += store.set(i & 3).value.n; return s; };
export const N = { store_undo_on: 200_000, store_undo_off: 200_000 };
export const store_undo_on = (n) => run(on, n);
export const store_undo_off = (n) => run(off, n);
export const check = () => [run(on, 8), run(off, 8)];
