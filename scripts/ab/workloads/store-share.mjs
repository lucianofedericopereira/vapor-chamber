// Workload for scripts/ab/ab.mjs: a store shared across tabs (log s35.129). Arm A predates
// `share`, so its "shared" store is a plain one: the pair prices the option. No channel:
// the lane's emit is what a write pays locally.
import { createCommandBus } from '__DIST__/index.js';
import { createFastLane } from '__DIST__/fast-lane.js';
import { defineChamberStore } from '__DIST__/store.js';

const actions = { set: (s, n) => ({ n }) };
const lane = createFastLane();
const useShared = defineChamberStore('shared', { state: () => ({ n: 0 }), actions, share: lane });
const usePlain = defineChamberStore('plain', { state: () => ({ n: 0 }), actions });
const shared = useShared(createCommandBus());
const plain = usePlain(createCommandBus());

const run = (store, n) => { let s = 0; for (let i = 0; i < n; i++) s += store.set(i).value.n; return s; };
export const N = { store_shared: 200_000, store_plain: 200_000 };
export const store_shared = (n) => run(shared, n);
export const store_plain = (n) => run(plain, n);
export const check = () => [run(shared, 8), run(plain, 8)];
