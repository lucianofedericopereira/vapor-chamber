#!/usr/bin/env node
/**
 * CI's speed check: is the head slower than its base on any measured path?
 *
 *   node scripts/ab/ci.mjs <distBase> <distHead> [workload.mjs ...] [ab.mjs options]
 *
 * Runs scripts/ab/ab.mjs once per workload (default: the five below), base as
 * A and head as B, one call length and K = 10 (a CI VM has two cores and a
 * time limit). The job FAILS when:
 *   - any function reads a counted SLOWER verdict (its control within 3% and
 *     centred, the interval excluding 1, the effect beyond the MDE, both load
 *     orders agreeing: docs/V8-RULES.md rule 16);
 *   - no function in the whole run had a passing control: the instrument
 *     failed (a VM too noisy to measure), and passing would be a silent pass;
 *   - a workload produced no function at all (it threw, or a row went missing).
 * A "no result" row does not fail: it is the gate saying it cannot tell.
 * It measures nothing, and passes, when the head ships the same JavaScript as
 * its base (`sameShippedCode`): a commit that changes docs, CI or FUNDING.yml
 * only builds the same dist, and an A/B of two identical builds is noise.
 * Each workload's raw rounds go to <out-dir>/<name>.json when --out=<dir> is
 * given. Decisions, 2026-10-02 (owner: "C"); log s35.59.
 */
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from './ab.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_WORKLOADS = ['track-parts', 'composable', 'create', 'filter-mixed', 'plugins'].map((w) => join(here, 'workloads', `${w}.mjs`));

/** Every shipped JavaScript file under `dir` (source maps and type files left out), by path. */
function shippedJs(dir, root = dir, out = new Map()) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) shippedJs(path, root, out);
    else if (/\.(m|c)?js$/.test(entry.name)) out.set(relative(root, path), path);
  }
  return out;
}

/**
 * Why there is nothing to measure, or undefined: when the head ships the same
 * JavaScript as its base (a commit that changes docs, CI or FUNDING.yml only),
 * the A/B compares two identical builds, and any verdict it gives is noise,
 * a red build included (owner report, log 36.31): two byte-identical copies
 * once read up to 1.425x apart (docs/V8-RULES.md rule 10).
 */
export function sameShippedCode(distBase, distHead) {
  const base = shippedJs(distBase);
  const head = shippedJs(distHead);
  if (base.size !== head.size) return undefined;
  for (const [path, file] of base) {
    const other = head.get(path);
    if (!other || !readFileSync(file).equals(readFileSync(other))) return undefined;
  }
  return `head ships the same JavaScript as base (${base.size} files, byte for byte): nothing to measure`;
}

/**
 * The job's verdict from each workload's summary ({ fn: { verdict, controls } }).
 * Pure, so tests/ab-ci.test.ts can seed each failure.
 */
export function decide(results) {
  const slower = [];
  const empty = [];
  let controlsPassed = 0;
  for (const [workload, summary] of Object.entries(results)) {
    const fns = Object.entries(summary ?? {});
    if (fns.length === 0) empty.push(workload);
    for (const [fn, s] of fns) {
      if (s.verdict === 'slower') slower.push(`${workload}: ${fn} (B/A ${s.ratios.map((r) => r.toFixed(3)).join(' / ')})`);
      if (s.controls?.some(Boolean)) controlsPassed++;
    }
  }
  const why = [];
  if (slower.length) why.push(`slower than base: ${slower.join(', ')}`);
  if (empty.length) why.push(`no function measured: ${empty.join(', ')}`);
  if (controlsPassed === 0) why.push('no control passed anywhere: the instrument failed, nothing was measured');
  return { ok: why.length === 0, why, controlsPassed };
}

async function run(argv) {
  const pos = argv.filter((a) => !a.startsWith('--'));
  const opts = argv.filter((a) => a.startsWith('--') && !a.startsWith('--out='));
  const out = argv.find((a) => a.startsWith('--out='))?.slice(6);
  if (pos.length < 2) throw new Error('usage: ci.mjs <distBase> <distHead> [workload.mjs ...] [--k= --lengths= --out=dir]');
  const [base, head, ...given] = pos;
  const same = sameShippedCode(base, head);
  if (same) {
    console.log(`ab:ci SKIP: ${same}`);
    return true;
  }
  const workloads = given.length ? given.map((w) => resolve(w)) : DEFAULT_WORKLOADS;
  if (out) mkdirSync(out, { recursive: true });
  const results = {};
  for (const w of workloads) {
    const name = basename(w, '.mjs');
    console.log(`##### ${name}`);
    try {
      results[name] = await main([base, head, w, '--k=10', '--lengths=1', ...opts, ...(out ? [`--raw=${join(out, `${name}.json`)}`] : [])]);
    } catch (e) {
      console.log(`  ${name} failed to run: ${String(e?.message ?? e)}`);
      results[name] = {};
    }
  }
  const d = decide(results);
  console.log(`\nab:ci ${d.ok ? 'PASS' : 'FAIL'} (${d.controlsPassed} function(s) with a passing control)`);
  for (const w of d.why) console.log(`  ${w}`);
  return d.ok;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run(process.argv.slice(2)).then(
    (ok) => process.exit(ok ? 0 : 1),
    (e) => {
      console.error(String(e?.message ?? e));
      process.exit(2);
    },
  );
}
