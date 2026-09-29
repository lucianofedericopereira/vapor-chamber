/**
 * Is this run measuring coverage?
 *
 * The `*-ab.test.ts` files and the two cost tests measure TIME, and v8
 * instrumentation multiplies every arm of the measurement. A number taken
 * through it is not a number anyone ships, and the loops that produce it are
 * slow enough under instrumentation to blow even a generous per-test timeout -
 * so those cases skip themselves rather than report a fiction or hang.
 *
 * WHY A SHARED CONSTANT rather than a literal per file. More than one script
 * turns coverage on: `test:coverage` and `coverage:doc` (the one that
 * regenerates docs/COVERAGE.md, which `npm version` runs). A file that checked
 * only the first would run its timing loops instrumented under the second and
 * time out in the docs pipeline. The set lives in one place so adding a
 * script is one edit.
 *
 * `npm_lifecycle_event` is npm's name for the script being run, so this is
 * empty for a bare `npx vitest` - which is correct: that run is not
 * instrumented, and the measurements are real.
 */
const COVERAGE_SCRIPTS = new Set(['test:coverage', 'coverage:doc']);

export const underCoverage = COVERAGE_SCRIPTS.has(process.env.npm_lifecycle_event ?? '');
