// Workload for scripts/ab/ab.mjs (S10 sweep, log 23.5): readers of one store field at 20, 50 and 100.
// Arm A (no storeField export): each reader is an effect over ONE computed per
// field, shared by every reader of it - what an app writes with no library code. Arm B (the
// prototype exports storeField): each reader is an effect over the field's
// projected signal. The store and its dispatch are the same in both.
// Arms (npm run ab:dists, scratch branches s10-*, never merged): A c9526a7, B 8612f35
// (storeField), C 90b24c8 (fieldEvents), D 7651460 (fieldSignal), E 439dfbb and
// E2 8cf65a9 (fieldRef over the store's own $onField). Results: log s35.104.
import { computed, effect } from 'vue';
import { createCommandBus } from '__DIST__/index.js';
import * as storeMod from '__DIST__/store.js';

const { defineChamberStore } = storeMod;
const project = storeMod.storeField; // undefined in arm A
let runs = 0;

function make(id, fields, readers, readKey) {
  const bus = createCommandBus();
  const init = {};
  for (const f of fields) init[f] = 0;
  const store = defineChamberStore(id, {
    state: () => ({ ...init }),
    actions: { inc: (s) => ({ ...s, [fields[0]]: s[fields[0]] + 1 }) },
  })(bus);
  const shared = new Map();
  for (let i = 0; i < readers; i++) {
    const key = readKey(i, fields);
    if (project) {
      const r = project(store, key);
      effect(() => { runs += r.value; });
    } else {
      let c = shared.get(key);
      if (!c) { c = computed(() => store.state.value[key]); shared.set(key, c); }
      effect(() => { runs += c.value; });
    }
  }
  return store;
}

const four = ['a', 'b', 'c', 'd'];
const wide = (k) => Array.from({ length: k }, (_, i) => `f${i}`);
const stores = {};
for (const k of [20, 50, 100]) {
  stores[`other_${k}`] = make(`o${k}`, four, k, () => 'b');
  stores[`changed_${k}`] = make(`c${k}`, four, k, () => 'a');
  stores[`fields_${k}`] = make(`f${k}`, wide(k), k, (i, f) => f[i]);
}
const run = (store, n) => { const r0 = runs; for (let i = 0; i < n; i++) store.inc(); return runs - r0 + store.state.value[Object.keys(store.state.value)[0]]; };

export const N = Object.fromEntries(Object.keys(stores).map((k) => [k, 2_000]));
export const other_20 = (n) => run(stores.other_20, n);
export const other_50 = (n) => run(stores.other_50, n);
export const other_100 = (n) => run(stores.other_100, n);
export const changed_20 = (n) => run(stores.changed_20, n);
export const changed_50 = (n) => run(stores.changed_50, n);
export const changed_100 = (n) => run(stores.changed_100, n);
export const fields_20 = (n) => run(stores.fields_20, n);
export const fields_50 = (n) => run(stores.fields_50, n);
export const fields_100 = (n) => run(stores.fields_100, n);
export const check = () => Object.values(stores).map((s) => run(s, 4));
