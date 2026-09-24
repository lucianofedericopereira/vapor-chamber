import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Vapor-aliased test project.
 *
 * WHY A SECOND CONFIG. Most Vapor fixtures in `tests/` import the with-vapor
 * dist explicitly and hand it to the library (`configureVue(v)`), so they need
 * no alias. The ROUTER cannot do that: `src/router/*.ts` imports `vue` as a
 * bare specifier - `inject`, `computed`, `customRef`, `onScopeDispose` - and
 * those imports are resolved by the consumer's bundler, not by us.
 *
 * Under the default config, a bare `vue` in vitest resolves to a build with NO
 * Vapor in it (measured: `createVaporApp`, `defineVaporComponent` and
 * `template` are all absent). So a test that mounted a real Vapor app from the
 * with-vapor dist while the router injected through bare `vue` would be running
 * TWO DISCONNECTED reactivity instances - `inject(ROUTER_KEY)` would miss and
 * the composables would throw "no router provided", which is an artifact of the
 * harness, not a fact about the router.
 *
 * Aliasing `vue` to the with-vapor build collapses that back to one instance,
 * which is what a real Vapor app gets from its own bundler. It is the only
 * configuration in which the router's composables can be observed inside a real
 * Vapor component at all.
 *
 * This note used to add "see `examples/vapor-sfc` and `examples/vapor-island-cart`,
 * both of which alias the same way". They no longer do, and have not since
 * v1.17.0: Vue's own `vue.runtime.esm-bundler.js` re-exports `@vue/runtime-vapor`,
 * so the examples' alias was reproducing what bare `vue` already resolves to and
 * was deleted after building each one with and without it produced byte-identical
 * output. The alias is still right HERE, because vitest's bare `vue` is not that
 * bundler entry - but the examples are no longer evidence for it.
 *
 * The default config excludes `tests/vapor/**` so these never run unaliased,
 * where they would fail for the harness reason above.
 */
const WITH_VAPOR = fileURLToPath(
  new URL('./node_modules/vue/dist/vue.runtime-with-vapor.esm-browser.js', import.meta.url),
);

export default defineConfig({
  resolve: {
    alias: [
      // Exact match only: `vue/dist/...` deep imports must still resolve
      // normally, so a fixture can reach a specific build on purpose. The
      // regex is what makes that true - a string key also rewrites `vue/...`
      // (Vite's `matches()`: `=== find || startsWith(find + '/')`).
      { find: /^vue$/, replacement: WITH_VAPOR },
    ],
  },
  test: {
    globals: true,
    environment: 'happy-dom',
    reporters: [
      'tree',
      // Writes docs/metrics.json - the source stamp-docs derives the
      // README/whitepaper test counts from, so they cannot drift.
      ['./scripts/test-counts-reporter.mjs', { key: 'vapor' }],
    ],
    silent: 'passed-only',
    // Same two settings as vitest.config.ts - see the notes there.
    onConsoleLog(log) {
      if (log.includes('You are running a development build of Vue')) return false;
      if (log.includes('Make sure to use the production build')) return false;
      return undefined;
    },
    // No per-test wall-clock ceiling - see the note in vitest.config.ts.
    testTimeout: 0,
    hookTimeout: 0,
    // See the note in vitest.config.ts.
    fsModuleCache: true,
    // Same cleanup options as vitest.config.ts - see the note there.
    clearMocks: false,
    restoreMocks: true,
    unstubGlobals: true,
    unstubEnvs: true,
    include: ['tests/vapor/**/*.test.ts'],
  },
});
