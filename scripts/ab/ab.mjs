#!/usr/bin/env node
/**
 * The A/B tool: is commit B faster than commit A on a workload?
 *
 *   npm run ab -- <distA> <distB> <workload.mjs> [options]
 *   node scripts/ab/ab.mjs <distA> <distB> <workload.mjs> [options]
 *
 * <distA>, <distB>: built `dist/` directories, one per commit
 * (scripts/ab/build-dists.sh makes them; never a hand-edited dist).
 * <workload.mjs>: imports from `__DIST__/...`, exports `N` (an object whose
 * keys name the functions to time; the value is a probe size) and one
 * `fn(n)` per key that runs n iterations and returns a number (with
 * `ASYNC = true`, a promise of one). Examples: scripts/ab/workloads/.
 *
 * Options:
 *   --k=10          processes per phase (the process is the unit of replication)
 *   --rounds=40     timed calls per arm and length in each process
 *   --ms=5          target length of the SHORT call, from a warm call of arm A
 *   --lengths=2     1: one length; 2: n and 4n (a claim must hold at both)
 *   --n=N | --n=fn:N,fn2:N   pin n instead of sizing (the line `pinned:` of a
 *                   previous run; pin it to compare flag sets)
 *   --only=fn,fn2   time these functions only
 *   --flags=F       an extra node / V8 flag for every child, repeatable
 *                   (sizing never gets them)
 *   --raw=file.json write the config and every raw round
 *
 * Method: docs/V8-RULES.md rule 16; statistics and gates: ./stats.mjs. Each
 * arm is bundled the way a consumer ships it (esbuild, browser resolution,
 * Vue's esm-bundler build, production defines, minified, CJS), so each bundle
 * has its own copy of the library and of Vue. Phase 1 runs A against a second
 * bundle of A (the CONTROL), phase 2 A against B, each in K processes with a
 * random load order. Wall time decides; main-thread CPU only validates it.
 * The tool does not check the machine's load: a row whose control or clocks
 * show interference says "no result" (decisions, 2026-10-01; log s35.49).
 * Run a session through scripts/ab/session.sh, after the owner's "go".
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { loadavg, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as esbuild } from 'esbuild';
import { collect, combineLengths, fitLine, judge, judgeControl, pairedPerCall, pct } from './stats.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');

export function parseArgs(argv) {
  const pos = [];
  const opt = { k: 10, rounds: 40, ms: 5, lengths: 2, n: null, only: null, flags: [], raw: '' };
  for (const a of argv) {
    const m = /^--([a-z]+)=(.*)$/.exec(a);
    if (!m) {
      pos.push(a);
      continue;
    }
    const [, key, v] = m;
    if (key === 'k' || key === 'rounds' || key === 'ms' || key === 'lengths') opt[key] = Number(v);
    else if (key === 'n') opt.n = /^\d+$/.test(v) ? Number(v) : Object.fromEntries(v.split(',').map((p) => { const [f, x] = p.split(':'); return [f, Number(x)]; }));
    else if (key === 'only') opt.only = v.split(',');
    // Repeatable and space-separated alike, so a jobs-file line needs no quotes.
    else if (key === 'flags') opt.flags.push(...v.split(' ').filter(Boolean));
    else if (key === 'raw') opt.raw = v;
    else throw new Error(`unknown option --${key}`);
  }
  if (pos.length !== 3) throw new Error('usage: ab.mjs <distA> <distB> <workload.mjs> [--k= --rounds= --ms= --lengths= --n= --only= --flags= --raw=]');
  if (!(opt.lengths === 1 || opt.lengths === 2)) throw new Error('--lengths is 1 or 2');
  return { distA: pos[0], distB: pos[1], workload: pos[2], ...opt };
}

export async function bundler(cacheRoot = join(repo, 'node_modules', '.cache')) {
  // A fresh `npm ci` (CI) has no node_modules/.cache yet.
  mkdirSync(cacheRoot, { recursive: true });
  const work = mkdtempSync(join(cacheRoot, 'vc-ab-'));
  const out = mkdtempSync(join(tmpdir(), 'vc-ab-out-'));
  let seq = 0;
  return {
    async bundle(dist, workload) {
      const id = seq++;
      const entry = join(work, `h${id}.mjs`);
      writeFileSync(entry, readFileSync(workload, 'utf8').replaceAll('__DIST__', resolve(dist)));
      const outfile = join(out, `b${id}.cjs`);
      await esbuild({
        entryPoints: [entry],
        outfile,
        bundle: true,
        format: 'cjs',
        platform: 'browser',
        target: 'es2022',
        minify: true,
        logLevel: 'silent',
        nodePaths: [join(repo, 'node_modules')],
        define: { 'process.env.NODE_ENV': '"production"', __VUE_OPTIONS_API__: 'false', __VUE_PROD_DEVTOOLS__: 'false', __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false' },
      });
      return outfile;
    },
    dispose() {
      rmSync(work, { recursive: true, force: true });
      rmSync(out, { recursive: true, force: true });
    },
  };
}

// A fixed young generation, so new-space size is equal between arms.
const baseFlags = (k) => ['--expose-gc', '--max-semi-space-size=32', '--min-semi-space-size=32', `--random-seed=${k + 1}`];
const runChild = (flags, cfg) => JSON.parse(execFileSync(process.execPath, [...flags, join(here, 'child.cjs'), JSON.stringify(cfg)], { maxBuffer: 1 << 28 }));

/** n per function from a WARM call of arm A, under the base flags only, so a pinned n is the same under every flag set. */
function size(bundleA, opt) {
  const nsPer = runChild(baseFlags(0), { bundles: { A: bundleA }, order: ['A'], size: true });
  const n = {};
  for (const [fn, ns] of Object.entries(nsPer)) if (!opt.only || opt.only.includes(fn)) n[fn] = Math.max(1000, Math.round((opt.ms * 1e6) / Math.max(ns, 0.5)));
  return n;
}

