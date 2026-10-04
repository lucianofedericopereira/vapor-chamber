// Workload for scripts/ab/ab.mjs (perf-1.26, the creation regression and V-e): composable
// CREATION, where warnUnwired runs (tryAutoCleanup on every composable, useCommandQuery
// directly). useCommand alone, then a component-shaped mix: useCommand + useCommandQuery
// + useSharedCommandState created and disposed together in one effectScope, the way a
// component's setup() does. Wired through vapor-chamber/vue, as a correct app is.
import { effectScope } from 'vue';
import { setCommandBus, createCommandBus } from '__DIST__/index.js';
import { useCommand, useCommandQuery, useSharedCommandState } from '__DIST__/vue.js';

const bus = createCommandBus();
setCommandBus(bus);
bus.register('inc', (cmd) => cmd.payload + 1);

export const N = { create_useCommand: 50_000, create_component_mix: 30_000 };
export function create_useCommand(n) {
  let s = 0;
  for (let i = 0; i < n; i++) { const sc = effectScope(); const c = sc.run(() => useCommand()); s += c.loading.value ? 1 : 0; sc.stop(); }
  return s;
}
export function create_component_mix(n) {
  let s = 0;
  for (let i = 0; i < n; i++) {
    const sc = effectScope();
    const r = sc.run(() => ({ c: useCommand(), q: useCommandQuery(), sh: useSharedCommandState() }));
    s += (r.c.loading.value ? 1 : 0) + (r.q.loading.value ? 1 : 0) + r.sh.inFlight.value;
    sc.stop();
  }
  return s;
}
export const check = () => [create_useCommand(10), create_component_mix(10)];
