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
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcDist = resolve(repo, 'dist');
const example = process.cwd();

if (!existsSync(resolve(srcDist, 'index.js'))) {
  console.log('[example] building vapor-chamber from the repo root ...');
  execSync('npm run build', { cwd: repo, stdio: 'inherit' });
}

/**
 * Find the install the EXAMPLE would actually load, not the one it might have.
 *
 * This looked only in `<example>/node_modules/vapor-chamber`, which under npm
 * WORKSPACES does not exist: the dependency is hoisted to the repo root. So
 * the check failed on all three examples, every run printed
 * "vapor-chamber not installed yet - run `npm install` first" - which is both
 * false and alarming - and the script exited before doing any of its work.
 *
 * It got away with it because the hoisted entry is a SYMLINK back to the repo,
 * so the examples were already reading the live working tree and needed no
 * mirroring at all. The message was the only symptom, and it pointed the
 * reader at a fix ("run npm install") for a problem they did not have.
 *
 * Resolving the way Node resolves answers the real question - where does this
 * example's `import 'vapor-chamber'` land - instead of guessing at a path.
 */
function findInstall() {
  try {
    const require = createRequire(resolve(example, 'noop.js'));
    return dirname(require.resolve('vapor-chamber/package.json'));
  } catch {
    return null;
  }
}

const installed = findInstall();
if (!installed) {
  console.log('[example] vapor-chamber does not resolve from here - run `npm install` at the repo root.');
  process.exit(0);
}

// A symlinked install (npm workspaces, pnpm, yarn) already points at the
// working tree - there is nothing to mirror. Checked on the node_modules ENTRY
// rather than the resolved directory, since resolution follows the link.
const entry = resolve(example, 'node_modules/vapor-chamber');
const hoisted = resolve(repo, 'node_modules/vapor-chamber');
for (const link of [entry, hoisted]) {
  if (existsSync(link) && lstatSync(link).isSymbolicLink()) {
    console.log('[example] vapor-chamber is symlinked to the working tree - nothing to mirror');
    process.exit(0);
  }
}

rmSync(resolve(installed, 'dist'), { recursive: true, force: true });
cpSync(srcDist, resolve(installed, 'dist'), { recursive: true });
cpSync(resolve(repo, 'package.json'), resolve(installed, 'package.json'));
rmSync(resolve(example, 'node_modules/.vite'), { recursive: true, force: true });
console.log('[example] synced dist/ + package.json into the installed copy of vapor-chamber');
