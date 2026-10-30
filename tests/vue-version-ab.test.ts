// @vitest-environment happy-dom
/**
 * Same-process A/B of two Vue primitives the library sits on (scope create/dispose, shallowRef writes): the installed Vue against a baseline version.
 * Why: a Vue upgrade that makes `tryAutoCleanup` or `signal()` slower would go unnoticed; the harness must report its own noise floor so a ratio is never quoted without a control beside it.
 * Shows: skipped unless `scripts/ab-vue.mjs` sets `VC_AB_BASELINE`. It prints medians, IQRs, a paired per-round ratio and a control ratio per workload, and asserts only that one result line was produced per workload; it does not fail on a ratio, and one run's verdict is a report, not a conclusion. It compares Vue's primitives across versions, not this library's throughput (tests/perf.bench.ts).
 * See: scripts/ab-vue.mjs, tests/perf.bench.ts
 */

import { describe, expect, it } from 'vitest';

const BASELINE = process.env.VC_AB_BASELINE;
const BASELINE_VERSION = process.env.VC_AB_VERSION ?? 'baseline';
/** Byte-identical copy of the installed dist - the harness's own noise floor. */
const CONTROL = process.env.VC_AB_CONTROL;
const ROUNDS = 51;

/** Raw Vue module surface - deliberately untyped; two dists loaded side by side. */
type V = any;

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const quant = (xs: number[], p: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length * p)];
};

/** Each round must exceed ~1ms: a shorter round lets timer quantisation, per-instance setup and GC placement outweigh the work timed. */
const WORKLOADS: Record<string, (v: V) => void> = {
  'effectScope + onScopeDispose x30k (tryAutoCleanup path)': (v) => {
    for (let i = 0; i < 30000; i++) {
      const s = v.effectScope();
      s.run(() => { v.onScopeDispose(() => {}); });
      s.stop();
    }
  },
  'shallowRef create + 100 writes x8000 (signal() path)': (v) => {
    for (let i = 0; i < 8000; i++) {
      const r = v.shallowRef(0);
      for (let j = 0; j < 100; j++) r.value = j;
    }
  },
};

/** Operations per round, so a result can be stated in nanoseconds per operation: a ratio is relative to each primitive's own cost. */
const OPS_PER_ROUND: Record<string, { count: number; unit: string }> = {
  'effectScope + onScopeDispose x30k (tryAutoCleanup path)': { count: 30_000, unit: 'scope create+dispose' },
  'shallowRef create + 100 writes x8000 (signal() path)': { count: 800_000, unit: 'ref write' },
};

/**
 * A Vue-free yardstick, so per-operation costs can be normalised across machines.
 * Plain integer arithmetic with no allocation, property access or Vue: it tracks raw CPU, not what the comparison is about.
 */
const CALIBRATION_ITERATIONS = 2_000_000;

function calibrationCost(): number {
  const start = performance.now();
  let x = 0;
  for (let i = 0; i < CALIBRATION_ITERATIONS; i++) x = (x + i) % 1_000_003;
  const elapsed = performance.now() - start;
  void x;
  return elapsed;
};

// Watcher-notify and computed workloads are absent: two byte-identical instances in one process do not read 1.000 on them, so they cannot resolve a difference here.

