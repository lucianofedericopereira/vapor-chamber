#!/usr/bin/env node
/**
 * One gate, in the house order, so that a skipped step is a deleted line in a
 * script rather than something somebody forgot.
 *
 *   node scripts/gate.mjs [--expect-stamp-drift]
 *   npm run gate
 *
 * WHY IT EXISTS. The rule "run `npm run docs` after every src-touching commit,
 * comment-only included" has now failed three times (s17.4, s18 baseline, s34.4),
 * and each time the miss was invisible until someone read for it. The same is
 * true of `size:doc` and of `docs:stamp`. A chain that runs them all, in one
 * command, turns a forgotten step into a red line with a name on it.
 *
 * FOUR PROPERTIES IT HAS TO HAVE, each one because its absence is how a gate
 * quietly stops being a gate:
 *
 * 1. DRIFT FAILS. `npm run docs` and `npm run size:doc` REGENERATE files. A gate
 *    that merely runs them repairs the drift and reports green, which is worse
 *    than not running them - it launders the defect. So both are followed by
 *    `git diff --exit-code`, and the chain ends by asserting a clean tree
 *    (`git status --porcelain` empty, untracked included) rather than printing a
 *    status for a person to read.
 *
 * 2. THE STAMP CHECK IS UNCONDITIONAL. It was not, for exactly one commit. When
 *    this script was written `stamp-docs --check` was red on purpose - `vueAligned`
 *    read rc.8 while every pin read rc.9, and four more families were pending - so
 *    the gate carried an `--expect-stamp-drift` flag that accepted a NAMED list and
 *    nothing else. That list earned itself immediately by rejecting `vc:tests` and
 *    `vc:testFiles`, stamped at 2420 / 167 against a real 2448 / 179, which nobody
 *    had noticed. The stamp landed in the commit after, and the flag was deleted
 *    with it: it was a countdown, not a setting, and a second use would have made
 *    it one.
 *
 *    ONE RED IS EXPECTED AND IS NOT A DEFECT: `npm run bench` writes host-specific
 *    ratios into the gitignored `docs/metrics.json`, and `stamp-docs` then reports
 *    every `vc:bench*` marker as stale. Those are never stamped from this tree
 *    (they belong to a clean committed tree - memory stamp-bench-markers-local-only).
 *    Drop the `bench` section from that local file and the check is green again;
 *    do not stamp them, and do not add an exception for them here.
 *
 * 3. FAIL FAST, ONE LINE PER STEP. Each step prints its name and its result, the
 *    chain stops at the first failure, and the last line names the step. Under
 *    `git rebase --exec 'npm run gate'` that identifies the commit AND the step.
 *    Coverage prints its four numbers; size prints headroom per variant; the test
 *    steps print their counts. A step that prints only "ok" cannot be read later.
 *
 * 4. EVERY STEP WAS SEEDED WITH A FAILURE BEFORE THE GATE WAS TRUSTED. The same
 *    rule the fixtures follow: an assertion nobody has watched fail is not known
 *    to work. The seeds used are listed in the commit message that adds this file.
 *
 * WHERE IT IS MEANT TO RUN: on a COMMITTED tree - before a commit lands, on the
 * commit after it, or under `git rebase --exec`. The last step asserts a clean
 * tree, so running it with work in progress ends red at `clean tree` by design;
 * the nine steps before it still report.
 *
 * NOT IN THE CHAIN, deliberately: `npm run bench` (its ratios are host state and
 * would make the gate non-deterministic, and its markers are never stamped here),
 * `check:example` (it drives an example build and belongs to the alignment
 * cycle, not to every commit), and `ab:vue` (needs a second Vue installed).
 * `check:tsc-gap` was listed here until v1.22.0 and is gone: the vue-tsc
 * template gap it tracked needed a directive ARGUMENT, and the reshape removed
 * the argument, so it could no longer report anything about this codebase.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

const t0 = Date.now();
let stepIndex = 0;

function run(cmd, args, { capture = false } = {}) {
  return spawnSync(cmd, args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    shell: false,
  });
}

function fail(step, detail) {
  console.error('');
  console.error(`GATE FAILED at step ${stepIndex}: ${step}`);
  if (detail) console.error(detail);
  console.error(`(${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  process.exit(1);
}

function ok(step, detail) {
  console.log(`ok   ${String(stepIndex).padStart(2)}  ${step.padEnd(14)} ${detail}`);
}

/** Runs one step: prints its heading, then one result line, or fails the chain. */
function step(name, fn) {
  stepIndex += 1;
  console.log(`\n==> ${stepIndex}. ${name}`);
  fn(name);
}

