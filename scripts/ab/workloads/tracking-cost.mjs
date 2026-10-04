// Workload for scripts/ab/ab.mjs (log s35.142): what armed per-key loading
// tracking (useSharedCommandState().isLoading) costs a dispatch (P3's premise).
import { effectScope } from 'vue';
import { createCommandBus } from '__DIST__/index.js';
import { useSharedCommandState } from '__DIST__/vue.js';

const bare = createCommandBus();
bare.register('x', (cmd) => cmd.target + 1);

const tracked = createCommandBus();
tracked.register('x', (cmd) => cmd.target + 1);
const shared = effectScope().run(() => useSharedCommandState({ bus: tracked }));
shared.isLoading('x', 1);

const run = (bus, n) => { let s = 0; for (let i = 0; i < n; i++) s += bus.dispatch('x', i & 3).value; return s; };
export const N = { bare_dispatch: 400_000, tracked_dispatch: 200_000 };
export const bare_dispatch = (n) => run(bare, n);
export const tracked_dispatch = (n) => run(tracked, n);
