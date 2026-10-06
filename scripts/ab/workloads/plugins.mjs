// Workload for scripts/ab/ab.mjs: dispatch through id-carrying plugins (ext 13) and
// through armed per-key tracking with an outcome slot (ext 5).
// Three DISTINCT plugin functions per level (V8-RULES 10): logger(filtered out),
// cache(no-op actions), metrics. Async-only plugins are left out (sync bus).
import { effectScope } from 'vue';
import { createCommandBus } from '__DIST__/index.js';
import { logger, metrics, cache } from '__DIST__/index.js';
import { useSharedCommandState } from '__DIST__/vue.js';

const chain = createCommandBus();
chain.register('x', (cmd) => cmd.target + 1);
chain.use(logger({ filter: () => false }));
chain.use(cache({ actions: ['never*'] }));
chain.use(metrics({ maxSize: 8 }));
chain.on('x', () => {});

const tracked = createCommandBus();
tracked.register('x', (cmd) => cmd.target + 1);
const scope = effectScope();
const shared = scope.run(() => useSharedCommandState({ bus: tracked }));
shared.isLoading('x', 1);
if (typeof shared.outcome === 'function') shared.outcome('x', 2);

const run = (bus, n) => { let s = 0; for (let i = 0; i < n; i++) s += bus.dispatch('x', i & 3).value; return s; };
export const N = { plugins3_listener1: 200_000, tracked_mixed_keys: 200_000 };
export const plugins3_listener1 = (n) => run(chain, n);
export const tracked_mixed_keys = (n) => run(tracked, n);
export const check = () => [run(chain, 8), run(tracked, 8)];
