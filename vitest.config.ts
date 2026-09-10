import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    reporters: [
      'dot',
      // Writes docs/metrics.json - the source stamp-docs derives the
      // README/whitepaper test counts from, so they cannot drift.
      ['./scripts/test-counts-reporter.mjs', { key: 'default' }],
    ],
    silent: 'passed-only',
    // tests/router/dom.test.ts has several cases that deliberately let a
    // click fall through to "let the browser handle it" (that's the behavior
    // under test). Without this, happy-dom's default BrowserFrameValidator
    // treats that as a real top-level navigation and issues an actual
    // fetch() to the target URL, which 404s against whatever's listening on
    // localhost:3000 and logs a `GET ... 404` straight to stdout - a genuine
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
    // all - see vitest.vapor.config.ts. Running them here would fail on the
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
      //  (vite-hmr.ts is NO LONGER excluded. Its reason read "Vite plugin code
      //   that exercises in a real Vite server, not a unit test environment",
      //   which was true and was also the hole: the plugin claimed `.vue` and
      //   `.vapor.vue` and had never once delivered a shim to either, while 24
      //   unit tests passed, because those tests called `plugin.transform()`
      //   with a string Vite would never pass it. An exclusion whose reason is
      //   "the real thing is hard to mount" is a standing invitation for the
      //   fixture to disagree with reality. tests/vite-hmr-pipeline.test.ts
      //   mounts the real thing - `createServer`, the actual plugin container,
      //   and one case over a real socket - in about half a second, and the
      //   file measures 100% with it.)
      //  - testing.ts: test-only utility (createTestBus); covering it
      //    would mean tests that test the test helper
      //  - directives.ts: requires a real Vue runtime to exercise the public
      //    surface. Covered indirectly by integration in consumer projects and
      //    by examples/feature-directives.html; not easily unit-testable.
      //  - router/vapor.ts: this project CANNOT IMPORT IT AT ALL. Its named
      //    imports (createDynamicComponent, createSlot, defineVaporComponent)
      //    do not exist on the `vue` build a bare specifier resolves to here,
      //    so the module fails to link rather than merely failing to run -
      //    which is the same fact `vitest.vapor.config.ts` exists for. It is
      //    NOT untested: tests/vapor/vapor-outlet*.test.ts cover it under that
      //    config, including against an executed production bundle, plus a
      //    binding-boundary fixture in this project. Excluded so the one
      //    number this gate reports stays honest; if coverage ever merges the
      //    two projects, delete this line first.
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
        'src/testing.ts',
        'src/directives.ts',
        'src/router/vapor.ts',
      ],
      thresholds: {
        // Floors sit ~2 points below current measured coverage - tight enough
        // that a genuine regression trips the gate, loose enough that trivial
        // test churn doesn't. Ratchet upward as coverage climbs; only lower
        // with an explicit CHANGELOG note explaining the regression.
        //
        // v1.16 reaches 100% ON ALL FOUR AXES - statements, branches,
        // functions and lines. Every branch in the measured surface is taken by
        // a test in both directions.
        //
        // Getting the last few was as much deletion as testing, and that is the
        // preferred order: where a branch was unreachable because it guarded an
        // invariant the code already enforces (`if (keys)` in plugins-extra's
        // dropKey, the `pending.get(...)` lookups in transports, `if (cmd.meta)`
        // in outbox), the guard was removed and the invariant named in a
        // comment, so a violation throws loudly instead of no-opping silently.
        // The `__VC_PRECISE_TS__` build flag went the same way - it was
        // unreachable from any configuration, so it was removed rather than
        // classified as permanently uncoverable.
        //
        // The floors stay ~2 points below rather than at 100 deliberately: a
        // 100% floor turns any refactor that adds an honest defensive branch
        // into a red build, which pressures people to delete guards that should
        // stay or write tests that assert nothing. Ratchet the floor when the
        // measured number moves; do not pin it to the ceiling.
        lines: 98,
        functions: 98,
        branches: 98,
        statements: 98,
      },
    },
  },
});
