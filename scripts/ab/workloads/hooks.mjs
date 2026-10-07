// Workload for scripts/ab/ab.mjs (log s35.209): what a dispatch through the
// bus's hooks costs once removal during a dispatch is safe. Two before-hooks
// and two after-hooks, distinct functions (V8-RULES 11), on the sync bus; the
// bare bus is the control (an untouched path). A remove-and-add cycle is the
// rare path, which may pay.
import { createCommandBus } from '__DIST__/index.js';

let seen = 0;
const hooked = createCommandBus();
hooked.register('x', (cmd) => cmd.target + 1);
hooked.onBefore((cmd) => { seen += cmd.target & 1; });
hooked.onBefore((cmd) => { if (cmd.target < 0) throw new Error('never'); });
hooked.onAfter((_cmd, r) => { seen += r.ok ? 1 : 0; });
hooked.onAfter((cmd) => { seen ^= cmd.target; });

const bare = createCommandBus();
bare.register('x', (cmd) => cmd.target + 1);

const churn = createCommandBus();
churn.register('x', (cmd) => cmd.target + 1);
churn.onBefore(() => {});
const extra = () => {};

const run = (bus, n) => { let s = 0; for (let i = 0; i < n; i++) s += bus.dispatch('x', i & 3).value; return s + (seen & 1); };
const cycle = (n) => { let s = 0; for (let i = 0; i < n; i++) { const off = churn.onBefore(extra); s += churn.dispatch('x', i & 3).value; off(); } return s; };
export const N = { bare_dispatch: 400_000, hooks2_2: 200_000, hook_add_remove: 100_000 };
export const bare_dispatch = (n) => run(bare, n);
export const hooks2_2 = (n) => run(hooked, n);
export const hook_add_remove = (n) => cycle(n);
export const check = () => [run(bare, 8), cycle(8)];
