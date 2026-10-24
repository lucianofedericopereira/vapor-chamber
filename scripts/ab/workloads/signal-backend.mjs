// Workload for scripts/ab/ab.mjs (D2, decisions 2026-10-13): signal() on shallowRef against ref, on
// the real dispatch path, a handler writing a signal() per dispatch, the cases of
// tests/signal-shallow-ab.test.ts. Arm A is the
// shipped build; arm B the same source with `configureSignal(vue.ref ?? vue.shallowRef)` in
// src/chamber.ts and `vue.ref` preferred in src/signal.ts, built with `npm run build`.
// One iteration is one dispatch; a fresh state every `per` dispatches.
// `raw_dispatch` never touches a signal: the known control, expected 1.000.
import { effectScope } from 'vue';
import { createCommandBus, setCommandBus, signal } from '__DIST__/vue.js';

const bus = createCommandBus();
setCommandBus(bus);
bus.register('ping', (cmd) => cmd.target + 1);

function run(n, per, initial, handlers, action) {
  let s = 0;
  let i = 0;
  while (i < n) {
    const scope = effectScope();
    scope.run(() => {
      const state = signal(initial);
      const off = bus.register(action, (cmd) => (state.value = handlers[action](state.value, cmd)));
      for (let j = 0; j < per && i < n; j++, i++) bus.dispatch(action, i);
      s += typeof state.value === 'number' ? state.value : state.value.length;
      off();
    });
    scope.stop();
  }
  return s;
}

const append = { append: (s, cmd) => [...s, cmd.target] };
const inc = { inc: (s) => s + 1 };

export const N = { array_append_100: 100_000, array_append_10: 100_000, scalar_inc_100: 100_000, raw_dispatch: 200_000 };
export function array_append_100(n) { return run(n, 100, [], append, 'append'); }
export function array_append_10(n) { return run(n, 10, [], append, 'append'); }
export function scalar_inc_100(n) { return run(n, 100, 0, inc, 'inc'); }
export function raw_dispatch(n) { let s = 0; for (let i = 0; i < n; i++) s += bus.dispatch('ping', i).value; return s; }
export const check = () => [array_append_100(10), array_append_10(10), scalar_inc_100(10), raw_dispatch(10)];
