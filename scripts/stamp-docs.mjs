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
 * in-process anyway.
 *
 * MARKERS. A begin/end pair; this script owns everything between them.
 *
 *     <!-- vc:version -->1.14.0<!-- /vc:version -->
 *
 * The pair is HTML-comment shaped, so it works unchanged in Markdown and in
 * the plain-HTML examples, and renders as nothing on GitHub.
 *
 * PINS. A marker may carry an npm range after `@`, repeated on the closing tag,
 * and is stamped only while package.json's version satisfies it, prereleases
 * included. Outside the range its value is frozen as written, and a range no
 * version satisfies, or one that starts above the current version, fails the run.
 *
 *     <!-- vc:sizeCore@1.30 -->4.8<!-- /vc:sizeCore@1.30 -->
 *
 * USAGE
 *   node scripts/stamp-docs.mjs            # rewrite stale markers in place
 *   node scripts/stamp-docs.mjs --check    # write nothing; exit 1 if any marker is stale
 *
 * `--check` is the mode `lint:check` runs. A bad pin (see PINS) exits 1 in both
 * modes.
 *
 * Scope: markers in README.md, CONTRIBUTING.md, ROADMAP.md, SECURITY.md and in
 * the .md, .html and .php files under docs/ and examples/. CHANGELOG.md is not
 * scanned. It also keeps each examples/*\/package.json `vue` range equal to the
 * root devDependency.
 *
 * Adding a value: put it in VALUES below. Anything derivable from a file the
 * repo already produces belongs here; anything a human must decide does not.
 *
 * Three sources feed it: package.json (always present), the generated
 * `docs/BUNDLE-SIZES.md` (committed), and the test run's own artifacts -
 * `docs/metrics.json` and `coverage/coverage-summary.json`, both gitignored
 * (the reporter's header records why committing the counts was measured and
 * rejected). Markers whose source is missing are left untouched, so `--check`
 * still passes on a fresh checkout.
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import semver from 'semver';

const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

/**
 * Marker name -> value, each derived from a source of truth.
 *
 * `vueAligned` reads the devDependency rather than being typed by hand: it is
 * the version the suite actually runs against, which is the only honest thing
 * for a doc to claim.
 */
const VALUES = {
  version: pkg.version,
  vueAligned: String(pkg.devDependencies?.vue ?? '').replace(/^[\^~]/, ''),
};

/**
 * Values derived from artifacts the TEST RUN produces, added separately because
 * they can be absent. BOTH sources are gitignored - `coverage/`, and
 * `docs/metrics.json` (see .gitignore), which records why: the counts depend on
 * what else has run, so a committed copy would churn. A fresh checkout
 * therefore has NEITHER, and `lint:check` runs `--check` before any test has
 * run in CI. A missing source SKIPS its markers - leaving whatever the doc
 * already says - rather than failing the gate or, worse, stamping a placeholder
 * over a real number. Only a source that exists can make a marker stale, which
 * is the property that keeps `--check` honest.
 *
 * `docs/metrics.json` is NOT committed (.gitignore), which is the one cost
 * worth knowing: a marker whose source is absent renders exactly like a
 * current one, and `--check` calls it current having had nothing to compare
 * it against. The `vc:bench*` markers are that set. Run `npm run bench:bands`
 * before trusting one.
 */
function readJson(path) {
  try {
    return JSON.parse(readFileSync(join(root, path), 'utf8'));
  } catch {
    return null;
  }
}

// Only a COMPLETE run is comparable to what the docs claim: the docs carry the
// counts of a run that had `dist/` and was instrumented for coverage (the
// measure-only timing tests skip under coverage and in every run without
// VC_TIMING, tests/under-coverage.ts). The reporter records both facts, so data
// from an ordinary `npm run test:run` is ignored here instead of marking every
// doc stale, which would break the next `lint:check`.
const metrics = readJson('docs/metrics.json');

