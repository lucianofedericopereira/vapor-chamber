/**
 * vapor-chamber - vitest reporter that records BENCH RATIOS, nothing else.
 *
 * WHY THIS EXISTS. `docs/migrating/from-event-emitter.md` carried four peer
 * comparisons typed by hand, and its own text admitted the hazard: "unlike the
 * size and coverage figures they have no generator behind them, so re-run the
 * bench before trusting them after a hot-path change". Two of the four had
 * drifted by the rc.7 cycle - the default fast lane was described as "~10-15%
 * behind" nanoevents when it measures ~4-5% behind, and `removal: 'snapshot'`
 * as "at parity (~0.9-1.0x)" when it measures ~1.06-1.08x AHEAD. Exactly the
 * failure `stamp-docs.mjs` exists to prevent, in the one corner it could not
 * reach: it can only own a value some file the repo produces already states,
 * and bench output went to stdout and a CI artifact.
 *
 * RATIOS, NEVER ABSOLUTES. A hz figure is host state - this repo's own bench
 * header records rows swinging 20-30% run to run on a shared machine, and
 * `scripts/ab-vue.mjs` exists because cross-run absolutes are not a
 * measurement. A ratio between two rows of the SAME run cancels the host out,
 * which is why only ratios are written here and why the docs quote them.
 *
 * NOT COMMITTED, for the same reason as the test counts it writes beside:
 * `docs/metrics.json` is gitignored, and `stamp-docs` SKIPS markers whose
 * source is absent. So a fresh checkout and CI leave these markers at whatever
 * the doc already says, and only someone who actually ran `npm run bench`
 * locally can move them.
 *
 * Adding a comparison: put it in RATIOS below. Both sides must be bench names
 * from the SAME describe block, or the cancellation argument above does not
 * hold.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const OUT = 'docs/metrics.json';

/**
 * marker name -> [faster row, slower row]. The value stamped is
 * `faster.hz / slower.hz`, so every number reads as "N times the peer".
 * Names are matched by exact bench title.
 */
const RATIOS = {
  benchFastLaneVsMitt: [
    'vapor-chamber fast-lane emit (live, default)',
    'mitt - 3 listeners (peer)',
  ],
  benchFastLaneVsNano: [
    'vapor-chamber fast-lane emit (live, default)',
    'nanoevents - 3 listeners (peer)',
  ],
  benchFastLaneSnapshotVsNano: [
    "vapor-chamber fast-lane emit (removal: 'snapshot')",
    'nanoevents - 3 listeners (peer)',
  ],
  benchCompileVsNano: [
    'vapor-chamber fast-lane compile + dispatch',
    'nanoevents (closest peer - emit fires listeners, no return)',
  ],
  // The ratios below were hand-typed in docs/performance.md and ROADMAP.md,
  // and drifted (the floor table still said 207x after v1.16 moved dispatch
  // to ~140x). Each is two rows of the same run, so it follows the bench.
  benchCompileVsMitt: [
    'vapor-chamber fast-lane compile + dispatch',
    'mitt (closest peer - emit fires listeners, no return)',
  ],
  benchCompileVsDispatch: [
    'vapor-chamber fast-lane compile + dispatch',
    'vapor-chamber bus.dispatch (general-purpose, for comparison)',
  ],
  benchFloorVsCompile: [
    'direct function call (theoretical floor)',
    'vapor-chamber fast-lane compile + dispatch',
  ],
  benchFloorVsNano: [
    'direct function call (theoretical floor)',
    'nanoevents (closest peer - emit fires listeners, no return)',
  ],
  benchFloorVsMitt: [
    'direct function call (theoretical floor)',
    'mitt (closest peer - emit fires listeners, no return)',
  ],
  benchFloorVsDispatch: [
    'direct function call (theoretical floor)',
    'vapor-chamber bus.dispatch (general-purpose, for comparison)',
  ],
  benchEmitNoListenersVsMitt: [
    'vapor-chamber bus.emit with NO listeners (10k)',
    'mitt with NO listeners (10k)',
  ],
  benchNanoVsEmitNoListeners: [
    'nanoevents with NO listeners (10k)',
    'vapor-chamber bus.emit with NO listeners (10k)',
  ],
  benchNanoVsMittNoListeners: [
    'nanoevents with NO listeners (10k)',
    'mitt with NO listeners (10k)',
  ],
  benchEmitVsDispatchFanout: [
    'emit with 50 exact-match listeners + 5 wildcards',
    'dispatch with 50 exact-match listeners + 5 wildcards',
  ],
  benchUidCounterVsUuid: [
    'dispatch - default counter-based uid',
    'dispatch - crypto.randomUUID via configureUid',
  ],
  benchPersistCoalesce: [
    '100 rapid dispatches with persist enabled + coalesce (50-item array state)',
    '100 rapid dispatches with persist enabled (50-item array state)',
  ],
};

/**
 * Where the hz actually lives, verified by probing rather than assumed.
 *
 * Vitest 4's Reported Task API deliberately narrows what a reporter sees:
 * `test.result()` carries `{ state, errors }` and `test.meta()` carries
 * `{ benchmark: true }` - a FLAG, not the measurement. The numbers sit on the
 * raw task behind it (`result.benchmark.hz`), reached through whichever handle
 * this version exposes. Every step is optional-chained: a shape we cannot read
 * yields no ratio, which leaves the marker at its previous value instead of
 * stamping a wrong one.
 */
function hzOf(reported) {
  const raw = reported?.task ?? reported?._task ?? reported?.internal;
  const hz = raw?.result?.benchmark?.hz;
  return typeof hz === 'number' && Number.isFinite(hz) ? hz : null;
}

function collect(modules, into) {
  for (const mod of modules ?? []) {
    for (const test of mod?.children?.allTests?.() ?? []) {
      const hz = hzOf(test);
      if (hz !== null && test?.name) into.set(test.name, hz);
    }
  }
  return into;
}

function write(bench) {
  let existing = {};
  if (existsSync(OUT)) {
    try {
      existing = JSON.parse(readFileSync(OUT, 'utf8'));
    } catch {
      existing = {};
    }
  }
  const next = { ...existing, bench };
  const ordered = Object.fromEntries(Object.keys(next).sort().map((k) => [k, next[k]]));
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(ordered, null, 2)}\n`);
}

export default class BenchRatiosReporter {
  onTestRunEnd(modules) {
    const hz = collect(modules, new Map());
    if (hz.size === 0) return; // not a bench run, or an unreadable result shape

    const bench = {};
    for (const [name, [fast, slow]] of Object.entries(RATIOS)) {
      const a = hz.get(fast);
      const b = hz.get(slow);
      // A missing row means the bench was renamed or filtered out. Skip it, so
      // the marker keeps its previous value instead of gaining a wrong one.
      if (typeof a === 'number' && typeof b === 'number' && b > 0) {
        bench[name] = (a / b).toFixed(2);
      }
    }
    if (Object.keys(bench).length > 0) write(bench);
  }
}
