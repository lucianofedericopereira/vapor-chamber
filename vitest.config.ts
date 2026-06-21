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
        // Floors sit ~2 points below current measured coverage — tight enough
        // that a genuine regression trips the gate, loose enough that trivial
        // test churn doesn't. Ratchet upward as coverage climbs; only lower
        // with an explicit CHANGELOG note explaining the regression.
        //
        // The command-bus.ts dispatch core is at 100% line + branch coverage.
        // These globals span the wider optional surface — http / transports /
        // plugins-io carry environment-bound branches (real HTTP/WS/SSE) that
        // hold the global branch number below 100%.
        lines: 90,
        functions: 90,
        branches: 82,
        statements: 89,
      },
    },
  },
});
