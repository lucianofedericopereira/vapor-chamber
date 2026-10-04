/**
 * Fail, do not skip, when a test file needs `dist/` and it is not there.
 *
 * A file that reads the build calls this at load with its own existence check.
 * Those files used to `describe.skipIf(!haveDist)`, and a skipped test cannot
 * go red: CI's `test` job ran `test:run` with no build, so every such block
 * skipped there and the job read green (log s35.64). CI builds first now, as
 * prepublishOnly and the gate already did; a missing build is a setup error,
 * reported as one.
 */
export function requireDist(built: boolean): void {
  if (!built) throw new Error('dist/ is missing or incomplete: run `npm run build` before the tests');
}
