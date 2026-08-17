import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Vapor-aliased test project.
 *
 * WHY A SECOND CONFIG. Most Vapor fixtures in `tests/` import the with-vapor
 * dist explicitly and hand it to the library (`configureVue(v)`), so they need
 * no alias. The ROUTER cannot do that: `src/router/*.ts` imports `vue` as a
 * bare specifier — `inject`, `computed`, `customRef`, `onScopeDispose` — and
 * those imports are resolved by the consumer's bundler, not by us.
 *
 * Under the default config, a bare `vue` in vitest resolves to a build with NO
 * Vapor in it (measured: `createVaporApp`, `defineVaporComponent` and
 * `template` are all absent). So a test that mounted a real Vapor app from the
 * with-vapor dist while the router injected through bare `vue` would be running
 * TWO DISCONNECTED reactivity instances — `inject(ROUTER_KEY)` would miss and
 * the composables would throw "no router provided", which is an artifact of the
 * harness, not a fact about the router.
 *
 * Aliasing `vue` to the with-vapor build collapses that back to one instance,
 * which is exactly what a real Vapor app does (see `examples/vapor-sfc` and
 * `examples/vapor-island-cart`, both of which alias the same way). So this
 * config is not a test-only trick — it reproduces the supported production
 * setup, and it is the only configuration in which the router's composables can
 * be observed inside a real Vapor component at all.
 *
 * The default config excludes `tests/vapor/**` so these never run unaliased,
 * where they would fail for the harness reason above.
 */
const WITH_VAPOR = fileURLToPath(
  new URL('./node_modules/vue/dist/vue.runtime-with-vapor.esm-browser.js', import.meta.url),
);

export default defineConfig({
  resolve: {
    alias: {
      // Exact match only: `vue/dist/...` deep imports must still resolve
      // normally, so a fixture can reach a specific build on purpose.
      vue: WITH_VAPOR,
    },
  },
  test: {
    globals: true,
    environment: 'happy-dom',
    reporters: [
      'dot',
      // Writes docs/metrics.json — the source stamp-docs derives the
      // README/whitepaper test counts from, so they cannot drift.
      ['./scripts/test-counts-reporter.mjs', { key: 'vapor' }],
    ],
    silent: 'passed-only',
    include: ['tests/vapor/**/*.test.ts'],
  },
});
