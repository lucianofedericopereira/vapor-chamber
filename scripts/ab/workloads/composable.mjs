// Workload for scripts/ab/ab.mjs: the composable path (M-c arch E, M-g).
// useCommand() creation inside an effectScope, and useCommand().dispatch, on the
// SHARED bus (getCommandBus), plus a raw bus.dispatch as the in-bundle reference.
import { effectScope } from 'vue';
import { setCommandBus, createCommandBus } from '__DIST__/index.js';
import { useCommand } from '__DIST__/vue.js';

const bus = createCommandBus();
setCommandBus(bus);
bus.register('inc', (cmd) => cmd.payload + 1);
const cmd = effectScope().run(() => useCommand());

export const N = { raw_dispatch: 200_000, composable_dispatch: 200_000, composable_create: 50_000 };
export function raw_dispatch(n) { let s = 0; for (let i = 0; i < n; i++) s += bus.dispatch('inc', null, i).value; return s; }
export function composable_dispatch(n) { let s = 0; for (let i = 0; i < n; i++) s += cmd.dispatch('inc', null, i).value; return s; }
export function composable_create(n) {
  let s = 0;
  for (let i = 0; i < n; i++) { const sc = effectScope(); const c = sc.run(() => useCommand()); s += c.loading.value ? 1 : 0; sc.stop(); }
  return s;
}
export const check = () => [raw_dispatch(10), composable_dispatch(10), composable_create(10)];
