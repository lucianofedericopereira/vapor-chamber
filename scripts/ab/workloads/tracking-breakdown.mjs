// Workload for scripts/ab/ab.mjs (log s35.142): where armed loading tracking's
// cost goes. Each row arms one more piece; differences between rows split it.
import { effectScope } from 'vue';
import { createCommandBus } from '__DIST__/index.js';
import { useSharedCommandState } from '__DIST__/vue.js';

const make = () => { const b = createCommandBus(); b.register('x', (cmd) => cmd.target + 1); return b; };
const bare = make();
const listenerOnly = make();
listenerOnly.on('*', () => {});
const listenerHook = make();
listenerHook.on('*', () => {});
listenerHook.onBefore(() => {});
const sharedUnarmed = make();
effectScope().run(() => useSharedCommandState({ bus: sharedUnarmed }));
const sharedArmed = make();
effectScope().run(() => useSharedCommandState({ bus: sharedArmed })).isLoading('x', 1);

const run = (bus, n) => { let s = 0; for (let i = 0; i < n; i++) s += bus.dispatch('x', i & 3).value; return s; };
export const N = { bare: 400_000, listener_only: 200_000, listener_hook: 200_000, shared_unarmed: 200_000, shared_armed: 200_000 };
export const bare_ = (n) => run(bare, n);
export { bare_ as bare };
export const listener_only = (n) => run(listenerOnly, n);
export const listener_hook = (n) => run(listenerHook, n);
export const shared_unarmed = (n) => run(sharedUnarmed, n);
export const shared_armed = (n) => run(sharedArmed, n);
