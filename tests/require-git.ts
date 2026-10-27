/**
 * Does this checkout have git history to test against?
 *
 * A few files drive scripts that read THIS repository's commits
 * (scripts/ab/base-ok.sh, scripts/verify-contract.mjs --against). A clone has
 * them; an unpacked archive, or a `git init` with no commit, does not, and
 * nothing a contributor runs can produce them. That puts these files on the
 * `describe.skipIf(!esbuild)` side of the line (tests/esm-treeshake.test.ts),
 * not the `requireDist` side (tests/require-dist.ts): a missing build is a
 * setup error, fixed by `npm run build`, and so it fails; missing history is
 * a capability the environment lacks, and so the file skips and says why.
 *
 * Two things keep the skip honest. CI always runs from a clone, so the guard
 * is never active where a red matters. And the scripts/ab/base-ok.sh paths are
 * also exercised against a throwaway repository the test creates itself
 * (tests/ab-ci.test.ts, "refuses a base on another release"); only the
 * "against this very checkout" case waits for a clone. The three skipped
 * verify-contract --against cases have no such test: from an archive that
 * script path is untested.
 *
 * Resolved once per worker: `git rev-parse --verify HEAD` succeeds only with
 * the binary installed, inside a work tree, with at least one commit.
 */
import { spawnSync } from 'node:child_process';

const probe = spawnSync('git', ['rev-parse', '--verify', '--quiet', 'HEAD'], { encoding: 'utf8' });

/** True when the checkout has a commit to read: a clone, not an unpacked archive. */
export const gitHistory = probe.status === 0;

/** Why `gitHistory` is false, for the skip reason. */
export const noGitHistory = probe.error
  ? `git is not installed (${probe.error.message})`
  : 'this checkout has no git history (an unpacked archive, or no commit yet)';
