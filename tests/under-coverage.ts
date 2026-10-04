/**
 * Does this run time anything?
 *
 * The `*-ab.test.ts` files and the cost tests have two halves: equivalence
 * checks (the change gives the same answers as the code it replaced) and a
 * timing loop that prints a table. The checks run in every suite. The timing
 * runs only on `npm run test:timing` (`VC_TIMING=1`), and never under
 * coverage: v8 instrumentation multiplies every arm, so a number taken
 * through it is not a number anyone ships. A file with both halves returns
 * before its timing loop otherwise (`if (!runTiming) return;`); a test that
 * only times skips itself.
 *
 * WHY OPT-IN. The loops assert only that a number came out, they set the
 * suite's floor (router-stamp-ab alone 21 s of a 28 s run), and a one-process
 * A/B is a lead, not a verdict (docs/V8-RULES.md rule 16; `npm run ab` is the
 * measurement). Log s35.55.
 *
 * WHERE "coverage" COMES FROM: Vitest's own resolved config
 * (`coverage.enabled`), handed over by tests/coverage-flag.setup.ts. It was the
 * npm script name (`npm_lifecycle_event` in test:coverage / coverage:doc),
 * which `npx vitest run --coverage` (the gate's and the audit's command) does
 * not set: every timing loop then ran instrumented (log s35.52).
 */
import { inject } from 'vitest';

export const underCoverage = inject('vcCoverage') === true;

export const runTiming = process.env.VC_TIMING === '1' && !underCoverage;
