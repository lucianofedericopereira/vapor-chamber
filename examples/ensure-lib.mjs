#!/usr/bin/env node
/**
 * Make an example actually run against the repo's WORKING TREE.
 *
 * `"vapor-chamber": "file:../.."` does not symlink here: the root package has a
 * `prepare` script, so npm packs the library and installs a *copy* into the
 * example's node_modules. That copy is frozen at install time - so after any
 * edit to `src/`, the example silently keeps running the library code from
 * whenever you last ran `npm install`. A bug you just fixed keeps reproducing
 * in the browser, which is a genuinely confusing failure mode.
 *
 * So before every `dev`/`build`: build `dist/` if it's missing, then mirror it
 * into the installed copy and drop Vite's pre-bundle cache (keyed on manifests,
 * not on file contents - it would happily serve the stale bundle otherwise).
 *
 * The root `package.json` is mirrored for the SAME reason, and it is not
 * optional: the frozen copy carries a frozen `exports` map, so a subpath added
 * since the example's last `npm install` is unresolvable no matter how fresh
 * `dist/` is. `vapor-chamber/router/vapor` is exactly that case. Mirroring the
 * files without the map that publishes them reproduces the stale-copy failure
 * this script exists to prevent, one level up.
 */
import { execSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcDist = resolve(repo, 'dist');
const example = process.cwd();
const installed = resolve(example, 'node_modules/vapor-chamber');

if (!existsSync(resolve(srcDist, 'index.js'))) {
  console.log('[example] building vapor-chamber from the repo root ...');
  execSync('npm run build', { cwd: repo, stdio: 'inherit' });
}

if (!existsSync(installed)) {
  console.log('[example] vapor-chamber not installed yet - run `npm install` first.');
  process.exit(0);
}

// A symlinked install (pnpm, yarn, or npm when the root has no prepare script)
// already points at the working tree - there is nothing to mirror.
if (lstatSync(installed).isSymbolicLink()) process.exit(0);

rmSync(resolve(installed, 'dist'), { recursive: true, force: true });
cpSync(srcDist, resolve(installed, 'dist'), { recursive: true });
cpSync(resolve(repo, 'package.json'), resolve(installed, 'package.json'));
rmSync(resolve(example, 'node_modules/.vite'), { recursive: true, force: true });
console.log('[example] synced dist/ + package.json into the installed copy of vapor-chamber');
