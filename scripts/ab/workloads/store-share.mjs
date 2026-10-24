// Workload for scripts/ab/ab.mjs: a store shared across tabs (log s35.129). Each arm shares
// over the wire its build has: `share: shareTabs()` where the build exports it (plan 1.32 step
// 4c), else a lane an app bridged with `createChannel`, the wiring that option took. Both post
// each write on a BroadcastChannel with no other tab open. A plain store is the control. Each
// channel is unref'd so the child exits; `window` marks a page, where shareTabs opens.
import * as root from '__DIST__/index.js';
import { createCommandBus } from '__DIST__/index.js';
import { createFastLane } from '__DIST__/fast-lane.js';
import { defineChamberStore } from '__DIST__/store.js';

const Channel = globalThis.BroadcastChannel;
globalThis.BroadcastChannel = class extends Channel { constructor(name) { super(name); this.unref(); } };
globalThis.window ??= {};

const reducers = { set: (s, n) => ({ n }) };
const share = (id) => {
  if (typeof root.shareTabs === 'function') return root.shareTabs(`ab:${id}`);
  const lane = createFastLane();
  root.createChannel({ channel: `ab:${id}`, lane, events: [`${id}$state`] });
  return lane;
};
const useShared = defineChamberStore('shared', { state: () => ({ n: 0 }), reducers, share: share('shared') });
const usePlain = defineChamberStore('plain', { state: () => ({ n: 0 }), reducers });
const shared = useShared(createCommandBus());
const plain = usePlain(createCommandBus());
// A shared store with a field subscriber: its send and its field events, one watcher (plan 1.32 4.2).
const useBoth = defineChamberStore('both', { state: () => ({ n: 0 }), reducers, share: share('both') });
const both = useBoth(createCommandBus());
let heard = 0;
both.$onField('n', (v) => { heard += v; });

const run = (store, n) => { let s = 0; for (let i = 0; i < n; i++) s += store.set(i).value.n; return s; };
export const N = { store_shared: 200_000, store_plain: 200_000, store_shared_field: 200_000 };
export const store_shared = (n) => run(shared, n);
export const store_plain = (n) => run(plain, n);
export const store_shared_field = (n) => run(both, n) + heard;
export const check = () => [run(shared, 8), run(plain, 8), run(both, 8) + heard];
