// Workload for scripts/ab/ab.mjs (perf-1.26 item d): where per-key isLoading tracking's
// cost goes. Same handler, same dispatch loop (4 targets cycling), five buses:
// bare; a no-op before-hook; a no-op '*' listener; both no-ops (the bus machinery
// tracking rides on); real tracking (useSharedCommandState + isLoading on one key).
// Run A against itself: the per-row A ns is the decomposition.
import { effectScope } from 'vue';
import { createCommandBus } from '__DIST__/index.js';
import { useSharedCommandState } from '__DIST__/vue.js';

function make(kind) {
  const bus = createCommandBus();
  bus.register('x', (cmd) => cmd.target + 1);
  if (kind === 'hook' || kind === 'both') bus.onBefore(() => {});
  if (kind === 'star' || kind === 'both') bus.on('*', () => {});
  if (kind === 'tracked') effectScope().run(() => useSharedCommandState({ bus }).isLoading('x', 1));
  return bus;
}
const buses = { bare: make('bare'), hook: make('hook'), star: make('star'), both: make('both'), tracked: make('tracked') };
const run = (bus, n) => { let s = 0; for (let i = 0; i < n; i++) s += bus.dispatch('x', i & 3).value; return s; };
export const N = { p0_bare: 200_000, p1_noop_hook: 200_000, p2_noop_star: 200_000, p3_noop_both: 200_000, p4_tracked: 200_000 };
export const p0_bare = (n) => run(buses.bare, n);
export const p1_noop_hook = (n) => run(buses.hook, n);
export const p2_noop_star = (n) => run(buses.star, n);
export const p3_noop_both = (n) => run(buses.both, n);
export const p4_tracked = (n) => run(buses.tracked, n);
export const check = () => Object.values(buses).map((b) => run(b, 8));
