// Workload for scripts/ab/ab.mjs (S10, log 23.5): readers of one store field.
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
    reducers: { inc: (s) => ({ ...s, [fields[0]]: s[fields[0]] + 1 }) },
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
const fifty = Array.from({ length: 50 }, (_, i) => `f${i}`);
const stores = {
  few: make('few', four, 4, (i, f) => f[i]),
  many_other: make('other', four, 200, () => 'b'),
  many_fields: make('wide', fifty, 50, (i, f) => f[i]),
  many_changed: make('changed', four, 200, () => 'a'),
  no_readers: make('none', four, 0, () => 'a'),
};
const run = (store, n) => { const r0 = runs; for (let i = 0; i < n; i++) store.inc(); return runs - r0 + store.state.value[Object.keys(store.state.value)[0]]; };

export const N = { few: 50_000, many_other: 20_000, many_fields: 20_000, many_changed: 5_000, no_readers: 100_000 };
export const few = (n) => run(stores.few, n);
export const many_other = (n) => run(stores.many_other, n);
export const many_fields = (n) => run(stores.many_fields, n);
export const many_changed = (n) => run(stores.many_changed, n);
export const no_readers = (n) => run(stores.no_readers, n);
export const check = () => Object.values(stores).map((s) => run(s, 4));
