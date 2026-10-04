// Workload for scripts/ab/ab.mjs (log s35.134): what scoped plugins that do
// not match an action cost its dispatch (P1's premise).
import { cache, circuitBreaker, createCommandBus, metrics, rateLimit } from '__DIST__/index.js';

const bare = createCommandBus();
bare.register('x', (cmd) => cmd.target + 1);
const scoped = createCommandBus();
scoped.register('x', (cmd) => cmd.target + 1);
for (const p of [metrics, rateLimit, circuitBreaker, cache]) scoped.use(p({ actions: ['other*'] }));

const run = (bus, n) => { let s = 0; for (let i = 0; i < n; i++) s += bus.dispatch('x', i & 3).value; return s; };
export const N = { bare_dispatch: 400_000, four_scoped_miss: 200_000 };
export const bare_dispatch = (n) => run(bare, n);
export const four_scoped_miss = (n) => run(scoped, n);
