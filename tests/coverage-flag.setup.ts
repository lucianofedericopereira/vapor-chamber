/**
 * Global setup: tells the test files whether this run is instrumented for
 * coverage, from Vitest's own resolved config, so `--coverage` on the command
 * line counts the same as a script that sets it (tests/under-coverage.ts).
 */
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    vcCoverage: boolean;
  }
}

export default function setup(project: TestProject): void {
  project.provide('vcCoverage', project.vitest.config.coverage?.enabled === true);
}
