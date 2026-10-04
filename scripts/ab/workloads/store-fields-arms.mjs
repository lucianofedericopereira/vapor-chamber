// Workload for scripts/ab/ab.mjs (S10, log 23.5): readers of one store field,
// 50 readers. The arm is what the build exports, checked in this order:
//   E (fieldRef): an effect per reader over a per-field signal fed by the
//     store's OWN keyed field events ($onField), no bus listener;
//   D (fieldSignal): an effect per reader over a per-field signal fed by keyed
//     bus events (the Vue binding over arm C);
//   C (fieldEvents): a bus listener per reader on '$field.<id>.<field>';
//   B (storeField): an effect per reader over a signal from a sync watch;
//   A (none): an effect per reader over ONE shared computed per field.
// unrelated_50: the same store and 50 readers, but the loop dispatches an
// action that is not the store's, on the same bus (the side cost of a bus
// listener: it takes every dispatch on that bus off the bare path).
// no_binding: a store action with no readers and nothing subscribed (the store's
// own cost when no app opts in).
// Arms (npm run ab:dists, scratch branches s10-*, never merged): A c9526a7, B 8612f35
// (storeField), C 90b24c8 (fieldEvents), D 7651460 (fieldSignal), E 439dfbb and
// E2 8cf65a9 (fieldRef over the store's own $onField). Results: log s35.104.
import { computed, effect } from 'vue';
import { createCommandBus } from '__DIST__/index.js';
import * as storeMod from '__DIST__/store.js';

const { defineChamberStore } = storeMod;
const own = storeMod.fieldRef;
const bind = storeMod.fieldSignal;
const keyed = storeMod.fieldEvents;
const project = storeMod.storeField;
let runs = 0;

function make(id, fields, readers, readKey) {
  const bus = createCommandBus();
  bus.register('ping', (cmd) => cmd.target + 1);
  const init = {};
  for (const f of fields) init[f] = 0;
  const store = defineChamberStore(id, {
    state: () => ({ ...init }),
    actions: { inc: (s) => ({ ...s, [fields[0]]: s[fields[0]] + 1 }) },
  })(bus);
  if (!own && !bind && keyed) keyed(store, bus);
  const shared = new Map();
  for (let i = 0; i < readers; i++) {
    const key = readKey(i, fields);
    if (own) {
      const r = own(store, key);
      effect(() => { runs += r.value; });
    } else if (bind) {
      const r = bind(store, bus, key);
      effect(() => { runs += r.value; });
    } else if (keyed) {
      bus.on(`$field.${id}.${key}`, (cmd) => { runs += cmd.target; });
    } else if (project) {
      const r = project(store, key);
      effect(() => { runs += r.value; });
    } else {
      let c = shared.get(key);
      if (!c) { c = computed(() => store.state.value[key]); shared.set(key, c); }
      effect(() => { runs += c.value; });
    }
  }
  return { store, bus };
}

const four = ['a', 'b', 'c', 'd'];
const wide = Array.from({ length: 50 }, (_, i) => `f${i}`);
const s = {
  other_50: make('o50', four, 50, () => 'b'),
  changed_50: make('c50', four, 50, () => 'a'),
  fields_50: make('f50', wide, 50, (i, f) => f[i]),
  unrelated_50: make('u50', four, 50, () => 'b'),
  no_binding: make('n0', four, 0, () => 'a'),
};
const run = ({ store }, n) => { const r0 = runs; for (let i = 0; i < n; i++) store.inc(); return runs - r0 + store.state.value[Object.keys(store.state.value)[0]]; };
const ping = ({ bus }, n) => { let t = 0; for (let i = 0; i < n; i++) t += bus.dispatch('ping', i).value; return t; };

export const N = { other_50: 2_000, changed_50: 2_000, fields_50: 2_000, unrelated_50: 50_000, no_binding: 50_000 };
export const other_50 = (n) => run(s.other_50, n);
export const changed_50 = (n) => run(s.changed_50, n);
export const fields_50 = (n) => run(s.fields_50, n);
export const unrelated_50 = (n) => ping(s.unrelated_50, n);
export const no_binding = (n) => run(s.no_binding, n);
export const check = () => [run(s.other_50, 4), run(s.changed_50, 4), run(s.fields_50, 4), ping(s.unrelated_50, 4), run(s.no_binding, 4)];
