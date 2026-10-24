// Workload for scripts/ab/ab.mjs (log s35.209): what a dispatch through the
// bus's hooks costs once removal during a dispatch is safe. Two before-hooks
// and two after-hooks, distinct functions (V8-RULES 11), on the sync bus; the
// bare bus is the control (an untouched path). A remove-and-add cycle is the
// rare path, which may pay. The churn row adds and removes an after-hook (the
// before-hook it once cycled left in 1.32 step 8e).
import { createCommandBus } from '__DIST__/index.js';

// A before-hook on the base arm; from 1.32 step 8e its replacement: an observer is a
// `started` part, a gate an `authorize` rule.
const observe = (bus, fn) => (bus.onBefore ? bus.onBefore(fn) : bus.use({ started: fn }));
const gate = (bus, refuses) => (bus.onBefore
  ? bus.onBefore((cmd) => { if (refuses(cmd)) throw new Error('never'); })
  : bus.use({ authorize: () => (cmd) => (refuses(cmd) ? { ok: false, value: undefined, error: new Error('never') } : undefined) }));

let seen = 0;
const hooked = createCommandBus();
hooked.register('x', (cmd) => cmd.target + 1);
observe(hooked, (cmd) => { seen += cmd.target & 1; });
gate(hooked, (cmd) => cmd.target < 0);
hooked.onAfter((_cmd, r) => { seen += r.ok ? 1 : 0; });
hooked.onAfter((cmd) => { seen ^= cmd.target; });

const bare = createCommandBus();
bare.register('x', (cmd) => cmd.target + 1);

const churn = createCommandBus();
churn.register('x', (cmd) => cmd.target + 1);
churn.onAfter(() => {});
const extra = () => {};

const run = (bus, n) => { let s = 0; for (let i = 0; i < n; i++) s += bus.dispatch('x', i & 3).value; return s + (seen & 1); };
const cycle = (n) => { let s = 0; for (let i = 0; i < n; i++) { const off = churn.onAfter(extra); s += churn.dispatch('x', i & 3).value; off(); } return s; };
// A listener subscribed and removed around each dispatch: from 1.32 step 8f each change
// clears the action records, so this row pays a record rebuild per dispatch.
const listening = createCommandBus();
listening.register('x', (cmd) => cmd.target + 1);
listening.on('*', () => {});
const listenOnce = () => {};
const churnListeners = (n) => { let s = 0; for (let i = 0; i < n; i++) { const off = listening.on('x', listenOnce); s += listening.dispatch('x', i & 3).value; off(); } return s; };
export const N = { bare_dispatch: 400_000, hooks2_2: 200_000, hook_add_remove: 100_000, listener_churn: 100_000 };
export const listener_churn = (n) => churnListeners(n);
export const bare_dispatch = (n) => run(bare, n);
export const hooks2_2 = (n) => run(hooked, n);
export const hook_add_remove = (n) => cycle(n);
export const check = () => [run(bare, 8), cycle(8)];
