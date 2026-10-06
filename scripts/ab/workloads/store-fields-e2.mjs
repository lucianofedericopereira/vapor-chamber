// Workload for scripts/ab/ab.mjs: a store with no field subscriber (the bare
// write must stay as it was) and one with a subscriber on another field (log s35.125).
import { createCommandBus } from '__DIST__/index.js';
import { defineChamberStore } from '__DIST__/store.js';

const reducers = { set: (s, n) => ({ ...s, n }) };
const usePlain = defineChamberStore('plain', { state: () => ({ n: 0, other: 0 }), reducers });
const useWatched = defineChamberStore('watched', { state: () => ({ n: 0, other: 0 }), reducers });
const plain = usePlain(createCommandBus());
const watched = useWatched(createCommandBus());
if (typeof watched.$onField === 'function') watched.$onField('other', () => {});

const run = (store, n) => { let s = 0; for (let i = 0; i < n; i++) s += store.set(i & 3).value.n; return s; };
export const N = { no_subscriber: 200_000, subscriber_other_field: 200_000 };
export const no_subscriber = (n) => run(plain, n);
export const subscriber_other_field = (n) => run(watched, n);
export const check = () => [run(plain, 8), run(watched, 8)];
