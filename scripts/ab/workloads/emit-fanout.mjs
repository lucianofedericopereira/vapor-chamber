// Workload for scripts/ab/ab.mjs (step 4 close, log 36.83): the three emit rows of
// tests/perf.bench.ts "fast lane - multi-subscriber emit fan-out" that read slower in one
// unpaired bench run against e0c7e86. The same shapes: three listeners, one event, the fast
// lane in its two removal modes and the bus's emit. The bare dispatch is the control (an
// untouched path for the lane, one read on the bus).
import { createCommandBus } from '__DIST__/index.js';
import { createFastLane } from '__DIST__/fast-lane.js';

let seen = 0;
const live = createFastLane();
const snapshot = createFastLane({ removal: 'snapshot' });
const bus = createCommandBus();
for (const target of [live, snapshot, bus]) {
  target.on('evt', (v) => { seen += v & 1; });
  target.on('evt', (v) => { seen ^= v; });
  target.on('evt', () => { seen++; });
}
const plain = createCommandBus();
plain.register('x', (cmd) => cmd.target + 1);

export const N = { lane_live: 400_000, lane_snapshot: 400_000, bus_emit3: 200_000, bare_dispatch: 400_000 };
export const lane_live = (n) => { for (let i = 0; i < n; i++) live.emit('evt', i); return seen; };
export const lane_snapshot = (n) => { for (let i = 0; i < n; i++) snapshot.emit('evt', i); return seen; };
export const bus_emit3 = (n) => { for (let i = 0; i < n; i++) bus.emit('evt', i); return seen; };
export const bare_dispatch = (n) => { let s = 0; for (let i = 0; i < n; i++) s += plain.dispatch('x', i & 3).value; return s; };
export const check = () => [lane_live(8), lane_snapshot(8), bus_emit3(8), bare_dispatch(8)];
