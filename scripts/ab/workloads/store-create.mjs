// Workload for scripts/ab/ab.mjs (.probes/fixup-1-7-pickup.md, 2a-0): a store's creation and
// disposal, the path the state half (`_stateHalf`) moved. Rows: create_plain, a core store with
// no option; create_field, the same with one field subscriber (the field lane and the
// watcher); dispatch_control, an action of a store made once (a path the change does not
// run, which should read 1.000). Ids vary, as an app's stores do.
import { createCommandBus } from '__DIST__/index.js';
import { defineChamberStore } from '__DIST__/store/core.js';

const ids = ['cart', 'user', 'prefs', 'flags'];
const defs = ids.map((id) => defineChamberStore(id, { state: () => ({ n: 0, items: [] }), reducers: { inc: (s) => ({ ...s, n: s.n + 1 }) } }));
const bus = createCommandBus();
let seen = 0;
const onN = (v) => { seen += v; };

const control = defineChamberStore('control', { state: () => ({ n: 0 }), reducers: { inc: (s) => ({ n: s.n + 1 }) } })(createCommandBus());

export const N = { create_plain: 20_000, create_field: 20_000, dispatch_control: 100_000 };
export const create_plain = (n) => {
  let s = 0;
  for (let i = 0; i < n; i++) { const st = defs[i & 3](bus); s += st.state.value.n; st.$dispose(); }
  return s;
};
export const create_field = (n) => {
  let s = 0;
  for (let i = 0; i < n; i++) { const st = defs[i & 3](bus); st.$onField('n', onN); s += st.state.value.n; st.$dispose(); }
  return s;
};
export const dispatch_control = (n) => { for (let i = 0; i < n; i++) control.inc(); return control.state.value.n; };

/** Self-check: a created store reads its state, a field subscriber hears a write, and a disposed id is free. */
export const check = () => {
  const st = defs[0](bus);
  st.$onField('n', onN);
  st.inc();
  const heard = seen;
  st.$dispose();
  const again = defs[0](bus);
  const fresh = again.state.value.n;
  again.$dispose();
  if (heard !== 1 || fresh !== 0) throw new Error(`heard ${heard} fresh ${fresh}, want 1 0`);
  return [create_plain(4), create_field(4), dispatch_control(2)];
};
