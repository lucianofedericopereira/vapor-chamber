/**
 * The suite's setup file: vapor-chamber/vitest, from src/.
 *
 * A file of its own rather than `setupFiles: ['./src/vitest.ts']`, because
 * Vitest adds every setup file to `coverage.exclude`. Named directly, the
 * published entry would silently drop out of the 100% gate; imported from
 * here, only this line does.
 */
import '../src/vitest';