describe.skipIf(!BASELINE)('Vue version A/B (same process, interleaved)', () => {
  it('reports medians, IQR and ratio per workload', async () => {
    const base: V = await import(/* @vite-ignore */ BASELINE!);
    // Must be the same dist flavour as the baseline: a bare `import('vue')` resolves to the dev bundler build, which would measure build flavour, not version.
    const cur: V = await import(/* @vite-ignore */ 'vue/dist/vue.runtime-with-vapor.esm-browser.prod.js');

    // A byte-identical copy of `cur` under its own specifier, so the module graph hands back a separate instance; any difference it shows is the harness measuring itself.
    // It compares the second loaded instance with the third, the verdict the first with the second, so a passing control is necessary but not sufficient.
    const ctl: V | null = CONTROL ? await import(/* @vite-ignore */ CONTROL) : null;

    // A median of several samples: a stray pause in the yardstick would skew every number it divides.
    const calibrations: number[] = [];
    for (let i = 0; i < 5; i++) calibrations.push(calibrationCost());
    const calibration = median(calibrations);

    const lines: string[] = [];
    let worstDeviation = 0;
    let unresolved = 0;

    for (const [name, fn] of Object.entries(WORKLOADS)) {
      for (let i = 0; i < 3; i++) { fn(base); fn(cur); if (ctl) fn(ctl); }

      // Rotated so no instance keeps a fixed slot in the round; the control, not rotation, measures instance bias.
      const runners: Array<[number[], V]> = [[[], base], [[], cur]];
      if (ctl) runners.push([[], ctl]);
      for (let r = 0; r < ROUNDS; r++) {
        for (let i = 0; i < runners.length; i++) {
          const [series, mod] = runners[(r + i) % runners.length]!;
          const t = performance.now();
          fn(mod);
          series.push(performance.now() - t);
        }
      }

      const [tb, tc, tk] = runners.map(([series]) => series);
      const mb = median(tb!);
      const mc = median(tc!);

      // Paired, not median-of-each-side: the instances run back-to-back in one round, so host load hits all of them alike and dividing within the round cancels it.
      // The spread of the per-round ratios is the uncertainty on the ratio.
      const paired: number[] = [];
      for (let r = 0; r < ROUNDS; r++) paired.push(tc![r]! / tb![r]!);
      const ratio = median(paired);
      const ratioLo = quant(paired, 0.25);
      const ratioHi = quant(paired, 0.75);

      // The error floor is the control's distance from 1.000 (two identical builds must read 1.000), never below 20% (15% with no control):
      // a run-level instance offset is shared by all rounds, so more rounds or a tight IQR cannot shrink it.
      // The control is paired the same way.
      let controlRatio: number | null = null;
      if (tk) {
        const pairedControl: number[] = [];
        for (let r = 0; r < ROUNDS; r++) pairedControl.push(tk[r]! / tc![r]!);
        controlRatio = median(pairedControl);
      }
      const errorFloor = controlRatio === null ? 0.15 : Math.max(Math.abs(controlRatio - 1), 0.20);

      // A win bought with a wider spread is reported as a trade, never as a plain improvement.
      const bLo = quant(tb!, 0.25);
      const bHi = quant(tb!, 0.75);
      const cLo = quant(tc!, 0.25);
      const cHi = quant(tc!, 0.75);
      const bSpread = (bHi - bLo) / mb;
      const cSpread = (cHi - cLo) / mc;

      // If the middle half of the per-round ratios straddles 1.000, the rounds disagree on which side was faster and the median means nothing.
      const straddlesUnity = ratioLo <= 1 && ratioHi >= 1;

      const deviation = Math.abs(ratio - 1);
      const resolved = deviation > errorFloor && !straddlesUnity;
      if (!resolved) unresolved++;
      if (resolved && deviation > worstDeviation) worstDeviation = deviation;

      const floorText = `error floor ${(errorFloor * 100).toFixed(1)}%`;
      // The spread of whichever side the verdict calls faster, against the other.
      const winnerSpread = ratio > 1 ? bSpread : cSpread;
      const loserSpread = ratio > 1 ? cSpread : bSpread;
      const spreadCaveat =
        resolved && winnerSpread > loserSpread * 1.5
          ? ` - but the faster side is ${(winnerSpread / loserSpread).toFixed(1)}x less consistent` +
            ` (spread ${(winnerSpread * 100).toFixed(1)}% vs ${(loserSpread * 100).toFixed(1)}%), so this` +
            ' is a trade, not a win'
          : '';

      // No directional verdict from one run: one process loads one pair of instances and that pair's offset dominates.
      // scripts/ab-vue.mjs runs this in several processes and decides from the spread across runs.
      const verdict = straddlesUnity
        ? `rounds disagree on direction [${ratioLo.toFixed(3)}, ${ratioHi.toFixed(3)}]`
        : deviation > errorFloor
          ? `${ratio > 1 ? 'slower' : 'faster'} by ${(deviation * 100).toFixed(1)}% in THIS run, ` +
            `above its ${floorText}${spreadCaveat}`
          : `inside this run's ${floorText}`;

      lines.push(
        `${name}\n` +
        `    ${BASELINE_VERSION.padEnd(12)} median ${mb.toFixed(3)}ms  IQR [${bLo.toFixed(3)}, ${bHi.toFixed(3)}]  spread ${(bSpread * 100).toFixed(1)}%\n` +
        `    ${String(cur.version).padEnd(12)} median ${mc.toFixed(3)}ms  IQR [${cLo.toFixed(3)}, ${cHi.toFixed(3)}]  spread ${(cSpread * 100).toFixed(1)}%\n` +
        (tk ? `    ${'control'.padEnd(12)} median ${median(tk).toFixed(3)}ms  paired ratio ${controlRatio!.toFixed(3)}x (want 1.000)\n` : '') +
        `    paired ratio ${ratio.toFixed(3)}x  IQR [${ratioLo.toFixed(3)}, ${ratioHi.toFixed(3)}]\n` +
        `    ${verdict}\n` +
        // Machine-readable, for scripts/ab-vue.mjs: name, ratio, control ratio, baseline ns/op, current ns/op, calibration cost, unit.
        `AB|${name}|${ratio.toFixed(6)}|${controlRatio === null ? '' : controlRatio.toFixed(6)}` +
        `|${((mb * 1e6) / (OPS_PER_ROUND[name]?.count ?? 1)).toFixed(4)}` +
        `|${((mc * 1e6) / (OPS_PER_ROUND[name]?.count ?? 1)).toFixed(4)}` +
        `|${calibration.toFixed(4)}|${OPS_PER_ROUND[name]?.unit ?? 'op'}`,
      );
    }

    console.log(
      `\nVue A/B - ${BASELINE_VERSION} vs installed ${cur.version} (${ROUNDS} interleaved rounds)\n` +
      lines.join('\n') +
      (ctl
        ? `\n\n${unresolved === Object.keys(WORKLOADS).length
            ? 'No workload showed a difference larger than this run\'s own error floor.'
            : `Largest difference that cleared its error floor: ${(worstDeviation * 100).toFixed(1)}%` +
              ` (${Object.keys(WORKLOADS).length - unresolved} of ${Object.keys(WORKLOADS).length} workloads).`}`
        : '\n\nNO CONTROL INSTANCE - run via `npm run ab:vue` so every ratio is ' +
          'checked against an identical-build comparison. Without it these ' +
          'numbers include the harness\'s own instance bias, measured at up to 25%.'),
    );

    // No assertion on a ratio: one host cannot tell a 5% regression from 5% noise, and a failing build would only produce flakes.
    expect(lines.length).toBe(Object.keys(WORKLOADS).length);
  });
});
