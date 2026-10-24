// Workload for scripts/ab/ab.mjs (log s35.142): what armed per-key loading
// tracking (useSharedCommandState().isLoading) costs a dispatch (P3's premise).
import { effectScope } from 'vue';
import { createCommandBus } from '__DIST__/index.js';
import { useSharedCommandState } from '__DIST__/vue.js';
// Arms one key: `pending` from 1.32 step 5, `isLoading` in the base arm.
const armKey = (s, a, t) => (s.pending ?? s.isLoading)(a, t);

const bare = createCommandBus();
bare.register('x', (cmd) => cmd.target + 1);

const tracked = createCommandBus();
tracked.register('x', (cmd) => cmd.target + 1);
const shared = effectScope().run(() => useSharedCommandState({ bus: tracked }));
armKey(shared, 'x', 1);

const run = (bus, n) => { let s = 0; for (let i = 0; i < n; i++) s += bus.dispatch('x', i & 3).value; return s; };
const runQuery = (bus, n) => { let s = 0; for (let i = 0; i < n; i++) s += bus.query('x', i & 3).value; return s; };
export const N = { bare_dispatch: 400_000, bare_query: 400_000, tracked_dispatch: 200_000, tracked_query: 200_000 };
export const bare_dispatch = (n) => run(bare, n);
// A query on a bare bus: its own fast path (the step 8 close bench read it 0.865 unpaired, a lead).
export const bare_query = (n) => runQuery(bare, n);
export const tracked_dispatch = (n) => run(tracked, n);
// A query on a tracked bus: the command state hears its settle, never a counted start (1.32 step 8b).
export const tracked_query = (n) => runQuery(tracked, n);
