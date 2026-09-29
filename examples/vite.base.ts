/**
 * Shared Vite base for the two Vue examples.
 *
 * There is no root `vite.config.ts` - each example builds on its own - so this
 * factory is the shared root for the settings both were carrying identically.
 * It is imported as SOURCE by a relative path; `examples/` is not a package, it
 * is resolved from the workspace root install.
 *
 * WHAT IS SHARED is only what was already byte-identical in both configs, plus
 * one thing that should have been and was not:
 *
 *   define        The three Vue feature flags, so the two configs agree (about
 *                 40 bytes: Vapor components do not pull the Options-API
 *                 runtime in the first place). Safe: no Options API appears in
 *                 either example's src.
 *   build.target  es2022, as `vapor-sfc` already pinned.
 *   plugins       `vue()` and `vaporChamberHMR({ verbose: false })`, which keeps
 *                 bus state across HMR.
 *
 * WHAT IS DELIBERATELY NOT SHARED, because two configs that look alike are not
 * evidence that one rule is correct for both:
 *
 *   server        `vapor-island-cart` pins port 8889 / strictPort so its README
 *                 can name a URL; `vapor-sfc` takes whatever Vite offers.
 *   optimizeDeps  `vapor-island-cart` pre-bundles `vue` and `vapor-chamber`
 *                 because it loads its islands through dynamic imports.
 *   plugin order  The array is composed by the CALLER. Both happen to use the
 *                 same order today, and imposing it here would silently reorder
 *                 the other example's hooks the day one of them needs to change.
 */

import type { UserConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { vaporChamberHMR } from 'vapor-chamber/vite';

/**
 * Derived from the factories rather than written out: `@vitejs/plugin-vue`
 * returns a single `Plugin<Api>`, not an array.
 */
type SharedPlugins = { vue: ReturnType<typeof vue>; hmr: ReturnType<typeof vaporChamberHMR> };

export type ExampleConfigOptions = Omit<UserConfig, 'plugins'> & {
  /**
   * Compose the final plugin array. Receives the shared plugins already
   * constructed, so each example fixes its own order. Omit to take the default
   * order, which is what both examples currently use.
   */
  plugins?: (shared: SharedPlugins) => UserConfig['plugins'];
};

export function createExampleConfig({ plugins, ...rest }: ExampleConfigOptions = {}): UserConfig {
  const shared: SharedPlugins = {
    vue: vue(),
    hmr: vaporChamberHMR({ verbose: false }),
  };

  return {
    define: {
      __VUE_OPTIONS_API__: false,
      __VUE_PROD_DEVTOOLS__: false,
      __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: false,
    },
    build: { target: 'es2022' },
    ...rest,
    plugins: plugins ? plugins(shared) : [shared.vue, shared.hmr],
  };
}
