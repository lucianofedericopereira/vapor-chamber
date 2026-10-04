// One process = one replicate of scripts/ab/ab.mjs (docs/V8-RULES.md rule 16).
// Loads the arm bundles in the given order, builds a timing loop PER ARM (its
// own function and feedback, so the harness call site never sees both arms),
// and for each workload function with its pinned n: warm-up, one full gc, more
// warm-up, then `rounds` rounds alternating which arm goes first, a MINOR gc
// before every timed call. Prints JSON on stdout.
//
// Why a minor gc and not gc(): a full gc evicts the timing loop's OSR code, so
// every timed call recompiled it (a Maglev then a TurboFan OSR, 0.7 + 1.5 ms on
// the compiler threads) and its first part ran in lower tiers; that compile
// was most of the background CPU and made a ratio depend on flags and on the
// call length. A scavenge only empties new space (`--trace-osr`, log s35.48).
// One full gc per function, after warm-up, so both arms' rounds start from one
// collected heap; two more warm-up calls per arm follow it before the rounds.
//
// Per call, outside the hrtime window: main-thread CPU (threadCpuUsage),
// process CPU (cpuUsage, every thread) and a GCProfiler (each read costs
// 0.2-0.8 us and 1.5 us, log s35.45), so the timed window is hrtime around
// f(n) alone. A workload exporting `ASYNC = true` gets the same loop awaiting
// f(n), so the window closes when its promise settles; a sync one is unchanged.
'use strict';
const { GCProfiler } = require('node:v8');
const { mkLoop } = require('./loop.cjs');

const cfg = JSON.parse(process.argv[2]);
const arms = cfg.order.map((k) => ({ k, mod: require(cfg.bundles[k]) }));
for (const a of arms) a.loop = mkLoop(a.mod.ASYNC === true);
const minor = () => global.gc({ type: 'minor' });

(async () => {
// Sizing mode: ns per iteration of the first arm on a WARM call, per function.
if (cfg.size) {
  const out = {};
  for (const fn of Object.keys(arms[0].mod.N)) {
    const a = arms[0];
    const probe = Math.max(1000, a.mod.N[fn] >> 4);
    for (let w = 0; w < 3; w++) { minor(); await a.loop(a.mod[fn], probe, GCProfiler); }
    const xs = [];
    for (let w = 0; w < 5; w++) { minor(); xs.push((await a.loop(a.mod[fn], probe, GCProfiler))[0]); }
    out[fn] = xs.sort((x, y) => x - y)[2];
  }
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}

const out = { order: cfg.order, fns: {} };
let sink = 0;
for (const fn of Object.keys(arms[0].mod.N)) {
  if (cfg.only && !cfg.only.includes(fn)) continue;
  const n = cfg.n[fn];
  for (let w = 0; w < 3; w++) for (const a of arms) { minor(); await a.loop(a.mod[fn], n, GCProfiler); }
  global.gc();
  for (let w = 0; w < 2; w++) for (const a of arms) { minor(); await a.loop(a.mod[fn], n, GCProfiler); }
  const rec = Object.fromEntries(arms.map((a) => [a.k, { wall: [], cpu: [], thr: [], gc: [] }]));
  for (let r = 0; r < cfg.rounds; r++) {
    for (const a of r % 2 ? [...arms].reverse() : arms) {
      minor();
      const [wall, cpu, thr, gc, v] = await a.loop(a.mod[fn], n, GCProfiler);
      const x = rec[a.k];
      x.wall.push(wall);
      x.cpu.push(cpu);
      x.thr.push(thr);
      x.gc.push(gc);
      sink += typeof v === 'number' ? v : 1;
    }
  }
  out.fns[fn] = { n, ...rec };
}
out.sink = sink;
process.stdout.write(JSON.stringify(out));
})();
