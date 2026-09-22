/**
 * Probes - the gitignored scratch area for an alignment cycle's measurements.
 *
 * A probe is a throwaway test written to ANSWER something, not to guard it:
 * "does the vDOM directive latch when the argument flips", "does a KeepAlive
 * eviction run our cleanup once or twice". Its findings end up in a commit
 * message, a comment, or a real test - never in the suite.
 *
 *     npx vitest run --config vitest.probes.config.ts
 *
 * THEY LIVE AT THE ROOT, in `.probes/`, and that is the second arrangement.
 * The first put them in `tests/probes/` so that vitest.config.ts's `include`
 * would reach them - and then every tool that walks `tests/` found them and
 * needed its own exclude: vitest (a probe is often written to fail, so it
 * failed the suite), biome (it linted a probe's unused import and failed
 * lint:check), check-ascii (it walked them), with the typecheck include next
 * in line. Three excludes to hide a directory from tools that had no business
 * seeing it. This config is standalone and can include any path, so the reason
 * they were under `tests/` had already evaporated. At the root they are simply
 * out of everyone's way, and all three excludes are gone.
 *
 * Standalone rather than a `mergeConfig` of vitest.config.ts: mergeConfig
 * CONCATENATES arrays, so merging keeps the base `include` and runs the whole
 * suite. A probe needs almost nothing anyway - the environment comes from each
 * file's own `// @vitest-environment` line, and imports resolve through Vite.
 *
 * PARK THIS DIRECTORY BEFORE GATING HISTORICAL COMMITS. Probes are untracked,
 * and untracked files survive a checkout - so a probe written to fail will run
 * and fail at any commit whose config does not know about it. A
 * `git rebase --exec` pass over this series stopped on its first commit for
 * exactly that reason, back when the answer was an exclude rather than a
 * location.
 *
 * This file is committed and the probes are not, so a clean checkout has the
 * entry point and an empty room behind it.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['.probes/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // A probe exists to print, and it takes BOTH of these. The suite's
    // `silent: 'passed-only'` hides console output from a passing test, so
    // that one is obvious. `disableConsoleIntercept` is not: vitest captures
    // console output and hands it to the reporter, and with the capture left
    // on a probe's output goes to the reporter and no further - a clean,
    // silent pass that says nothing. Found by running a probe under this
    // config with only `silent: false` and getting exactly that.
    silent: false,
    disableConsoleIntercept: true,
  },
});
