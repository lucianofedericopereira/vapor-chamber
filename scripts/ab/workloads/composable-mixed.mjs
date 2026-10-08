// Workload for scripts/ab/ab.mjs (log s35.237, the MIXED check for untracked()'s
// bracket): five composable paths through vapor-chamber/vapor, interleaved on one
// sync bus over four actions with distinct handlers, so the bracket runs from
// several call sites and shapes - the real-app shape composable.mjs lacks.
// `mixed_raw` dispatches the same sequence on the bus with no bracket: the control.
import { effectScope } from 'vue';
import {
  createCommandBus,
  defineVaporCommand,
  setCommandBus,
  useCommand,
  useCommandGroup,
  useCommandQuery,
  useSharedCommandState,
} from '__DIST__/vapor.js';

const bus = createCommandBus();
setCommandBus(bus);
bus.register('cartAdd', (cmd) => cmd.target + 1);
bus.register('payNow', (cmd) => cmd.target + 2);
bus.register('searchRun', (cmd) => cmd.target + 3);
bus.register('uiToggle', (cmd) => cmd.target + 4);
const c = effectScope().run(() => ({
  command: useCommand(),
  cart: useCommandGroup('cart'),
  shared: useSharedCommandState({ bus }),
  query: useCommandQuery(),
  ui: defineVaporCommand('uiPing', (cmd) => cmd.target + 5),
}));
const ACTIONS = ['cartAdd', 'payNow', 'searchRun', 'uiToggle'];

export const N = { mixed_vapor: 100_000, mixed_raw: 100_000 };
export function mixed_vapor(n) {
  let s = 0;
  for (let i = 0; i < n; i++) {
    switch (i % 5) {
      case 0: s += c.command.dispatch(ACTIONS[i & 3], i).value; break;
      case 1: s += c.cart.dispatch('add', i).value; break;
      case 2: s += c.shared.dispatch(ACTIONS[i & 3], i).value; break;
      case 3: s += c.query.query(ACTIONS[i & 3], i).value; break;
      default: s += c.ui.dispatch(i).value;
    }
  }
  return s;
}
export function mixed_raw(n) {
  let s = 0;
  for (let i = 0; i < n; i++) s += bus.dispatch(i % 5 === 1 ? 'cartAdd' : ACTIONS[i & 3], i).value;
  return s;
}
export const check = () => [mixed_vapor(10), mixed_raw(10)];
