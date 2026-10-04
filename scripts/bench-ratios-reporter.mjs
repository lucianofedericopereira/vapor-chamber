/**
 * vapor-chamber - vitest reporter that records BENCH RATIOS, nothing else.
 *
 * WHY THIS EXISTS. `docs/migrating/from-event-emitter.md` carried four peer
 * comparisons typed by hand, and its own text admitted the hazard: "unlike the
 * size and coverage figures they have no generator behind them, so re-run the
 * bench before trusting them after a hot-path change". Two of the four had
 * drifted by the rc.7 cycle: one described a gap about twice the one it
 * measured, the other parity where it measured a 6-8% lead. Exactly the
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
 * Even a same-run ratio moves between runs, and one between two libraries
 * moves with the host, Node and the peer's version (docs/V8-RULES.md rule
 * 15). So this reporter only RECORDS one run, under `benchRun` in
 * `docs/metrics.json`; `scripts/bench-bands.mjs` runs the bench N times and
 * writes the stamped block, `bench` (median for own ratios, min-max for peer
 * ones). A plain `npm run bench` moves no marker.
 *
 * NOT COMMITTED, for the same reason as the test counts it writes beside:
 * `docs/metrics.json` is gitignored, and `stamp-docs` SKIPS markers whose
 * source is absent. So a fresh checkout and CI leave these markers at whatever
 * the doc already says, and only someone who ran `npm run bench:bands`
 * locally can move them.
 *
 * Adding a comparison: put it in RATIOS below. Both sides must be bench names
 * from the SAME describe block, or the cancellation argument above does not
 * hold.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { asciiTable } from './ascii-table.mjs';

const OUT = 'docs/metrics.json';

/**
 * marker name -> { group, fast, slow, kind }. The value is `fast.hz /
 * slow.hz`, so every number reads as "N times the slow row". `group` is the
 * describe block both rows sit in (exact title), `fast` and `slow` the exact
 * bench titles; `tests/bench-ratios.test.ts` fails when a row or a group here
 * is missing from `tests/perf.bench.ts`.
 *
 * `kind` decides how `scripts/bench-bands.mjs` publishes the ratio over N runs.
 * `own`: both rows run this library's code (or the bare-call floor), so the
 * host mostly cancels; published as the median. `peer`: one row is another
 * library, and the ratio moved with no code change here (docs/V8-RULES.md rule
 * 15: fast lane vs mitt 2.33 stamped, 1.79-1.92 five runs later); published
 * as the min-max band, with the Node and peer versions beside it.
 */
export const RATIOS = {
  benchFastLaneVsMitt: {
    group: 'fast lane - multi-subscriber emit fan-out (10k events x 3 listeners)',
    fast: 'vapor-chamber fast-lane emit (live, default)',
    slow: 'mitt - 3 listeners (peer)',
    kind: 'peer',
  },
  benchFastLaneVsEventEmitter3: {
    group: 'fast lane - multi-subscriber emit fan-out (10k events x 3 listeners)',
    fast: 'vapor-chamber fast-lane emit (live, default)',
    slow: 'eventemitter3 - 3 listeners (peer)',
    kind: 'peer',
  },
  benchEmitVsMittFanout: {
    group: 'comparative emit fan-out (10k events x 3 listeners)',
    fast: 'vapor-chamber bus.emit - 3 listeners',
    slow: 'mitt - 3 listeners',
    kind: 'peer',
  },
  benchEmitVsEventEmitter3Fanout: {
    group: 'comparative emit fan-out (10k events x 3 listeners)',
    fast: 'vapor-chamber bus.emit - 3 listeners',
    slow: 'eventemitter3 - 3 listeners',
    kind: 'peer',
  },
  benchMittEmitVsDispatch: {
    group: 'comparative dispatch (10k dispatches, single handler)',
    fast: 'mitt - emit (bus.emit equivalent, no result)',
    slow: 'vapor-chamber bus.dispatch - bare handler, no plugins',
    kind: 'peer',
  },
  // The ratios below were hand-typed in docs/performance.md and ROADMAP.md,
  // and drifted (the floor table still said 207x after v1.16 moved dispatch
  // to ~140x). Each is two rows of the same run, so it follows the bench.
  benchCompileVsMitt: {
    group: 'fast lane - single-handler hot dispatch (10k)',
    fast: 'vapor-chamber fast-lane compile + dispatch',
    slow: 'mitt (closest peer - emit fires listeners, no return)',
    kind: 'peer',
  },
  benchCompileVsDispatch: {
    group: 'fast lane - single-handler hot dispatch (10k)',
    fast: 'vapor-chamber fast-lane compile + dispatch',
    slow: 'vapor-chamber bus.dispatch (general-purpose, for comparison)',
    kind: 'own',
  },
  benchFloorVsCompile: {
    group: 'fast lane - single-handler hot dispatch (10k)',
    fast: 'direct function call (theoretical floor)',
    slow: 'vapor-chamber fast-lane compile + dispatch',
    kind: 'own',
  },
  benchFloorVsMitt: {
    group: 'fast lane - single-handler hot dispatch (10k)',
    fast: 'direct function call (theoretical floor)',
    slow: 'mitt (closest peer - emit fires listeners, no return)',
    kind: 'peer',
  },
  benchFloorVsDispatch: {
    group: 'fast lane - single-handler hot dispatch (10k)',
    fast: 'direct function call (theoretical floor)',
    slow: 'vapor-chamber bus.dispatch (general-purpose, for comparison)',
    kind: 'own',
  },
  benchEmitNoListenersVsMitt: {
    group: 'emit fast path - no listeners',
    fast: 'vapor-chamber bus.emit with NO listeners (10k)',
    slow: 'mitt with NO listeners (10k)',
    kind: 'peer',
  },
  benchEmitVsDispatchFanout: {
    group: 'listener fan-out',
    fast: 'emit with 50 exact-match listeners + 5 wildcards',
    slow: 'dispatch with 50 exact-match listeners + 5 wildcards',
    kind: 'own',
  },
  benchUidCounterVsUuid: {
    group: 'meta overhead - uid generator comparison',
    fast: 'dispatch - default counter-based uid',
    slow: 'dispatch - crypto.randomUUID via configureUid',
    kind: 'own',
  },
  benchPersistCoalesce: {
    group: 'persist plugin throughput',
    fast: '100 rapid dispatches with persist enabled + coalesce (50-item array state)',
    slow: '100 rapid dispatches with persist enabled (50-item array state)',
    kind: 'own',
  },
};

