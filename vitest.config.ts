import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    reporters: [
      'dot',
      // Writes docs/metrics.json — the source stamp-docs derives the
      // README/whitepaper test counts from, so they cannot drift.
      ['./scripts/test-counts-reporter.mjs', { key: 'default' }],
    ],
    silent: 'passed-only',
    // tests/router/dom.test.ts has several cases that deliberately let a
    // click fall through to "let the browser handle it" (that's the behavior
    // under test). Without this, happy-dom's default BrowserFrameValidator
    // treats that as a real top-level navigation and issues an actual
    // fetch() to the target URL, which 404s against whatever's listening on
    // localhost:3000 and logs a `GET ... 404` straight to stdout — a genuine
    // network call the test suite has no business making. Disabling
    // main-frame navigation makes happy-dom fall back to just setting
    // window.location (PropertySymbol.setURL) instead, which is the only
    // part of that behavior these tests (and the afterEach reset below) ever
    // actually rely on.
    environmentOptions: {
      happyDOM: {
        settings: {
          navigation: {
            disableMainFrameNavigation: true,
          },
        },
      },
    },
    include: ['tests/**/*.test.ts'],
    // `tests/vapor/**` needs `vue` aliased to the with-vapor build to run at
    // all — see vitest.vapor.config.ts. Running them here would fail on the
    // harness (two disconnected Vue instances), not on the code.
    exclude: ['**/node_modules/**', '**/dist/**', 'tests/vapor/**'],
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
        // Ratcheted for v1.15 (measured: 99.76 lines / 99.06 functions /
        // 95.97 branches / 99.51 statements). The v1.9 floors were left at
        // 96/94/88/94 while coverage climbed ~4 points past them; branches in
        // particular carried 8 points of slack, enough for a real regression
        // to pass the gate unnoticed. The remaining sub-100 branch number is
        // concentrated in router/engine + router/index async navigation arms.
        lines: 97.5,
        functions: 97,
        branches: 94,
        statements: 97.5,
      },
    },
  },
});
