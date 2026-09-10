#!/usr/bin/env node
/**
 * ab-vue - same-process A/B of the installed Vue against a BASELINE version.
 *
 * Why this exists. "No regressions" was being asserted each Vue cycle rather
 * than measured, because the honest measurement is awkward: two Vue versions
 * have to run in ONE process, interleaved, or host drift and thermal state
 * swamp a 1-3% signal. Comparing a fresh bench run against numbers recorded in
 * a previous release is not a measurement - single-host bench output swings
 * 20-30% run to run. That gap is how a documented figure once drifted ~10x
 * (`crypto.randomUUID` at "~1-2µs", actually ~104ns) without anyone noticing.
 *
 * What it does: packs the baseline Vue from npm, extracts its prod with-vapor
 * dist next to the tests, and runs `tests/vue-version-ab.test.ts`, which loads
 * BOTH dists in one process and interleaves AB/BA rounds over the reactivity
 * primitives this library actually sits on.
 *
 * BEFORE RUNNING THIS, diff the two dists. The rc.6 -> rc.7 cycle used this
 * harness and then found reactivity/effect.ts, ref.ts, reactive.ts and
 * computed.ts byte-identical between the versions - so there was nothing to
 * measure, and the diff established that in seconds with a certainty no
 * benchmark offers:
 *
 *   sed -n '/#region packages\/reactivity\/src\/effect.ts/,/#endregion/p' <dist>
 *
 * And pass the version you PREVIOUSLY SHIPPED AGAINST, not an older RC. An
 * older baseline spans fixes that never reached users, so it answers "how does
 * code we never ran differ from code we run".
 *
 * Usage:
 *   node scripts/ab-vue.mjs 3.6.0-rc.6      # compare installed vue against rc.6
 *   npm run ab:vue -- 3.6.0-rc.6
 *
 * The extracted baseline lands in tests/__ref/ (never published - package.json
 * `files` ships only dist/src/scripts) and is removed on exit.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const version = process.argv[2];
if (!version) {
  console.error('usage: node scripts/ab-vue.mjs <baseline-vue-version>\n' +
    'example: node scripts/ab-vue.mjs 3.6.0-rc.3');
  process.exit(1);
}

const DIST = 'vue.runtime-with-vapor.esm-browser.prod.js';
const refDir = resolve('tests/__ref');
const refFile = join(refDir, `vue-${version}.js`);

let work;
try {
  console.log(`[ab-vue] packing vue@${version} ...`);
  work = mkdtempSync(join(tmpdir(), 'vc-ab-'));
  execFileSync('npm', ['pack', `vue@${version}`, '--silent'], { cwd: work, stdio: 'inherit' });
  const tgz = readdirSync(work).find((f) => f.endsWith('.tgz'));
  if (!tgz) throw new Error(`npm pack produced no tarball for vue@${version}`);
  execFileSync('tar', ['xzf', tgz], { cwd: work });

  const src = join(work, 'package', 'dist', DIST);
  if (!existsSync(src)) {
    throw new Error(`vue@${version} has no ${DIST} - versions before 3.6 have no vapor build.`);
  }
  mkdirSync(refDir, { recursive: true });
  copyFileSync(src, refFile);
  console.log(`[ab-vue] baseline ready: ${refFile}`);

  // A CONTROL: a byte-identical copy of the INSTALLED dist, under a second
  // specifier so the module graph gives it its own instance. Comparing the
  // installed Vue against this measures a difference that cannot exist, so
  // whatever it reports is the harness's own bias.
  //
  // It is not hypothetical. Run as a self-comparison (baseline = installed
  // version), this harness reported two of its four workloads as 19% and 25%
  // FASTER, with a confident "<<< faster" beside each. Interleaving AB/BA
  // rounds does not cancel it, because the bias is not execution order: `base`
  // and `cur` are separate module instances that the engine optimises
  // independently, and one stays quicker whichever runs first.
  const controlSrc = resolve('node_modules/vue/dist', DIST);
  if (!existsSync(controlSrc)) {
    throw new Error(`installed vue has no ${DIST} - cannot build a control instance.`);
  }
  const controlFile = join(refDir, 'vue-control.js');
  copyFileSync(controlSrc, controlFile);

  // SEPARATE PROCESSES, several of them. One process loads one pair of module
  // instances, and that pair's offset - not round-to-round noise - is the
  // dominant error. Measured on self-comparisons, where every ratio must be
  // 1.000: sixteen samples ranged 0.806 to 1.356. Adding rounds inside a run
  // cannot touch that, because every round shares the same two instances; only
  // a fresh process draws a fresh pair. So the run is the sampling unit.
  const RUNS = Number(process.env.VC_AB_RUNS ?? 5);
  const perWorkload = new Map();

  for (let run = 1; run <= RUNS; run++) {
    console.log(`[ab-vue] run ${run}/${RUNS} ...`);
    const out = execFileSync('npx', ['vitest', 'run', 'tests/vue-version-ab.test.ts', '--silent=false'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        VC_AB_BASELINE: `./__ref/vue-${version}.js`,
        VC_AB_VERSION: version,
        VC_AB_CONTROL: './__ref/vue-control.js',
      },
    });
    for (const line of out.split('\n')) {
      const m = /^AB\|(.+?)\|([\d.]+)\|([\d.]*)\|([\d.]+)\|([\d.]+)\|([\d.]+)\|(.+)$/.exec(line.trim());
      if (!m) continue;
      if (!perWorkload.has(m[1])) {
        perWorkload.set(m[1], { ratios: [], controls: [], baseNs: [], curNs: [], calibrations: [], unit: m[7] });
      }
      const entry = perWorkload.get(m[1]);
      entry.ratios.push(Number(m[2]));
      if (m[3]) entry.controls.push(Number(m[3]));
      entry.baseNs.push(Number(m[4]));
      entry.curNs.push(Number(m[5]));
      entry.calibrations.push(Number(m[6]));
    }
  }

  const median = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    const mid = s.length >> 1;
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  };
  const pct = (x) => `${((x - 1) * 100).toFixed(1)}%`;

  console.log(`\n${'='.repeat(72)}\nCROSS-RUN SUMMARY - ${version} vs installed, ${RUNS} independent runs`);
  console.log(`${'='.repeat(72)}`);
  // Measured over five self-comparison runs (identical bytes, so every ratio
  // must read 1.000). Two of the four workloads are a coin flip - their error
  // is bimodal at roughly +/-40%, not a spread - and no statistic applied to
  // one run can rescue them. Naming them here keeps a reader from weighing a
  // number that cannot mean anything.
  // Floor per workload, measured over five self-comparison runs on identical
  // bytes - the widest run-to-run deviation each one showed when the true
  // answer was known to be 1.000. This replaces gating on the in-run control,
  // which asks the wrong question here: that control compares two instances
  // WITHIN one process, so it carries the same per-run lottery the cross-run
  // sampling exists to average out. Gating a tight five-run result on one
  // noisy in-process reading suppressed a real 0.2% measurement behind a
  // 19.8% control artefact.
  // The floor is the worst DEVIATION FROM 1.000 seen on identical bytes, not
  // the run-to-run spread. Getting that wrong shipped a false claim for about
  // ten minutes: effectScope's self-comparison sits at ~1.02 rather than
  // 1.000, so its spread is a tight 2.1% while its error is up to 3.6%. Gated
  // on the spread, a self-comparison confidently reported "SLOWER by 2.3% in
  // every run" between a file and itself.
  //
  // Observed over five self-comparison runs, worst |ratio - 1|:
  //   shallowRef   1.004-1.011  ->  1.1%,  floor 1.5%
  //   effectScope  1.015-1.036  ->  3.6%,  floor 4.0%
  // Two bands in two different units, on purpose.
  //
  // The FLOOR is a PERCENTAGE, because it describes the harness: the worst
  // deviation from 1.000 each workload showed on identical bytes. Below it a
  // number means nothing, and that is a property of the measurement, not of
  // the code being measured.
  //
  // The ACTION band is NANOSECONDS PER OPERATION, because a percentage is the
  // wrong unit for deciding anything. 20% of a 1.3ns ref write is 0.26ns; 20%
  // of a 38ns scope create is 7.6ns; those are not the same news, and only the
  // absolute figure can be compared against what the library actually spends.
  // Measured in tests/perf.bench.ts: 23.5ns per bare dispatch (4,250.90 hz
  // over 10,000 dispatches).
  //
  //   ref write - roughly one per dispatch, so 1% of a dispatch is the
  //   smallest thing worth noticing: 0.24 ns.
  //
  //   scope create+dispose - paid once per composable scope at SETUP, not per
  //   dispatch, and a component mount costs hundreds of ns at minimum. 1% of
  //   that is ~5 ns.
  //
  // Reported deltas are normalised by the calibration loop, so these bands
  // hold on a slower host instead of quietly meaning something else.
  const STABILITY = [
    [/shallowRef create/, 0.015, 0.24, 'floor 1.5% (identical bytes read 1.004-1.011); act past 0.24 ns/op'],
    [/effectScope/, 0.040, 5.0, 'floor 4.0% (identical bytes read 1.015-1.036, i.e. biased); act past 5 ns/op'],
  ];

  // TWO BANDS, and they answer different questions.
  //
  // The FLOOR is what this harness can see: the worst deviation from 1.000 it
  // showed on identical bytes. Below it, a number means nothing.
  //
  // The ACTION band is what would matter to this library, derived from the
  // bench rather than chosen. Measured: `syncDispatch - bare handler` runs
  // 4,250.90 hz over 10,000 dispatches, i.e. 23.5ns per dispatch. Against
  // that, one shallowRef write is ~1.3ns (~800k writes in 1.03ms) and one
  // effectScope create+dispose is ~38ns (30k in 1.15ms).
  //
  //   shallowRef is ~5.5% of a dispatch, and a dispatch may do one write. A
  //   20% regression there therefore moves a dispatch by ~1.1%. That is the
  //   smallest primitive change with a visible cost, so 20% is the band.
  //
  //   effectScope costs more per call than a whole dispatch, but is paid once
  //   per composable scope at setup - not per dispatch. Its blast radius is
  //   component mounts, so it tolerates far more: 50%.
  //
  // Worth stating plainly, because it is the real answer to "how big a shift
  // should worry us": both bands sit far above the harness's floor, so
  // precision is not the constraint here. These primitives are simply too
  // cheap, relative to everything the library does around them, for a small
  // Vue regression to reach us. A difference between the floor and the action
  // band is real but not worth acting on; only a large one is.

  // Cost of the Vue-free calibration loop on the machine these bands were
  // derived on. Dividing a host's own calibration by this converts its
  // nanoseconds into reference-machine nanoseconds, so an absolute band means
  // the same thing on a slower laptop or a busier CI box. Re-measure and
  // update this if the reference machine changes; the printout says what this
  // run measured, so a wildly different figure is visible rather than silent.
  const REFERENCE_CALIBRATION_MS = 6.0;

  for (const [name, { ratios, controls, baseNs, curNs, calibrations, unit }] of perWorkload) {
    const lo = Math.min(...ratios);
    const hi = Math.max(...ratios);
    const calibration = median(calibrations);
    const machineFactor = REFERENCE_CALIBRATION_MS / calibration;
    // Per-operation delta, in nanoseconds, normalised to the reference machine.
    const deltaNs = (median(curNs) - median(baseNs)) * machineFactor;
    const entry = STABILITY.find(([re]) => re.test(name));
    const floor = entry?.[1] ?? 0.20;
    const actionBand = entry?.[2] ?? 0.50;
    const stability = entry?.[3] ?? 'stability unmeasured - floor defaults to 20%';
    // A claim needs every run to agree on the direction, and the control's own
    // worst reading to be smaller than the effect. Either failing means the
    // harness moved more than the thing being measured.
    const allAbove = lo > 1;
    const allBelow = hi < 1;
    const effect = Math.abs(median(ratios) - 1);
    // Three outcomes, not two, because "we could not tell" and "there is no
    // difference" are different findings and reading them as one loses the
    // useful half. Runs disagreeing on direction means the harness failed to
    // measure. An effect that sits under a floor derived from identical bytes
    // means it DID measure, and found nothing - which is a result, and the
    // one an alignment cycle usually wants to hear.
    // The floor is tested FIRST, and the order is the point. Direction
    // agreement is only meaningful for an effect large enough to have a
    // direction: a cluster like 1.005, 1.004, 1.005, 1.004, 1.000 is as
    // "same" as a measurement gets, yet the single run landing exactly on
    // unity made an all-above test false and reported UNRESOLVED - turning the
    // tightest result in the run into the most alarming line in the output.
    const verdict = effect <= floor
      ? `SAME - ${pct(median(ratios))} is under this workload's ${(floor * 100).toFixed(1)}% floor, ` +
        'so the two versions are indistinguishable at the resolution available here'
      : !(allAbove || allBelow)
        ? 'UNRESOLVED - runs disagree on direction, this harness could not measure it'
        : Math.abs(deltaNs) <= actionBand
          ? `real but not actionable: ${pct(median(ratios))} in every run is ` +
            `${deltaNs >= 0 ? '+' : ''}${deltaNs.toFixed(3)} ns/op, under the ${actionBand} ns/op ` +
            'at which this primitive moves the library measurably'
          : `*** ACT: ${allAbove ? 'SLOWER' : 'FASTER'} by ${deltaNs >= 0 ? '+' : ''}` +
            `${deltaNs.toFixed(3)} ns/op in every run, past the ${actionBand} ns/op band ***`;
    console.log(
      `\n${name}\n` +
      `    ${stability}\n` +
      `    per-run ratios: ${ratios.map((r) => r.toFixed(3)).join(', ')}\n` +
      `    median ${median(ratios).toFixed(3)}x  range [${lo.toFixed(3)}, ${hi.toFixed(3)}]\n` +
      `    ${median(baseNs).toFixed(2)} -> ${median(curNs).toFixed(2)} ns per ${unit}` +
      `  (delta ${deltaNs >= 0 ? '+' : ''}${deltaNs.toFixed(3)} ns, normalised; ` +
      `machine factor ${machineFactor.toFixed(2)}x)\n` +
      `    ${verdict}`,
    );
  }
  console.log(
    `\nSAME means measured and indistinguishable at this workload's floor.` +
    ` UNRESOLVED means the runs disagreed and nothing was measured at all.` +
    ` A difference above the floor is reported; acting on it additionally` +
    ` requires clearing the ns/op action band, derived from the 23.5ns a bare` +
    ` dispatch costs - see the note in this script.` +
    `\nOne run establishes none of it. Diff the dists first: if the reactivity` +
    ` sources are identical there is nothing here to find.`,
  );
} catch (err) {
  console.error(`[ab-vue] ${err.message}`);
  process.exitCode = 1;
} finally {
  // The baseline is a build artifact, not a fixture - never leave it behind to
  // rot into a stale comparison nobody remembers pinning.
  rmSync(refDir, { recursive: true, force: true });
  if (work) rmSync(work, { recursive: true, force: true });
}