function phase(opt, a, b, nFor, seedBase) {
  const reps = [];
  for (let k = 0; k < opt.k; k++) {
    const order = Math.random() < 0.5 ? ['B', 'A'] : ['A', 'B'];
    reps.push(runChild([...baseFlags(seedBase + k), ...opt.flags], { bundles: { A: a, B: b }, order, rounds: opt.rounds, n: nFor, only: Object.keys(nFor) }));
  }
  return reps;
}

const f3 = (x) => x.toFixed(3);
const ns = (x) => x.toFixed(1);

/** @typedef {{ verdict: string, ratios: number[], controls: boolean[], fit: { slope: number, intercept: number, maxResidual: number } | null }} Verdict */

export function report(byLength, log = console.log) {
  const fns = Object.keys(byLength[0].control);
  /** @type {Record<string, Verdict>} */
  const summary = {};
  for (const fn of fns) {
    const verdicts = [];
    const controls = [];
    const points = [];
    for (const L of byLength) {
      const ctl = judgeControl(L.control[fn]);
      const r = judge(L.ba[fn], ctl);
      verdicts.push(r);
      controls.push(ctl.ok);
      points.push({ n: L.n[fn], y: pairedPerCall(L.ba[fn]) });
      log(
        `  ${fn.padEnd(24)} n ${String(L.n[fn]).padStart(7)}  control ${f3(Math.exp(ctl.centre))} +-${pct(2 * ctl.spread)}` +
          `  B/A ${f3(r.ratio)} CI ${f3(r.ci[0])}..${f3(r.ci[1])} p ${r.p.toFixed(3)} MDE ${pct(r.mde)}` +
          `  A ${ns(r.a)} B ${ns(r.b)} ns (${r.delta >= 0 ? '+' : ''}${ns(r.delta)})` +
          `  off-CPU ${pct(r.off)} bg ${pct(r.other[0])}/${pct(r.other[1])}  => ${r.verdict}${r.why.length ? ` (${r.why.join('; ')})` : ''}${r.notes.length ? ` [${r.notes.join('; ')}]` : ''}`,
      );
    }
    const c = combineLengths(verdicts);
    let fit = null;
    if (points.length > 1) {
      fit = fitLine(points);
      log(`  ${fn.padEnd(24)} paired fit: ${fit.slope >= 0 ? '+' : ''}${ns(fit.slope)} ns/iter, ${fit.intercept >= 0 ? '+' : ''}${(fit.intercept / 1e3).toFixed(0)} us/call`);
    }
    log(`  ${fn.padEnd(24)} VERDICT ${c.verdict.toUpperCase()}${c.why.length && c.verdict === 'no result' ? ` (${c.why.join('; ')})` : ''}`);
    summary[fn] = { verdict: c.verdict, ratios: verdicts.map((v) => v.ratio), controls, fit };
  }
  return summary;
}

/** @returns {Promise<Record<string, Verdict>>} */
export async function main(argv) {
  const opt = parseArgs(argv);
  const b = await bundler();
  try {
    const A1 = await b.bundle(opt.distA, opt.workload);
    const A2 = await b.bundle(opt.distA, opt.workload);
    const B = await b.bundle(opt.distB, opt.workload);
    let n1 = opt.n;
    if (n1 === null) n1 = size(A1, opt);
    else if (typeof n1 === 'number') {
      const fns = Object.keys(runChild(baseFlags(0), { bundles: { A: A1 }, order: ['A'], size: true }));
      n1 = Object.fromEntries(fns.filter((f) => !opt.only || opt.only.includes(f)).map((f) => [f, opt.n]));
    }
    const lengths = opt.lengths === 2 ? [n1, Object.fromEntries(Object.entries(n1).map(([f, x]) => [f, 4 * x]))] : [n1];
    console.log(`ab: node ${process.version}, load ${loadavg().map((x) => x.toFixed(2)).join(' ')} (not a gate), K ${opt.k}, rounds ${opt.rounds}, flags [${opt.flags.join(' ')}], minor gc per call`);
    console.log(`pinned: --n=${Object.entries(n1).map(([f, x]) => `${f}:${x}`).join(',')}${opt.lengths === 2 ? ' (and 4x)' : ''}`);
    spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
    // Every control before any B: a control that fails says so before B is spent.
    const raw = lengths.map((nFor) => ({ n: nFor, control: phase(opt, A1, A2, nFor, 0), ba: null }));
    for (const L of raw) L.ba = phase(opt, A1, B, L.n, 100);
    const summary = report(raw.map((L) => ({ n: L.n, control: collect(L.control), ba: collect(L.ba) })));
    if (opt.raw) writeFileSync(opt.raw, JSON.stringify({ config: { ...opt, node: process.version, lengths }, raw, summary }));
    return summary;
  } finally {
    b.dispose();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(String(e?.message ?? e));
    process.exit(2);
  });
}
