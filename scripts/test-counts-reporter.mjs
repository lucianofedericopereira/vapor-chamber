/**
 * vapor-chamber — vitest reporter that records nothing but counts.
 *
 * WHY THIS EXISTS. `stamp-docs.mjs` can only own a value that some file the
 * repo produces already states. Coverage percentages have such a file
 * (`coverage/coverage-summary.json`); test counts did not — so README and the
 * whitepaper carried hand-typed totals that drifted every release (1491 → 1750
 * across one cycle, in two places each). The whitepaper even documents deleting
 * a per-file inventory for drifting four times, and then its own summary line
 * drifted anyway. This closes that loop: the numbers become derived.
 *
 * Vitest's built-in `json` reporter would work but writes ~533 KB of per-test
 * detail; this writes ~200 bytes.
 *
 * NOT COMMITTED (see .gitignore), and that is a measured decision rather than a
 * preference — the count is not one number, it depends on what else has run:
 *
 *     build + coverage   1748 passed / 113 files   <- canonical, see below
 *     build, no coverage 1750 / 114                (2 more tests run)
 *     no build           1720 / 107                (8 files skip without dist/)
 *
 * `prepublishOnly` runs `test:run` BEFORE `build`, so a committed file would
 * flip to the no-build numbers on every release and fail the next `lint:check`
 * for a reason that has nothing to do with the suite. Since stamp-docs SKIPS
 * markers whose source is missing, leaving this file out of the repo means CI
 * passes untouched while local stamping still derives real numbers.
 *
 * CANONICAL: stamp from a built tree WITH coverage, so the test counts and the
 * coverage percentages in the same sentence come from the same run — which is
 * also the run docs/COVERAGE.md describes:
 *
 *     npm run build && npm run test:coverage && npm run test:vapor && npm run docs:stamp
 *
 * Both vitest projects write here, each under its own key, so the default and
 * vapor projects can be reported separately or summed without either run
 * clobbering the other's numbers.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const OUT = 'docs/metrics.json';

/**
 * Count from Vitest 4's Reported Task API (`onTestRunEnd`). Kept behind a
 * capability check rather than a version check — the older `onFinished(files)`
 * shape is walked instead when `children.allTests` is not there.
 */
function countModules(modules) {
  let files = 0;
  let filesTotal = 0;
  let tests = 0;
  let passed = 0;
  let skipped = 0;
  for (const mod of modules) {
    filesTotal++;
    let ran = false;
    for (const test of mod.children.allTests()) {
      tests++;
      const state = test.result()?.state;
      if (state === 'passed') { passed++; ran = true; }
      else if (state === 'skipped' || state === 'pending') skipped++;
      else ran = true;
    }
    // `files` counts modules that actually RAN something, matching vitest's own
    // "114 passed | 1 skipped" split — and matching `passed`, so a doc pairing
    // the two ("N tests across M files") is not quietly mixing a passed count
    // with a total. `filesTotal` keeps the other number available.
    if (ran) files++;
  }
  return { files, filesTotal, tests, passed, skipped };
}

/** Fallback: walk the legacy task tree from `onFinished(files)`. */
function countTasks(fileTasks) {
  let files = 0;
  let filesTotal = 0;
  let tests = 0;
  let passed = 0;
  let skipped = 0;
  let ran = false;
  const walk = (tasks) => {
    for (const task of tasks ?? []) {
      if (task.type === 'suite') walk(task.tasks);
      else {
        tests++;
        const state = task.result?.state ?? task.mode;
        if (state === 'pass' || state === 'passed') { passed++; ran = true; }
        else if (state === 'skip' || state === 'todo' || state === 'skipped') skipped++;
        else ran = true;
      }
    }
  };
  for (const file of fileTasks ?? []) {
    filesTotal++;
    ran = false;
    walk(file.tasks);
    if (ran) files++;
  }
  return { files, filesTotal, tests, passed, skipped };
}

/**
 * PROVENANCE, recorded rather than assumed. The counts are only comparable to
 * what the docs claim when the run was complete: `dist/` present (8 files skip
 * without it) and coverage on (2 more skip without it, and it is the run
 * docs/COVERAGE.md describes). stamp-docs ignores data that says otherwise, so
 * an ordinary `npm run test:run` can write this file freely without making the
 * next `lint:check` fail — which is exactly what it did before this existed.
 */
function write(key, counts) {
  // Merge rather than overwrite: the two projects run as separate processes.
  let existing = {};
  if (existsSync(OUT)) {
    try {
      existing = JSON.parse(readFileSync(OUT, 'utf8'));
    } catch {
      existing = {}; // unreadable/partial — regenerate from this run
    }
  }
  const next = { ...existing, [key]: counts };
  // Stable key order so the committed file has no spurious diffs.
  const ordered = Object.fromEntries(Object.keys(next).sort().map((k) => [k, next[k]]));
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(ordered, null, 2)}\n`);
}

/**
 * Only a WHOLE-suite run may write the file. `vitest run tests/one.test.ts`
 * (or `-t pattern`) is the normal inner-loop command, and letting it record
 * "1 file, 10 tests" would clobber the committed totals and fail the next
 * `stamp-docs --check` for no reason. Detected from the CLI's own filters:
 * anything positional after the subcommand, or a name-pattern flag.
 */
function isFilteredRun(argv = process.argv.slice(2)) {
  const SUBCOMMANDS = new Set(['run', 'watch', 'dev', 'bench', 'related', 'list']);
  // Flags whose VALUE is the next argv entry. Without this, `vitest run -c
  // vitest.vapor.config.ts` reads its own config path as a positional filter
  // and the vapor project silently records nothing — which is exactly what it
  // did until this list existed.
  const TAKES_VALUE = new Set([
    '-c', '--config', '-r', '--root', '--reporter', '--outputFile', '--project',
    '--environment', '--shard', '--retry', '--mode', '--coverage.provider',
  ]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-t' || arg === '--testNamePattern') return true;
    if (arg.startsWith('--testNamePattern=')) return true;
    if (TAKES_VALUE.has(arg)) { i++; continue; } // skip the flag AND its value
    if (arg.startsWith('-')) continue; // other flags, incl. their `=value` forms
    if (SUBCOMMANDS.has(arg)) continue;
    return true; // a positional path/pattern filter
  }
  return false;
}

export default class TestCountsReporter {
  constructor(options = {}) {
    this.key = options.key ?? 'default';
    this.skip = isFilteredRun();
    this.coverage = false;
  }

  onInit(ctx) {
    this.coverage = Boolean(ctx?.config?.coverage?.enabled);
  }

  /** Counts plus the two facts that decide whether they are comparable. */
  record(counts) {
    write(this.key, { ...counts, dist: existsSync('dist'), coverage: this.coverage });
  }

  onTestRunEnd(testModules) {
    if (this.skip) return;
    if (!testModules?.[0]?.children?.allTests) return; // not this API shape
    this.record(countModules(testModules));
    this.done = true;
  }

  onFinished(files) {
    if (this.skip || this.done) return; // filtered, or onTestRunEnd handled it
    this.record(countTasks(files));
  }
}
