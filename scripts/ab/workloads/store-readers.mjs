// Workload for scripts/ab/ab.mjs: components reading store fields (log s35.125).
// Arm A has no fieldRef: each reader is a computed over the state, the way an app
// reads a field without it. Arm B reads through fieldRef. A write changes field
// f0; the readers watch other fields (the common case: most readers unaffected).
import { computed, effect, effectScope } from 'vue';
import { createCommandBus } from '__DIST__/index.js';
import * as storeMod from '__DIST__/store.js';

const keys = Array.from({ length: 10 }, (_, i) => `f${i}`);
const state = () => Object.fromEntries(keys.map((k) => [k, 0]));
const useS = (id) => storeMod.defineChamberStore(id, { state, reducers: { set: (s, n) => ({ ...s, f0: n }) } });

function setup(id, readers) {
  const store = useS(id)(createCommandBus());
  const scope = effectScope();
  scope.run(() => {
    for (let i = 1; i <= readers; i++) {
      const k = keys[i];
      const r = typeof storeMod.fieldRef === 'function' ? storeMod.fieldRef(store, k) : computed(() => store.state.value[k]);
      effect(() => { void r.value; });
    }
  });
  return store;
}
const one = setup('one', 1);
const ten = setup('ten', 9);

const run = (store, n) => { let s = 0; for (let i = 0; i < n; i++) s += store.set(i & 3).value.f0; return s; };
export const N = { readers_1: 100_000, readers_9: 100_000 };
export const readers_1 = (n) => run(one, n);
export const readers_9 = (n) => run(ten, n);
export const check = () => [run(one, 8), run(ten, 8)];
