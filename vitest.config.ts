import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'json-summary', 'html'],
      // Anchored, and examples explicitly excluded: `src/**/*.ts` also matches
      // nested source trees like examples/exo-astro/src/**, so example code
      // was silently counted toward the library's thresholds. The gate must
      // measure what ships in dist/, nothing else.
      include: ['src/**/*.ts'],
      // Excluded from coverage:
      //  - examples/**, tests/**: `src/**/*.ts` also matches nested source
      //    trees like examples/exo-astro/src/**, so example code was silently
      //    counted toward the library's thresholds. The gate measures what
      //    ships in dist/, nothing else.
      //  - index.ts / plugins.ts: pure re-export aggregators
      //  - iife*.ts: thin namespace builders for `<script>` tag use; the
      //    underlying surface is covered via the regular test files
      //  - vite-hmr.ts: Vite plugin code that exercises in a real Vite
      //    server, not a unit test environment
      //  - testing.ts: test-only utility (createTestBus); covering it
      //    would mean tests that test the test helper
      //  - directives.ts: requires a real Vue runtime to exercise the public
      //    surface. Covered indirectly by integration in consumer projects and
      //    by examples/feature-directives.html; not easily unit-testable.
      //  (devtools.ts is NO LONGER excluded: v1.9 promotes it to its own
      //   public subpath, and a published entry point should be measured.)
      exclude: [
        'examples/**',
        'tests/**',
        'src/index.ts',
        'src/plugins.ts',
        'src/iife.ts',
        'src/iife-core.ts',
        'src/iife-elements.ts',
        'src/vite-hmr.ts',
        'src/testing.ts',
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
        // Ratcheted for v1.9 (measured: 97.06 / 96.66 / 88.11 / 95.43 after the
        // devtools subpath and router error paths were covered). The previous
        // floors sat ~7 points low, which let a real regression pass unnoticed.
        lines: 95,
        functions: 94,
        branches: 86,
        statements: 93,
      },
    },
  },
});
