import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      // Excluded from coverage:
      //  - index.ts / plugins.ts: pure re-export aggregators
      //  - iife*.ts: thin namespace builders for `<script>` tag use; the
      //    underlying surface is covered via the regular test files
      //  - vite-hmr.ts: Vite plugin code that exercises in a real Vite
      //    server, not a unit test environment
      //  - testing.ts: test-only utility (createTestBus); covering it
      //    would mean tests that test the test helper
      //  - devtools.ts, directives.ts: require a real Vue runtime to
      //    exercise the public surface. Covered indirectly by integration
      //    in consumer projects; not easily unit-testable.
      exclude: [
        'src/index.ts',
        'src/plugins.ts',
        'src/iife.ts',
        'src/iife-core.ts',
        'src/iife-elements.ts',
        'src/vite-hmr.ts',
        'src/testing.ts',
        'src/devtools.ts',
        'src/directives.ts',
      ],
      thresholds: {
        // Floor reflecting current measured coverage with intentional
        // headroom (-1 to -2 points) so trivial test additions don't
        // tighten the gate while genuine regressions still trigger it.
        // Tighten over time as coverage improves; only lower with an
        // explicit CHANGELOG note explaining the regression.
        //
        // Known gaps tracked separately:
        //   - plugins-extra.ts (0% — cache/circuitBreaker/rateLimit/metrics)
        //   - utilities.ts    (0% — createChamber/createWorkflow/createReaction)
        // Both are real public API surface and deserve test coverage in a
        // follow-up. They're not excluded because excluding would hide the
        // gap; the global threshold acknowledges the current level.
        lines: 75,
        functions: 80,
        branches: 65,
        statements: 73,
      },
    },
  },
});
