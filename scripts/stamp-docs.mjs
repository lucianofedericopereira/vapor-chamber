#!/usr/bin/env node
/**
 * stamp-docs - keep derived values in the docs identical to their source.
 *
 * A TypeScript-era port of the marker idea behind `sigilmd` (same author as
 * this project), owned in-repo and adapted in one important way: sigilmd takes
 * its values from a hand-written table in the document, which makes the
 * document the source of truth. That is exactly the failure this script exists
 * to prevent - the CDN snippets carried `vapor-chamber@1.9` in five places and
 * `@1.12` in two while package.json said 1.14.0, and nothing noticed, because a
 * stale doc is invisible to a test suite. Here the values are READ FROM THE
 * SOURCE (package.json and the built artifacts), so a marker cannot drift: the
 * only way to change what a doc says is to change the thing it describes.
 *
 * Ported rather than depended on, deliberately: Perl is an odd dependency to
 * add to a TS library's toolchain, and reading package.json needs to happen
 * in-process anyway. (An earlier version of this note also cited the repo not
 * being a git checkout; that stopped being true when git became the workflow
 * substrate - see docs/decisions.md - and the port stands on the other legs.)
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
 * artifacts - `docs/metrics.json` and `coverage/coverage-summary.json`, both
 * gitignored (the reporter's header records why committing the counts was
 * measured and rejected). Markers whose source is missing are left untouched,
 * so `--check` still passes on a fresh checkout.
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

/**
 * Marker name -> value, each derived from a source of truth.
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
 * has run in CI. A missing source therefore SKIPS its markers - leaving whatever
 * the doc already says - rather than failing the gate or, worse, stamping a
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
// every doc stale - otherwise running the suite the normal way would break the
// next `lint:check`, which is a gate nobody would keep.
const metrics = readJson('docs/metrics.json');

/**
 * The Vapor outlet's measured saving, published by
 * `tests/vapor/vapor-outlet-size.test.ts`.
 *
 * This one earned its markers the hard way. It is quoted in the CHANGELOG, the
 * ROADMAP, the README, docs/router.md and the whitepaper, it moves whenever
 * anything on the SHARED side of that A/B changes - and it did move, leaving
 * five copies of "20.03" wrong at once, each corrected by hand. A number that
 * a run can compute belongs to the generator, not to five authors.
 *
 * Absent on a fresh checkout (metrics.json is gitignored), which SKIPS these
 * markers rather than blanking them - the same rule every other artifact-backed
 * value here follows.
 */
if (metrics?.outlet) {
  VALUES.outletSaving = metrics.outlet.savedBr;
  VALUES.outletSavingRaw = metrics.outlet.savedRaw;
  VALUES.outletMargin = metrics.outlet.margin;
  VALUES.outletMachineryVapor = metrics.outlet.machineryVapor;
  VALUES.outletMachineryInterop = metrics.outlet.machineryInterop;
}
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

/**
 * Bundle sizes, read from the GENERATED `docs/BUNDLE-SIZES.md`.
 *
 * README and docs/performance.md both carried hand-copied size tables. The
 * README's own footnote admitted what that costs - "this table had drifted low
 * on 7 of 9 rows before it was last reconciled" - and it had drifted again by
 * v1.16.0 (barrel 24.0 vs 24.4, router 12.3 vs 12.4, vue 7.4 vs 7.5, reactive
 * 5.2 vs 5.4, mcp 1.7 vs 1.9, and the performance.md IIFE table a whole release
 * behind at 7.0/7.4/10.2 vs 7.6/8.0/11.0).
 *
 * A number a human retypes is a number that drifts, so these stop being
 * retyped. The source of truth stays `npm run size:doc`; this only republishes
 * its rows into the prose that quotes them.
 */
const sizes = (() => {
  try {
    const md = readFileSync(join(root, 'docs/BUNDLE-SIZES.md'), 'utf8');
    const map = {};
    // `| `./router` | 35.2 | 13.6 | 12.4 |` -> export -> { min, gzip, brotli }
    for (const m of md.matchAll(/^\|\s*`([^`]+)`\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|/gm)) {
      map[m[1]] = { min: m[2], gzip: m[3], brotli: m[4] };
    }
    return Object.keys(map).length ? map : null;
  } catch {
    return null;
  }
})();
if (sizes) {
  const put = (name, key) => { if (sizes[key]) VALUES[name] = sizes[key].brotli; };
  // Variants are quoted with all three columns in README's chooser table, so
  // those get raw/gzip too - same rule: if prose repeats a measured number, the
  // number comes from the generator, not from a human.
  const putAll = (name, key) => {
    if (!sizes[key]) return;
    VALUES[name] = sizes[key].brotli;
    VALUES[`${name}Raw`] = sizes[key].min;
    VALUES[`${name}Gzip`] = sizes[key].gzip;
  };
  put('sizeBarrel', '.');
  put('sizeCore', 'core: createCommandBus alone');
  put('sizeConsumer', 'consumer: createCommandBus + logger + createHttpBridge');
  put('sizeTransports', './transports');
  put('sizeSsr', './ssr');
  put('sizeReactive', './reactive');
  put('sizeVue', './vue');
  put('sizeVapor', './vapor');
  put('sizeOutbox', './outbox');
  put('sizeMcp', './mcp');
  put('sizeStore', './store');
  put('sizeRouter', './router');
  put('sizeRouterVdom', './router/vdom');
  put('sizeRouterVapor', './router/vapor');
  put('sizeRouterRemote', './router/remote');
  put('sizeRouterFetch', './router-fetch');
  putAll('sizeIifeFull', 'vapor-chamber (full)');
  putAll('sizeIifeCore', 'vapor-chamber-core');
  putAll('sizeIifeElements', 'vapor-chamber-elements');
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
const SCAN_FILES = ['README.md', 'CONTRIBUTING.md', 'ROADMAP.md', 'SECURITY.md'];
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
