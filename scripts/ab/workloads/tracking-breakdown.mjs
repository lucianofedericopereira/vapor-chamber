// Workload for scripts/ab/ab.mjs (log s35.142): where armed loading tracking's
// cost goes. Each row arms one more piece; differences between rows split it.
import { effectScope } from 'vue';
import { createCommandBus } from '__DIST__/index.js';
import { useSharedCommandState } from '__DIST__/vue.js';
// Arms one key: `pending` from 1.32 step 5, `isLoading` in the base arm.
const armKey = (s, a, t) => (s.pending ?? s.isLoading)(a, t);

const make = () => { const b = createCommandBus(); b.register('x', (cmd) => cmd.target + 1); return b; };
const bare = make();
const listenerOnly = make();
listenerOnly.on('*', () => {});
const listenerHook = make();
listenerHook.on('*', () => {});
// A no-op before-hook on the base arm, a no-op started part from 1.32 step 8e.
if (listenerHook.onBefore) listenerHook.onBefore(() => {}); else listenerHook.use({ started: () => {} });
const sharedUnarmed = make();
effectScope().run(() => useSharedCommandState({ bus: sharedUnarmed }));
const sharedArmed = make();
armKey(effectScope().run(() => useSharedCommandState({ bus: sharedArmed })), 'x', 1);

const run = (bus, n) => { let s = 0; for (let i = 0; i < n; i++) s += bus.dispatch('x', i & 3).value; return s; };
export const N = { bare: 400_000, listener_only: 200_000, listener_hook: 200_000, shared_unarmed: 200_000, shared_armed: 200_000 };
export const bare_ = (n) => run(bare, n);
export { bare_ as bare };
export const listener_only = (n) => run(listenerOnly, n);
export const listener_hook = (n) => run(listenerHook, n);
export const shared_unarmed = (n) => run(sharedUnarmed, n);
export const shared_armed = (n) => run(sharedArmed, n);