// --- the steps, in the house order ------------------------------------------

step('typecheck', (name) => {
  const r = run('npm', ['run', '--silent', 'typecheck'], { capture: true });
  if (r.status !== 0) fail(name, (r.stdout || '') + (r.stderr || ''));
  ok(name, 'tsc, typecheck project and example patterns: clean');
});

step('build', (name) => {
  const r = run('npm', ['run', '--silent', 'build'], { capture: true });
  if (r.status !== 0) fail(name, (r.stdout || '') + (r.stderr || ''));
  ok(name, 'types and dist emitted');
});

/** Vitest prints "Tests  N passed | M skipped"; report it rather than "ok". */
function testCounts(out) {
  // Anchored: a TEST NAME containing the word "Tests" matched an unanchored
  // pattern on the first run and the step reported a test title as its count.
  const tests = /^\s*Tests\s+(.+)$/m.exec(out);
  const files = /^\s*Test Files\s+(.+)$/m.exec(out);
  const one = (m) => (m ? m[1].replace(/\s+/g, ' ').trim() : '?');
  return `${one(tests)} (files: ${one(files)})`;
}

step('test:run', (name) => {
  const r = run('npx', ['vitest', 'run'], { capture: true });
  const out = (r.stdout || '') + (r.stderr || '');
  if (r.status !== 0) fail(name, out.slice(-4000));
  ok(name, testCounts(out));
});

step('test:vapor', (name) => {
  const r = run('npx', ['vitest', 'run', '-c', 'vitest.vapor.config.ts'], { capture: true });
  const out = (r.stdout || '') + (r.stderr || '');
  if (r.status !== 0) fail(name, out.slice(-4000));
  ok(name, testCounts(out));
});

step('size:check', (name) => {
  const r = run('node', ['scripts/check-size.mjs'], { capture: true });
  const out = (r.stdout || '') + (r.stderr || '');
  if (r.status !== 0) fail(name, out);
  // Print headroom per variant rather than a bare pass: a budget met exactly and
  // a budget met with 200 B to spare are different facts.
  const rows = out
    .split('\n')
    .filter((l) => /\.iife\.min\.js|\.iife\.min\.js/.test(l) || /iife/.test(l))
    .map((l) => l.trim().replace(/\s{2,}/g, ' '))
    .filter(Boolean);
  ok(name, 'all variants under budget');
  for (const row of rows) console.log(`        ${row}`);
});

/**
 * `lint:check` chains with `&&` and `stamp-docs --check` sits fourth of five, so a
 * stamp failure has always hidden `check-ascii` behind it (s14). The gate runs the
 * pieces itself so every one of them reports, and gives the stamp check its own
 * step, which is also where the exception lives.
 */
step('lint', (name) => {
  const pieces = [
    ['biome', ['check', 'src', 'tests', 'scripts', 'bin'], 'npx'],
    ['scripts/check-env-guards.mjs', [], 'node'],
    // Added to `lint:check` by rc9/58 and NOT here, which is the failure this
    // list invites: the gate enumerates the pieces by hand, so a check wired
    // into the npm script is invisible to `npm run gate` until someone copies
    // it across. A console-shape violation would have passed every gate run.
    ['scripts/check-console-shape.mjs', [], 'node'],
    ['scripts/check-line-citations.mjs', [], 'node'],
    ['scripts/check-doc-claims.mjs', [], 'node'],
    ['scripts/check-ascii.mjs', [], 'node'],
  ];
  const failures = [];
  for (const [bin, args, runner] of pieces) {
    const r = run(runner, [bin, ...args], { capture: true });
    const label = bin.replace('scripts/', '').replace('.mjs', '');
    if (r.status !== 0) failures.push(`${label}:\n${(r.stdout || '') + (r.stderr || '')}`);
  }
  if (failures.length > 0) fail(name, failures.join('\n'));
  // Derived from the list, not retyped: this line said "biome, env-guards,
  // line-citations, doc-claims, ascii" while the list had six entries, which is
  // the same drift the list itself just suffered.
  ok(name, pieces.map(([bin]) => bin.replace('scripts/check-', '').replace('.mjs', '')).join(', '));
});

