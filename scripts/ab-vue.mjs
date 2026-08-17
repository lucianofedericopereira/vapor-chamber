#!/usr/bin/env node
/**
 * ab-vue — same-process A/B of the installed Vue against a BASELINE version.
 *
 * Why this exists. "No regressions" was being asserted each Vue cycle rather
 * than measured, because the honest measurement is awkward: two Vue versions
 * have to run in ONE process, interleaved, or host drift and thermal state
 * swamp a 1-3% signal. Comparing a fresh bench run against numbers recorded in
 * a previous release is not a measurement — single-host bench output swings
 * 20-30% run to run. That gap is how a documented figure once drifted ~10x
 * (`crypto.randomUUID` at "~1-2µs", actually ~104ns) without anyone noticing.
 *
 * What it does: packs the baseline Vue from npm, extracts its prod with-vapor
 * dist next to the tests, and runs `tests/vue-version-ab.test.ts`, which loads
 * BOTH dists in one process and interleaves AB/BA rounds over the reactivity
 * primitives this library actually sits on.
 *
 * Usage:
 *   node scripts/ab-vue.mjs 3.6.0-rc.3      # compare installed vue against rc.3
 *   npm run ab:vue -- 3.6.0-rc.3
 *
 * The extracted baseline lands in tests/__ref/ (never published — package.json
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
  console.log(`[ab-vue] packing vue@${version} …`);
  work = mkdtempSync(join(tmpdir(), 'vc-ab-'));
  execFileSync('npm', ['pack', `vue@${version}`, '--silent'], { cwd: work, stdio: 'inherit' });
  const tgz = readdirSync(work).find((f) => f.endsWith('.tgz'));
  if (!tgz) throw new Error(`npm pack produced no tarball for vue@${version}`);
  execFileSync('tar', ['xzf', tgz], { cwd: work });

  const src = join(work, 'package', 'dist', DIST);
  if (!existsSync(src)) {
    throw new Error(`vue@${version} has no ${DIST} — versions before 3.6 have no vapor build.`);
  }
  mkdirSync(refDir, { recursive: true });
  copyFileSync(src, refFile);
  console.log(`[ab-vue] baseline ready: ${refFile}`);

  execFileSync('npx', ['vitest', 'run', 'tests/vue-version-ab.test.ts', '--silent=false'], {
    stdio: 'inherit',
    env: { ...process.env, VC_AB_BASELINE: `./__ref/vue-${version}.js`, VC_AB_VERSION: version },
  });
} catch (err) {
  console.error(`[ab-vue] ${err.message}`);
  process.exitCode = 1;
} finally {
  // The baseline is a build artifact, not a fixture — never leave it behind to
  // rot into a stale comparison nobody remembers pinning.
  rmSync(refDir, { recursive: true, force: true });
  if (work) rmSync(work, { recursive: true, force: true });
}
