/**
 * Feature example: vaporChamberWire - build-time Vue wiring
 * ========================================================
 * An app that imports only from the package root (`vapor-chamber`) needs this
 * plugin on Vite. The root can only look for Vue at runtime, and that lookup
 * fails in a production bundle. With the plugin, a build wires the root to Vue
 * statically, so the runtime lookup and its dynamic `import('vue')` fold out
 * of the bundle. Under the dev server it changes nothing.
 */

import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { vaporChamberHMR, vaporChamberWire } from 'vapor-chamber/vite'

export default defineConfig({
  plugins: [
    vue(),
    vaporChamberWire({
      // 'vapor' when the app calls the library's Vapor API (createVaporChamberApp,
      // a defineVapor* component wrapper): those then come from
      // `vapor-chamber/vapor`. Default: 'vue'.
      entry: 'vapor',
      // 'lean' trades speed for memory where the library offers the choice
      // (today: isLoading's per-key slots). Default: 'performance'.
      profile: 'performance',
    }),
    vaporChamberHMR(),   // the two compose: HMR is serve-only, wiring build-only
  ],
})

// esbuild or webpack: no plugin; import the composables from
// 'vapor-chamber/vue' (or '/vapor') and define `__VC_WIRED_BUILD__: 'true'`.