step('coverage', (name) => {
  // npx, not `npm run test:coverage`: eight A/B files skip themselves on that
  // lifecycle name, and their absence changes the counts a later stamp publishes
  // (s20.0). The gate measures what the audit method measures.
  const r = run('npx', ['vitest', 'run', '--coverage'], { capture: true });
  const out = (r.stdout || '') + (r.stderr || '');
  if (r.status !== 0) fail(name, out.slice(-4000));
  const summaryPath = 'coverage/coverage-summary.json';
  if (!existsSync(summaryPath)) fail(name, `no ${summaryPath} after a coverage run`);
  const total = JSON.parse(readFileSync(summaryPath, 'utf8')).total;
  const axes = ['statements', 'branches', 'functions', 'lines'];
  const read = axes.map((a) => `${a} ${total[a].pct} (${total[a].covered}/${total[a].total})`);
  const below = axes.filter((a) => total[a].pct !== 100);
  // The vitest thresholds sit at 98 so a real regression can be seen before it is
  // enforced; the house requirement is 100 on all four, so the gate asserts that.
  if (below.length > 0) fail(name, `below 100: ${below.join(', ')}\n  ${read.join('\n  ')}`);
  ok(name, `100 x4 - ${read.join(', ')}`);
});

step('stamp check', (name) => {
  const r = run('node', ['scripts/stamp-docs.mjs', '--check'], { capture: true });
  const out = (r.stdout || '') + (r.stderr || '');
  if (r.status === 0) {
    ok(name, 'all markers current');
    return;
  }
  // Stale is stale. The one expected case - `npm run bench` filling the gitignored
  // metrics file with host ratios - is fixed by dropping that file's `bench`
  // section, never by stamping it and never by an exception here (see the header).
  const stale = [...out.matchAll(/^\s*(\S+): vc:(\w+) /gm)];
  const hint =
    stale.length > 0 && stale.every((m) => m[2].startsWith('bench'))
      ? '\nAll of these are vc:bench* - local `npm run bench` output. Drop the `bench` section from docs/metrics.json; do not stamp them.'
      : '';
  fail(name, out + hint);
});

step('docs', (name) => {
  const r = run('npm', ['run', '--silent', 'docs'], { capture: true });
  if (r.status !== 0) fail(name, (r.stdout || '') + (r.stderr || ''));
  // Scoped to what this step regenerates. An unscoped `git diff` here blamed the
  // docs for an unrelated edit sitting in the tree - a gate that names the wrong
  // step is worse than one that does not fire. Everything else is the last step's.
  const d = run('git', ['diff', '--exit-code', '--stat', '--', 'docs/api'], { capture: true });
  if (d.status !== 0) {
    fail(name, `docs/api regenerated with a diff - it was stale:\n${d.stdout || ''}`);
  }
  ok(name, 'docs/api regenerated, no diff');
});

step('size:doc', (name) => {
  const r = run('npm', ['run', '--silent', 'size:doc'], { capture: true });
  if (r.status !== 0) fail(name, (r.stdout || '') + (r.stderr || ''));
  const d = run('git', ['diff', '--exit-code', '--stat', '--', 'docs/BUNDLE-SIZES.md'], {
    capture: true,
  });
  if (d.status !== 0) {
    fail(name, `docs/BUNDLE-SIZES.md regenerated with a diff - it was stale:\n${d.stdout || ''}`);
  }
  ok(name, 'docs/BUNDLE-SIZES.md regenerated, no diff');
});

step('clean tree', (name) => {
  const r = run('git', ['status', '--porcelain'], { capture: true });
  const dirty = (r.stdout || '').trim();
  if (dirty !== '') {
    fail(name, `the tree is not clean (untracked files included):\n${dirty}`);
  }
  ok(name, 'nothing modified, nothing untracked');
});

console.log(`\nGATE GREEN - ${stepIndex} steps, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
