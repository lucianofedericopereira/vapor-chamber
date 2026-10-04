#!/usr/bin/env node
/**
 * bench-bands - the only writer of the stamped bench ratios.
 *
 * Runs `tests/perf.bench.ts` N times (default 5), each a fresh vitest process,
 * and only the describe groups that hold a ratio. Each run's ratios come from
 * `scripts/bench-ratios-reporter.mjs` (`benchRun` in `docs/metrics.json`).
 * Then it writes `bench` there, which `npm run docs:stamp` publishes:
 *   - an `own` ratio (both rows this library's code, or the bare-call floor)
 *     as the median of the runs;
 *   - a `peer` ratio (one row another library) as the band "min-max", because
 *     one value of it is a fact about one host on one day (docs/V8-RULES.md
 *     rule 15: fast lane vs mitt stamped 2.33, 1.79-1.92 five runs later);
 *   - `benchProvenance`: Node, vitest and the peers' versions, and N.
 *
 * Fewer than MIN_RUNS runs, or a ratio missing from a run, writes nothing and
 * exits 1: a band from two draws or a renamed row would publish a wrong value
 * that looks like a right one.
 *
 * Never run it to stamp from a working tree with uncommitted changes: the
 * values are published from a clean committed checkout.
 *
 * USAGE  node scripts/bench-bands.mjs [N] [--out <dir>]
 *        (`npm run bench:bands -- 5`); each run's output and ratios are kept in
 *        <dir> (default: a new temporary directory, printed).
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RATIOS } from './bench-ratios-reporter.mjs';

export const MIN_RUNS = 3;
export const PEERS = ['mitt', 'eventemitter3'];

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * runs: one `{ name: "1.23" }` object per run. Returns the stamped values, or
 * throws naming what is missing.
 * @param {Array<Record<string, string>>} runs
 * @param {Record<string, { kind: string }>} [ratios]
 * @returns {Record<string, string>}
 */
export function bands(runs, ratios = RATIOS) {
  if (runs.length < MIN_RUNS) throw new Error(`bench-bands: ${runs.length} run(s), at least ${MIN_RUNS} needed for a band`);
  const out = {};
  for (const [name, { kind }] of Object.entries(ratios)) {
    const xs = runs.map((r) => Number(r[name]));
    const lost = xs.filter((x) => !Number.isFinite(x)).length;
    if (lost) throw new Error(`bench-bands: ${name} missing from ${lost} of ${runs.length} runs`);
    out[name] = kind === 'peer'
      ? `${Math.min(...xs).toFixed(2)}-${Math.max(...xs).toFixed(2)}`
      : median(xs).toFixed(2);
  }
  return out;
}

export function provenance({ node, vitest, peers, runs }) {
  const libs = Object.entries(peers).map(([name, v]) => `${name} ${v}`).join(', ');
  return `Node ${node}, vitest ${vitest}, ${libs}, ${runs} runs`;
}

/**
 * The `-t` pattern that selects exactly the describe groups the ratios read.
 * @param {Record<string, { group: string }>} [ratios]
 */
export function groupPattern(ratios = RATIOS) {
  const groups = [...new Set(Object.values(ratios).map((r) => r.group))];
  return `^(${groups.map((g) => g.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')}) `;
}

function versionOf(root, pkg) {
  return JSON.parse(readFileSync(join(root, 'node_modules', pkg, 'package.json'), 'utf8')).version;
}

function readMetrics(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function main(argv) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const metricsFile = join(root, 'docs/metrics.json');
  const n = Number(argv.find((a) => /^\d+$/.test(a)) ?? 5);
  const outIdx = argv.indexOf('--out');
  const out = outIdx >= 0 ? argv[outIdx + 1] : mkdtempSync(join(tmpdir(), 'vc-bench-bands-'));
  mkdirSync(out, { recursive: true });
  const pattern = groupPattern();
  console.log(`bench-bands: ${n} runs, groups ${pattern}, output ${out}`);

  const runs = [];
  for (let k = 1; k <= n; k++) {
    // A run that fails to record must not leave the previous run's ratios behind.
    const before = readMetrics(metricsFile);
    delete before.benchRun;
    if (existsSync(metricsFile)) writeFileSync(metricsFile, `${JSON.stringify(before, null, 2)}\n`);
    const t0 = Date.now();
    const r = spawnSync('npx', ['vitest', 'bench', '--run', 'tests/perf.bench.ts', '-t', pattern,
      '--reporter=default', '--reporter=./scripts/bench-ratios-reporter.mjs'], { cwd: root, encoding: 'utf8' });
    writeFileSync(join(out, `run-${k}.txt`), `${r.stdout ?? ''}${r.stderr ?? ''}`);
    const run = readMetrics(metricsFile).benchRun ?? {};
    writeFileSync(join(out, `ratios-${k}.json`), `${JSON.stringify(run, null, 2)}\n`);
    console.log(`run ${k}: rc ${r.status}, ${Math.round((Date.now() - t0) / 1000)} s, ${Object.keys(run).length} ratios`);
    // Stop at the first bad run instead of spending the other N - 1 on it.
    const want = Object.keys(RATIOS).length;
    if (r.status !== 0 || Object.keys(run).length !== want) {
      console.error(`bench-bands: run ${k} failed (rc ${r.status}, ${Object.keys(run).length} of ${want} ratios), see ${join(out, `run-${k}.txt`)}`);
      return 1;
    }
    runs.push(run);
  }

  let bench;
  try {
    bench = bands(runs);
  } catch (e) {
    console.error(e.message);
    return 1;
  }
  bench.benchProvenance = provenance({
    node: process.versions.node,
    vitest: versionOf(root, 'vitest'),
    peers: Object.fromEntries(PEERS.map((p) => [p, versionOf(root, p)])),
    runs: n,
  });
  const metrics = readMetrics(metricsFile);
  delete metrics.benchRun;
  metrics.bench = bench;
  const ordered = Object.fromEntries(Object.keys(metrics).sort().map((key) => [key, metrics[key]]));
  writeFileSync(metricsFile, `${JSON.stringify(ordered, null, 2)}\n`);
  for (const [name, value] of Object.entries(bench)) console.log(`${name.padEnd(32)} ${value}`);
  console.log('bench-bands: written to docs/metrics.json; `npm run docs:stamp` publishes them');
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = main(process.argv.slice(2));