/**
 * The Vapor outlet's measured saving, published by
 * `tests/vapor/vapor-outlet-size.test.ts`.
 *
 * This one earned its markers the hard way. It is quoted in the ROADMAP, docs/router.md, manual chapter 6, the whitepaper and the alignment log, it moves whenever
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
  // The LIMITS themselves, not just the results: two limits, declared once each
  // at OWN_ARM_CEILING_KB and SAVING_FLOOR_KB in
  // tests/vapor/vapor-outlet-size.test.ts and published from there, so no
  // document carries a hand-copied bar.
  VALUES.outletOwnArm = metrics.outlet.ownArm;
  VALUES.outletOwnArmCeiling = metrics.outlet.ownArmCeiling;
  VALUES.outletFloor = metrics.outlet.floor;
  VALUES.outletMachineryVapor = metrics.outlet.machineryVapor;
  VALUES.outletMachineryInterop = metrics.outlet.machineryInterop;
}
/**
 * Bench ratios from `npm run bench:bands` (`scripts/bench-bands.mjs`, over N
 * runs of `scripts/bench-ratios-reporter.mjs`): a ratio of this library's own
 * rows is the median, a ratio against a peer library the band "min-max", and
 * `benchProvenance` says on what machine, Node, peer versions and how many runs.
 *
 * The migration guides quote these, and until this existed they were the one
 * class of number in the docs with no generator - which the guide itself said
 * out loud, and which had already drifted. The `bench*Ns` / `bench*PerFrame`
 * costs are host state, so a doc quotes them only beside `benchProvenance`,
 * which names the machine.
 *
 * Absent unless someone ran the bands locally, and absent means SKIP, so CI and
 * a fresh checkout leave whatever the doc says untouched. A single
 * `npm run bench` writes `benchRun`, which nothing here reads.
 */
