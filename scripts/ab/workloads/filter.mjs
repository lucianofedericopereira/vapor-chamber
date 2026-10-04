// Workload for scripts/ab/ab.mjs (perf-1.26 item c): the per-dispatch action filter of a
// scoped plugin. cache() whose patterns all miss, so the filter runs and the plugin
// passes the command on. 1 pattern vs 5: the gap between the rows is four filter
// steps, the positive control that the filter is on the measured path.
import { createCommandBus, cache } from '__DIST__/index.js';

function make(actions) {
  const bus = createCommandBus();
  bus.register('xRun', (cmd) => cmd.target + 1);
  bus.use(cache({ actions }));
  return bus;
}
const one = make(['aa*']);
const five = make(['aa*', 'bb*', 'cc*', 'dd*', 'eeExact']);
const run = (bus, n) => { let s = 0; for (let i = 0; i < n; i++) s += bus.dispatch('xRun', i).value; return s; };
export const N = { filter1_miss: 200_000, filter5_miss: 200_000 };
export const filter1_miss = (n) => run(one, n);
export const filter5_miss = (n) => run(five, n);
export const check = () => [run(one, 10), run(five, 10)];
