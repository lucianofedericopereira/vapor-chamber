#!/usr/bin/env node
/**
 * stamp-docs — keep derived values in the docs identical to their source.
 *
 * A TypeScript-era port of the marker idea behind `sigilmd` (same author as
 * this project), owned in-repo and adapted in one important way: sigilmd takes
 * its values from a hand-written table in the document, which makes the
 * document the source of truth. That is exactly the failure this script exists
 * to prevent — the CDN snippets carried `vapor-chamber@1.9` in five places and
 * `@1.12` in two while package.json said 1.14.0, and nothing noticed, because a
 * stale doc is invisible to a test suite. Here the values are READ FROM THE
 * SOURCE (package.json and the built artifacts), so a marker cannot drift: the
 * only way to change what a doc says is to change the thing it describes.
 *
 * Ported rather than depended on, deliberately: this repo is not a git checkout
 * (so the GitHub Action form cannot run here at all), Perl is an odd dependency
 * to add to a TS library's toolchain, and reading package.json needs to happen
 * in-process anyway.
 *
 * MARKERS. A begin/end pair; this script owns everything between them.
 *
 *     <!-- vc:version -->1.14.0<!-- /vc:version -->
 *
 * The pair is HTML-comment shaped, so it works unchanged in Markdown and in
 * the plain-HTML examples, and renders as nothing on GitHub.
 *
 * USAGE
 *   node scripts/stamp-docs.mjs            # rewrite stale markers in place
 *   node scripts/stamp-docs.mjs --check    # exit 1 if any marker is stale
 *
 * `--check` is the CI shape used by check-size.mjs / check-env-guards.mjs, and
 * mirrors the `--check` mode the original tools expose.
 *
 * Adding a value: put it in VALUES below. Anything derivable from a file the
 * repo already produces belongs here; anything a human must decide does not.
 *
 * Two sources feed it: package.json (always present) and the test run's own
 * artifacts — `docs/metrics.json` (committed, written by
 * scripts/test-counts-reporter.mjs) and `coverage/coverage-summary.json`
 * (gitignored). Markers whose source is missing are left untouched, so
 * `--check` still passes on a fresh checkout.
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

/**
 * Marker name → value, each derived from a source of truth.
 *
 * `vueAligned` reads the devDependency rather than being typed by hand: it is
 * the version the suite actually ran against this cycle, which is the only
 * honest thing for a doc to claim.
 */
const VALUES = {
  version: pkg.version,
  vueAligned: String(pkg.devDependencies?.vue ?? '').replace(/^[\^~]/, ''),
};

/**
 * Values derived from artifacts the TEST RUN produces, added separately because
 * they can be absent: a fresh checkout has `docs/metrics.json` (committed) but
 * not `coverage/` (gitignored), and `lint:check` runs `--check` before any test
 * has run in CI. A missing source therefore SKIPS its markers — leaving whatever
 * the doc already says — rather than failing the gate or, worse, stamping a
 * placeholder over a real number. Only a source that exists can make a marker
 * stale, which is the property that keeps `--check` honest.
 */
function readJson(path) {
  try {
    return JSON.parse(readFileSync(join(root, path), 'utf8'));
  } catch {
    return null;
  }
}

// Only a COMPLETE run is comparable to what the docs claim: 8 test files skip
// without `dist/`, 2 more without coverage. The reporter records both facts, so
// data from an ordinary `npm run test:run` is ignored here instead of marking
// every doc stale — otherwise running the suite the normal way would break the
// next `lint:check`, which is a gate nobody would keep.
const metrics = readJson('docs/metrics.json');
const main = metrics?.default?.dist && metrics.default.coverage ? metrics.default : null;
const vapor = metrics?.vapor?.dist ? metrics.vapor : null;
if (main) {
  VALUES.tests = String(main.passed);
  VALUES.testFiles = String(main.files);
  // Both projects, the shape the whitepaper's alignment log states.
  if (vapor) {
    VALUES.testsAll = `${main.passed} + ${vapor.passed}`;
    VALUES.testFilesAll = String(main.files + vapor.files);
  }
}

// Gated on the same provenance: a coverage summary written by a run without
// `dist/` reports lower numbers for the same reason the counts do.
const coverage = main ? readJson('coverage/coverage-summary.json')?.total : null;
if (coverage) {
  const pct = (metric) => coverage[metric].pct.toFixed(1);
  VALUES.covStatements = pct('statements');
  VALUES.covBranches = pct('branches');
  VALUES.covFunctions = pct('functions');
  VALUES.covLines = pct('lines');
}

const SCAN_DIRS = ['docs', 'examples'];
const SCAN_FILES = ['README.md', 'CONTRIBUTING.md', 'ROADMAP.md'];
const EXTS = ['.md', '.html'];

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.astro') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (EXTS.some((e) => entry.endsWith(e))) out.push(full);
  }
  return out;
}

const files = [
  ...SCAN_FILES.map((f) => join(root, f)),
  ...SCAN_DIRS.flatMap((d) => walk(join(root, d))),
].filter((f) => {
  try {
    return statSync(f).isFile();
  } catch {
    return false;
  }
});

const check = process.argv.includes('--check');
const stale = [];
let rewritten = 0;

for (const file of files) {
  const before = readFileSync(file, 'utf8');
  let after = before;

  for (const [name, value] of Object.entries(VALUES)) {
    // Non-greedy body, so several markers of the same name in one file each
    // keep their own boundaries.
    const re = new RegExp(`(<!--\\s*vc:${name}\\s*-->)([\\s\\S]*?)(<!--\\s*/vc:${name}\\s*-->)`, 'g');
    after = after.replace(re, (whole, open, body, close) => {
      if (body === value) return whole;
      stale.push(`${relative(root, file)}: vc:${name} is "${body}", source says "${value}"`);
      return `${open}${value}${close}`;
    });
  }

  if (after !== before && !check) {
    writeFileSync(file, after);
    rewritten++;
  }
}

if (check) {
  if (stale.length) {
    console.error('stamp-docs: stale markers found\n  ' + stale.join('\n  '));
    console.error('\nRun `npm run docs:stamp` to update them.');
    process.exit(1);
  }
  console.log(`stamp-docs: OK (${files.length} files scanned, all markers current)`);
} else {
  console.log(
    stale.length
      ? `stamp-docs: updated ${stale.length} marker(s) across ${rewritten} file(s)`
      : `stamp-docs: OK (${files.length} files scanned, nothing to update)`,
  );
}
