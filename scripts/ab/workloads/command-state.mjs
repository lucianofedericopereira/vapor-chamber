// Workload for scripts/ab/ab.mjs: state reduced by commands, plan 1.32 step 4e. A build with
// `useCommandState` runs it; a build without it runs a store (`defineChamberStore`) with the same
// state and reducer, `coalesce` where the row says so. Both dispatch through `bus.dispatch`, and
// a fresh state every `per` dispatches inside an effect scope, so a short `per` prices creation.
// `create_dispose` creates and disposes one state per iteration, no dispatch. `write_only` keeps one state for the whole call: the write path alone. `raw_dispatch` never
// touches a state: the control.
import { effectScope } from 'vue';
import * as vue from '__DIST__/vue.js';
import { defineChamberStore } from '__DIST__/store.js';

const bus = vue.createCommandBus();
vue.setCommandBus(bus);
bus.register('ping', (cmd) => cmd.target + 1);
const legacy = typeof vue.useCommandState === 'function';

const append = (s, x) => ({ items: [...s.items, x] });
const inc = (s) => ({ n: s.n + 1 });
const defs = new Map();
// One state: [read, dispose]. The store's definitions are made once, as an app's module would.
function make(key, initial, reducer, coalesce) {
  if (legacy) {
    const { state, dispose } = vue.useCommandState(initial(), { [key]: (s, cmd) => reducer(s, cmd.target) }, { coalesce });
    return [state, dispose];
  }
  const id = key.slice(0, key.search(/[A-Z]/));
  const name = key.slice(id.length, id.length + 1).toLowerCase() + key.slice(id.length + 1);
  const def = `${key}:${coalesce}`;
  if (!defs.has(def)) defs.set(def, defineChamberStore(id, { state: initial, reducers: { [name]: reducer }, coalesce }));
  const store = defs.get(def)(bus);
  return [store.state, store.$dispose];
}

function run(n, per, key, initial, reducer, coalesce, size) {
  let s = 0;
  let i = 0;
  while (i < n) {
    const scope = effectScope();
    scope.run(() => {
      const [state, dispose] = make(key, initial, reducer, coalesce);
      for (let j = 0; j < per && i < n; j++, i++) bus.dispatch(key, i);
      s += size(state.value);
      dispose();
    });
    scope.stop();
  }
  return s;
}
const items = (v) => v.items.length;
const count = (v) => v.n;
const list = () => ({ items: [] });
const zero = () => ({ n: 0 });

const kept = effectScope();
let keptState;
kept.run(() => { [keptState] = make('tallyInc', zero, inc, false); });

export const N = { reset_call: 200_000, method_call: 200_000, create_dispose: 100_000, append_10: 100_000, append_100: 100_000, inc_100: 100_000, coalesced_100: 100_000, write_only: 200_000, raw_dispatch: 200_000 };
export const append_10 = (n) => run(n, 10, 'listAppend', list, append, false, items);
export const append_100 = (n) => run(n, 100, 'listAppend', list, append, false, items);
export const inc_100 = (n) => run(n, 100, 'countInc', zero, inc, false, count);
export const coalesced_100 = (n) => run(n, 100, 'countInc', zero, inc, true, count);
// A store method on a kept store (a build with useCommandState dispatches by name).
const keptMethod = legacy ? null : defineChamberStore('tick', { state: zero, reducers: { inc } })(bus);
export function method_call(n) { for (let i = 0; i < n; i++) { if (keptMethod === null) bus.dispatch('tallyInc', i); else keptMethod.inc(i); } return keptMethod === null ? keptState.value.n : keptMethod.state.value.n; }
// `$reset` on a kept store, a cold path (a build with useCommandState has no store: it dispatches by name).
export function reset_call(n) { for (let i = 0; i < n; i++) { if (keptMethod === null) bus.dispatch('tallyInc', i); else keptMethod.$reset(); } return keptMethod === null ? keptState.value.n : keptMethod.state.value.n; }
export function write_only(n) { for (let i = 0; i < n; i++) bus.dispatch('tallyInc', i); return keptState.value.n; }
export function create_dispose(n) {
  let s = 0;
  for (let i = 0; i < n; i++) {
    const scope = effectScope();
    scope.run(() => { const [state, dispose] = make('listAppend', list, append, false); s += state.value.items.length; dispose(); });
    scope.stop();
  }
  return s;
}
export function raw_dispatch(n) { let s = 0; for (let i = 0; i < n; i++) s += bus.dispatch('ping', i).value; return s; }
export const check = () => [create_dispose(10), append_10(10), append_100(10), inc_100(10), coalesced_100(10), raw_dispatch(10)];