/** This run's ratios from a bench title -> hz map; a ratio with a row missing is left out. */
export function ratiosOf(hz) {
  const out = {};
  for (const [name, { fast, slow }] of Object.entries(RATIOS)) {
    const a = hz.get(fast);
    const b = hz.get(slow);
    if (typeof a === 'number' && typeof b === 'number' && b > 0) out[name] = (a / b).toFixed(2);
  }
  return out;
}

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

/**
 * Vitest 5: a bench is no longer a test. Benches run inside one through
 * `bench.compare()`, and a reporter reads them from the public
 * `TestCase.benchmarks()` - one entry per compare, one task per bench, named as
 * registered. The hz column Vitest prints is `task.throughput.mean` (its
 * `renderBenchmarkRow`), so that is the number divided here, and a ratio stays
 * the one a reader can recompute from the table. `fromStore` rows are baselines
 * loaded by `bench.from()`, not measurements of this run: skipped, because a
 * ratio against one would break the same-run cancellation above.
 */
function collectBenchmarks(test, into) {
  for (const benchmark of test?.benchmarks?.() ?? []) {
    for (const task of benchmark?.tasks ?? []) {
      const hz = task?.throughput?.mean;
      if (task?.fromStore || !task?.name || typeof hz !== 'number' || !Number.isFinite(hz)) continue;
      into.set(task.name, hz);
    }
  }
}

function collect(modules, into) {
  for (const mod of modules ?? []) {
    for (const test of mod?.children?.allTests?.() ?? []) {
      const hz = hzOf(test);
      if (hz !== null && test?.name) into.set(test.name, hz);
      collectBenchmarks(test, into);
    }
  }
  return into;
}

function write(run) {
  let existing = {};
  if (existsSync(OUT)) {
    try {
      existing = JSON.parse(readFileSync(OUT, 'utf8'));
    } catch {
      existing = {};
    }
  }
  // `benchRun` is this run alone, replaced each run: `scripts/bench-bands.mjs`
  // reads one per run. The stamped block, `bench`, is never written here, so a
  // single run cannot overwrite a band with one draw.
  const next = { ...existing, benchRun: run };
  const ordered = Object.fromEntries(Object.keys(next).sort().map((k) => [k, next[k]]));
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(ordered, null, 2)}\n`);
}

// Splits a marker name into its two operands: benchFloorVsCompile -> Floor / Compile.
function label(name) {
  const [fast, slow] = name.replace(/^bench/, '').split(/Vs/);
  const spaced = (s) => (s ?? '').replace(/([a-z])([A-Z])/g, '$1 $2');
  return slow ? [spaced(fast), spaced(slow)] : [spaced(fast), ''];
}

const hzFmt = (n) => (typeof n === 'number' ? n.toLocaleString('en-US', { maximumFractionDigits: 0 }) : '');

function report(bench, hz) {
  const rows = Object.entries(bench).map(([name, ratio]) => {
    const [fast, slow] = label(name);
    const { fast: fastRow, slow: slowRow, kind } = RATIOS[name];
    return {
      Comparison: slow ? `${fast} vs ${slow}` : fast,
      Kind: kind,
      'hz (fast)': hzFmt(hz.get(fastRow)),
      'hz (slow)': hzFmt(hz.get(slowRow)),
      Ratio: `${ratio}x`,
    };
  });
  const missing = Object.keys(RATIOS).length - rows.length;
  const footer = missing > 0
    ? `${rows.length} of ${Object.keys(RATIOS).length} recorded - ${missing} bench row(s) not found`
    : `${rows.length} ratios recorded to ${OUT} (benchRun); npm run bench:bands publishes`;
  console.log(`\n${asciiTable(rows, 'Bench ratios', { footer })}\n`);
}

export default class BenchRatiosReporter {
  onTestRunEnd(modules) {
    const hz = collect(modules, new Map());
    if (hz.size === 0) return; // not a bench run, or an unreadable result shape

    // A missing row means the bench was renamed or filtered out: that ratio is
    // left out of the run, so it gains no wrong value.
    const bench = ratiosOf(hz);
    if (Object.keys(bench).length === 0) return;
    write(bench);
    report(bench, hz);
  }
}