if (metrics?.bench) {
  for (const [name, value] of Object.entries(metrics.bench)) VALUES[name] = String(value);
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
 * README and docs/performance.md quote size tables.
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
  // Variants are quoted with all three columns in manual chapter 8, "Pick a variant" chooser table, so
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
  put('sizeConsumer', 'consumer: createAsyncCommandBus + logger + httpTransport');
  put('sizeTransports', './transports');
  put('sizeSsr', './ssr');
  put('sizeReactive', './reactive');
  put('sizeVue', './vue');
  put('sizeVapor', './vapor');
  put('sizeOutbox', './outbox');
  put('sizeMcp', './mcp');
  // The store guide quotes the minified size too (its design estimate was raw KB).
  putAll('sizeStore', './store');
  put('sizeRouter', './router');
  put('sizeRouterVdom', './router/vdom');
  put('sizeRouterVapor', './router/vapor');
  put('sizeRouterRemote', './router/remote');
  put('sizeRouterFetch', './router-fetch');
  // Vapor wiring deltas (Vue bundled) and the mitt comparison - rows of
  // BUNDLE-SIZES, so the manual chapter 1 and the whitepaper's `vapor-entry` footnote
  // "~200 bytes" are never retyped. The Raw variants carry the
  // minified figure the README quotes.
  putAll('sizeVaporEntry', 'vapor-chamber/vapor over that');
  putAll('sizeVaporCustomElement', '+ defineVaporCustomElement');
  putAll('sizeVaporInterop', '+ vaporInteropPlugin');
  put('sizeMitt', 'mitt');
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
// `.php` for the Blade views in examples/laravel-app: Blade passes HTML
// comments through untouched, so a marker works there exactly as it does in
// Markdown and plain HTML - which is the same reason `.html` is here. The
// runnable Laravel demo pins Vue by CDN URL rather than vendoring a copy of the
// dist, and that URL carries the version; a pin a human retypes is a pin that
// drifts from the library's own devDependency.
const EXTS = ['.md', '.html', '.php'];

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

/**
 * The examples' `vue` pin, owned by the same source as `vc:vueAligned`.
 *
 * Markers cannot reach here: a `package.json` has nowhere to put an HTML
 * comment, so the two Vapor examples carried their own literal `vue` range and
 * an RC bump had TWO points of change - the root devDependency the suite runs
 * against, and each example that the ritual then requires rebuilding, because
 * compiled output is where compiler-vapor changes actually land. Miss one and
 * the example builds against a different Vue than the library was verified on,
 * which is precisely the mismatch nobody notices until the output differs.
 *
 * Same rule as every marker above, different mechanism: the value is READ FROM
 * THE SOURCE and written into the derived file, so the only way to change what
 * an example pins is to change what the library aligns to. Examples with no
 * `vue` dependency (exo-astro) are skipped rather than gaining one.
 */
const VUE_RANGE = String(pkg.devDependencies?.vue ?? '');

function examplePinFiles() {
  const dir = join(root, 'examples');
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .map((entry) => join(dir, entry, 'package.json'))
    .filter((file) => {
      try {
        return statSync(file).isFile();
      } catch {
        return false;
      }
    });
}

// A prerelease of 1.31 satisfies `@1.31`, so a pin stamps during its RC.
const PIN = { includePrerelease: true };

/**
 * One file's text with every marker named in `values` stamped. Returns the new
 * text, the stale lines (`<file>: vc:<name> is ...`, the shape gate.mjs reads)
 * and the errors. Pure, so tests/stamp-docs-pin.test.ts drives it on strings.
 */
export function stampMarkers(text, values, version, file) {
  const stale = [];
  const errors = [];
  // Every pin is checked, not only the ones whose value this run has: on a fresh
  // checkout the test counts have no source, and a typo must still fail there.
  for (const [, name, range] of text.matchAll(/<!--\s*vc:(\w+)@((?:(?!-->)[^\n])+?)\s*-->/g)) {
    const min = semver.validRange(range) && semver.minVersion(range, PIN);
    if (!min) errors.push(`${file}: vc:${name}@${range} is not an npm range any version satisfies`);
    else if (semver.gt(min, version)) errors.push(`${file}: vc:${name}@${range} starts above package.json version ${version}`);
  }
  let after = text;
  for (const [name, value] of Object.entries(values)) {
    // Non-greedy body, so several markers of the same name in one file each
    // keep their own boundaries. Group 2 is the optional `@range`, and the
    // closing tag must repeat it (`\2`), so two pins of one name never cross.
    const re = new RegExp(
      `(<!--\\s*vc:${name}(@(?:(?!-->)[^\\n])+?)?\\s*-->)([\\s\\S]*?)(<!--\\s*/vc:${name}\\2\\s*-->)`,
      'g',
    );
    after = after.replace(re, (whole, open, pin, body, close) => {
      if (pin && !semver.satisfies(version, pin.slice(1), PIN)) return whole;
      if (body === value) return whole;
      stale.push(`${file}: vc:${name} is "${body}", source says "${value}"`);
      return `${open}${value}${close}`;
    });
  }
  return { text: after, stale, errors };
}

// Run only as a CLI. Importing this module must not write the docs and must not
// call process.exit() - tests/stamp-docs-pin.test.ts imports stampMarkers().
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check');
  const stale = [];
  const errors = [];
  let rewritten = 0;

  if (VUE_RANGE) {
    for (const file of examplePinFiles()) {
      const before = readFileSync(file, 'utf8');
      // Targeted replace rather than parse/serialize: rewriting the JSON would
      // reformat files a human maintains.
      const after = before.replace(/("vue"\s*:\s*")([^"]+)(")/, (whole, open, body, close) => {
        if (body === VUE_RANGE) return whole;
        stale.push(`${relative(root, file)}: "vue" is "${body}", root devDependency says "${VUE_RANGE}"`);
        return `${open}${VUE_RANGE}${close}`;
      });
      if (after !== before && !check) {
        writeFileSync(file, after);
        rewritten++;
      }
    }
  }

  for (const file of files) {
    const before = readFileSync(file, 'utf8');
    const result = stampMarkers(before, VALUES, pkg.version, relative(root, file));
    stale.push(...result.stale);
    errors.push(...result.errors);

    if (result.text !== before && !check) {
      writeFileSync(file, result.text);
      rewritten++;
    }
  }

  if (check) {
    if (stale.length) {
      console.error('stamp-docs: stale markers found\n  ' + stale.join('\n  '));
      console.error('\nRun `npm run docs:stamp` to update them.');
    } else if (!errors.length) {
      console.log(`stamp-docs: OK (${files.length} files scanned, all markers current)`);
    }
  } else if (stale.length) {
    console.log(`stamp-docs: updated ${stale.length} marker(s) across ${rewritten} file(s)`);
  } else if (!errors.length) {
    console.log(`stamp-docs: OK (${files.length} files scanned, nothing to update)`);
  }
  // A bad pin is a doc error stamping cannot fix, so it fails both modes.
  if (errors.length) console.error('stamp-docs: bad pinned markers\n  ' + errors.join('\n  '));
  if (errors.length || (check && stale.length)) process.exit(1);
}
