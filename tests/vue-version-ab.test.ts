// @vitest-environment happy-dom
/**
 * Same-process A/B: the INSTALLED Vue vs a baseline version.
 *
 * Skipped unless driven by `scripts/ab-vue.mjs`, which packs the baseline and
 * sets `VC_AB_BASELINE`. Run it with:
 *
 *     npm run ab:vue -- 3.6.0-rc.3
 *
 * METHOD, and why it is this fussy. Both prod dists load into ONE process and
 * rounds alternate AB / BA, because the thing being measured (1-3%) is smaller
 * than the drift between two separate runs on a shared host - comparing today's
 * bench output against numbers written into a previous release is not a
 * measurement at all. Medians and IQRs are reported, never a single run, and
 * the workloads are scaled so every round takes >1ms: at ~15µs a round the
 * timer quantises and results go bimodal, which reads as a spurious 2-3x
 * "speedup" (observed while building this - the first version of this harness
 * reported 0.361x on a workload that is actually 1.013x).
 *
 * The workloads are the Vue primitives THIS library sits on, not a general Vue
 * benchmark: scope create/dispose (`tryAutoCleanup`), shallowRef writes
 * (`signal()`), watcher notify, and computed read-after-write.
 *
 * HOW MUCH TO TRUST IT, measured rather than assumed. Run as a
 * self-comparison - baseline set to the installed version, so every ratio must
 * be 1.000 - this harness still reports two of its four workloads wrong, and
 * one of them is not noise: `computed` gives a control of 0.784, 0.785, 0.786
 * across three runs, a systematic 21.5% gap between two byte-identical module
 * instances. Rescaling the short workloads past the 1ms floor fixed the
 * `watchEffect` case (it swung 0.830-1.003 before, 0.947-1.034 after), so
 * round length was one real cause, but it did nothing for the other two.
 *
 * The practical reading: this cannot resolve the 1-3% it was built for. It is
 * useful for catching a LARGE regression, and the control makes it refuse to
 * speak when it cannot see. Do not quote a ratio from here as a finding
 * without a passing control beside it, and do not read a passing control as
 * proof - see the limit noted at the control import below.
 *
 * THE ERROR IS BIMODAL, NOT A SPREAD, and that is the thing to understand
 * before reading any number here. Comparing rc.3 against rc.7, the watcher
 * workload produced 1.352, 1.356, 0.997, 0.702, 0.719 across five runs: two
 * clusters, near 1.35 and 0.70, which are reciprocals of each other. It is the
 * same magnitude with the sign flipped - in some runs one instance wins by
 * ~40%, in others the other one does. A single run lands in one mode and looks
 * perfectly self-consistent while doing so, which is exactly why tight IQRs
 * from one process are not evidence.
 *
 * PER-WORKLOAD STABILITY, measured over five self-comparison runs (identical
 * bytes, so every ratio must read 1.000). Run-to-run range:
 *
 *   shallowRef writes   1.004-1.011   0.7%   kept
 *   effectScope         1.015-1.036   2.1%   kept
 *   computed            0.917-1.240    35%   REMOVED, see the note below
 *   watchEffect notify  0.806-1.353    68%   REMOVED
 *
 * That distinction was invisible while one global band covered all four, and
 * it is why the old constant was not merely unmeasured but the wrong SHAPE - a
 * single threshold cannot describe workloads whose error floors differ by two
 * orders of magnitude.
 *
 * WHAT THIS DOES AND DOES NOT ANSWER, since the two that remain are narrow.
 * It compares VUE's primitives across two Vue versions. It does not measure
 * this library's own throughput under those versions - that is
 * tests/perf.bench.ts, and it is the better instrument for "did the upgrade
 * cost US anything".
 *
 * DIFF BEFORE YOU MEASURE. This is not general advice, it is what happened.
 * The rc.6 -> rc.7 alignment ran this harness; comparing the two published
 * dists afterwards showed reactivity/effect.ts, ref.ts, reactive.ts and
 * computed.ts all BYTE-IDENTICAL between those versions. There was nothing to
 * measure, and two seconds of `diff` said so with a certainty no number here
 * can reach. Chasing an rc.3 baseline told the same story more slowly: the
 * EffectScope class is byte-identical to rc.7's, and the only reactivity
 * changes in that whole span are braces around one if/else and whitespace
 * inside a @__NO_SIDE_EFFECTS__ annotation. The ~2% "slower" that produced is
 * the harness's instance bias, which is exactly what its 4.0% floor exists to
 * refuse.
 *
 * PICK THE BASELINE YOU SHIPPED AGAINST. An older RC is not a neutral choice:
 * it spans fixes that never reached users, so the comparison answers "how does
 * code we never ran differ from code we run", which is nobody's question. The
 * baseline that means something is the version the library previously
 * supported.
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

/**
 * Each round must exceed ~1ms - see the note about timer quantisation above.
 *
 * These counts were RE-SCALED after the control instance landed, because three
 * of the four had drifted under that floor (0.27ms, 0.35ms, 0.79ms) and were
 * exactly the three the control could not resolve. Repeating the control three
 * times separated two causes: `shallowRef` was not noise at all but a stable
 * ~18% bias (1.191, 1.185, 1.179 across runs), while `watchEffect` swung
 * (1.003, 0.830, 0.988). A round too short lets per-instance setup and GC
 * placement weigh as much as the work being timed, which produces both.
 */
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

/**
 * Operations per round, so a result can be stated in NANOSECONDS PER
 * OPERATION rather than only as a ratio.
 *
 * A percentage is relative to the primitive's own cost, which makes it a poor
 * unit for deciding anything: 20% of a 1.3ns shallowRef write is 0.26ns, while
 * 20% of a 38ns scope create is 7.6ns, and those are not the same news. An
 * absolute per-operation delta answers "does this matter" directly, because it
 * can be compared against what the library spends per dispatch (23.5ns,
 * measured in tests/perf.bench.ts).
 */
const OPS_PER_ROUND: Record<string, { count: number; unit: string }> = {
  'effectScope + onScopeDispose x30k (tryAutoCleanup path)': { count: 30_000, unit: 'scope create+dispose' },
  'shallowRef create + 100 writes x8000 (signal() path)': { count: 800_000, unit: 'ref write' },
};

/**
 * A Vue-free yardstick, run once per round, so per-operation costs can be
 * NORMALISED ACROSS MACHINES.
 *
 * Nanoseconds are only portable if the clock they came from is. A slower host
 * inflates every measurement here in step, so dividing by a fixed, purely
 * arithmetic loop measured in the same process converts "ns on this machine"
 * into "ns relative to a reference machine". Without it an absolute band would
 * mean something different on every host, which is the same trap the ratio had
 * in reverse.
 *
 * Deliberately plain integer arithmetic: no allocation, no property access, no
 * Vue, so it tracks raw CPU rather than anything the comparison is about.
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

// REMOVED: 'shallowRef + watchEffect notify' and 'computed read after write'.
//
// Both measured a real path this library uses, and both were deleted anyway,
// because a workload whose answer is known in advance is not a test - it is
// output a reader has to learn to ignore. Over five self-comparison runs on
// identical bytes, where every ratio must read 1.000, they produced
// 0.806-1.353 (68%) and 0.917-1.240 (35%): bimodal, clustering around
// reciprocal pairs, i.e. a coin flip on which instance wins by ~40%. No
// statistic applied afterwards can recover a signal from that.
//
// Two hypotheses were tested and both failed, so neither is worth retrying:
//
//   1. Rounds too short. The other workloads were rescaled past the file's
//      1ms floor and that genuinely fixed an earlier watchEffect instability,
//      but these two were already well over it (1.3ms and 2.1ms).
//   2. Long-lived reactive graph. Both built ONE watcher/computed and hammered
//      it, unlike the two stable workloads which create and discard.
//      Restructured to 50 short-lived graphs of the same total work, they
//      stayed unstable: 0.809/0.759/1.002/0.778/0.784 and
//      1.371/1.307/1.053/1.274/1.229.
//
// What survives is the two workloads that hold 1.000 to within 0.7% and 2.1%
// across runs, which is a harness that can actually resolve a few percent.
// Restoring watcher and computed coverage needs a design that isolates module
// instances - a process per instance - not another workload shape.

describe.skipIf(!BASELINE)('Vue version A/B (same process, interleaved)', () => {
  it('reports medians, IQR and ratio per workload', async () => {
    const base: V = await import(/* @vite-ignore */ BASELINE!);
    // MUST be the same dist flavour as the baseline. A bare `import('vue')`
    // resolves to the DEV bundler build, whose warning paths and instrumentation
    // make it several times slower on the watcher path - comparing that against
    // a prod browser dist measures build flavour, not version. The first run of
    // this harness did exactly that and reported a 2.8x "regression" in rc.4
    // that does not exist. Both sides are now the prod with-vapor browser dist.
    const cur: V = await import(/* @vite-ignore */ 'vue/dist/vue.runtime-with-vapor.esm-browser.prod.js');

    // A byte-identical copy of `cur`, under its own specifier so the module
    // graph hands back a separate instance. Any difference it shows is the
    // harness measuring itself - see the note in ab-vue.mjs.
    //
    // KNOWN LIMIT of this control, stated because the number it prints is
    // reassuring and should not be over-read: it compares the SECOND loaded
    // instance against the THIRD, while the verdict above it compares the
    // FIRST against the second. Instance differences here are not symmetric,
    // so a passing control does not license the ratio beside it. Measured on a
    // self-comparison (baseline = installed version, so every ratio should be
    // 1.000): the control read 1.02 while `base` vs `cur` read 1.35 on the same
    // workload. Treat a failing control as proof the run is worthless, and a
    // passing one as necessary but not sufficient.
    const ctl: V | null = CONTROL ? await import(/* @vite-ignore */ CONTROL) : null;

    // Median of several samples - the yardstick is as prone to a stray pause as
    // anything else, and it divides every number below it.
    const calibrations: number[] = [];
    for (let i = 0; i < 5; i++) calibrations.push(calibrationCost());
    const calibration = median(calibrations);

    const lines: string[] = [];
    let worstDeviation = 0;
    let unresolved = 0;

    for (const [name, fn] of Object.entries(WORKLOADS)) {
      for (let i = 0; i < 3; i++) { fn(base); fn(cur); if (ctl) fn(ctl); }

      // One series per instance, rotated so no instance keeps a fixed slot in
      // the round. Rotation alone does not remove the instance bias - that is
      // what the control is for - but it stops order compounding it.
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

      // PAIRED, not median-of-each-side. The three instances run back-to-back
      // inside one round, so whatever the machine was doing during that round
      // - another process waking, a thermal step, a GC pause - hit all of them
      // by roughly the same factor. Dividing WITHIN the round cancels it;
      // dividing two separately-aggregated medians does not, because each
      // median is drawn from a different mix of quiet and busy rounds.
      //
      // This is the "measure the load and weight by it" idea in its cheapest
      // correct form: the other instance in the same round IS the load probe,
      // so no separate calibration workload is needed and there is no window
      // in which the load could change between probe and measurement.
      //
      // The spread of these per-round ratios is also the honest uncertainty ON
      // THE RATIO, which the old form could not express at all - it produced a
      // single number from two medians with no way to say how firm it was.
      const paired: number[] = [];
      for (let r = 0; r < ROUNDS; r++) paired.push(tc![r]! / tb![r]!);
      const ratio = median(paired);
      const ratioLo = quant(paired, 0.25);
      const ratioHi = quant(paired, 0.75);

      // THE BAND IS MEASURED, NOT DECLARED.
      //
      // This used to compare the ratio against a hardcoded 1.15 / 0.87, with a
      // 0.13 control threshold beside it - one magic number wearing three hats
      // (0.87 is 1/1.15, 0.13 is 1 - 1/1.15), and nothing had measured any of
      // them. The comment on the assertion below even said 5% while the code
      // said 15%.
      //
      // The control already reports what this harness cannot tell apart on
      // this host, for this workload, in this run: two byte-identical builds
      // should read 1.000, so however far it lands from 1.000 IS the error
      // floor. A difference smaller than that is indistinguishable from the
      // harness measuring itself, whatever a constant would have said about it.
      //
      // The absolute floor is MEASURED, and it is large. Sixteen
      // self-comparison samples - four runs of four workloads, every one
      // comparing identical bytes, every one obliged to read 1.000 - came out
      // between 0.806 and 1.356, mean absolute deviation 13.5%.
      //
      // That is the run-level instance offset, and it is a different animal
      // from the within-round noise pairing removes. Pairing cut the per-round
      // spread to 1-2%, which makes a single run look precise, but the whole
      // run can still sit 20-35% off because the two instances it happens to
      // have loaded differ. More rounds cannot help: they all share the same
      // pair of instances. Only repeating the RUN samples that error.
      //
      // 20% is therefore the smallest floor the evidence supports. It is close
      // to the 15% constant this replaced, which is worth saying plainly: the
      // old number was about the right size and had no measurement behind it.
      // It is now the right size for a stated reason, and the tightness of any
      // one run's IQR is explicitly not allowed to shrink it.
      // Paired the same way, for the same reason.
      let controlRatio: number | null = null;
      if (tk) {
        const pairedControl: number[] = [];
        for (let r = 0; r < ROUNDS; r++) pairedControl.push(tk[r]! / tc![r]!);
        controlRatio = median(pairedControl);
      }
      const errorFloor = controlRatio === null ? 0.15 : Math.max(Math.abs(controlRatio - 1), 0.20);

      // SPREAD, not just the median. A median is a single point and two of them
      // can be ordered while the distributions behind them are the same shape -
      // and a "faster" median carrying a much wider spread is often the worse
      // outcome, because the tail is what a user actually waits for. Two rules
      // follow, and both can veto a verdict the medians alone would have given:
      //
      //   1. Overlapping interquartile ranges are not separable. If the middle
      //      half of one sample sits inside the middle half of the other, the
      //      ordering of their medians is an artefact of where the centre
      //      happened to land.
      //   2. A win bought with a wider spread is reported as the trade it is,
      //      never as a plain improvement.
      const bLo = quant(tb!, 0.25);
      const bHi = quant(tb!, 0.75);
      const cLo = quant(tc!, 0.25);
      const cHi = quant(tc!, 0.75);
      const bSpread = (bHi - bLo) / mb;
      const cSpread = (cHi - cLo) / mc;

      // With paired ratios the separability test is direct: if the middle half
      // of the per-round ratios straddles 1.000, the rounds disagree about
      // which side was faster, and a median drawn from them means nothing.
      // This replaces comparing the two raw IQRs for overlap, which was a
      // proxy for the same question and a weaker one - it could not see that
      // the two series move together round to round.
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

      // NO DIRECTIONAL VERDICT FROM ONE RUN. One process loads one pair of
      // instances, and that pair's offset is the dominant error: sixteen
      // self-comparison samples ranged 0.806-1.356. A threshold big enough to
      // suppress those false calls (>36%) would leave the harness blind to
      // anything worth finding, so the choice is not which threshold - it is
      // that a single run cannot answer the question. scripts/ab-vue.mjs runs
      // this several times, in separate processes, and decides from the spread
      // ACROSS runs; this line reports, it does not conclude.
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
        // Machine-readable, for the cross-run aggregation in ab-vue.mjs:
        // name, ratio, control ratio, baseline ns/op, current ns/op, and the
        // calibration loop's cost so the aggregator can normalise across hosts.
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

    // Deliberately not an assertion threshold. A single host cannot distinguish
    // a 5% regression from 5% noise, so failing the build on a ratio would
    // produce flakes and train people to ignore it. The numbers are for a human
    // to read during an alignment cycle; only a ratio far outside the noise
    // band (flagged above) means anything.
    expect(lines.length).toBe(Object.keys(WORKLOADS).length);
  });
});
