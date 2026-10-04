/**
 * Feature example: vaporChamberWire - build-time Vue wiring
 * ========================================================
 * An app that imports from the package root (`vapor-chamber`) works without
 * this plugin: the root finds Vue at runtime. With it, a build wires the root
 * to Vue statically, so the runtime lookup and its dynamic `import('vue')`
 * fold out of the bundle. Under the dev server it changes nothing.
 */

import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { vaporChamberHMR, vaporChamberWire } from 'vapor-chamber/vite'

export default defineConfig({
  plugins: [
    vue(),
    vaporChamberWire({
      // 'vapor' when the app compiles `<script setup vapor>` SFCs: the root's
      // Vapor helpers then come from `vapor-chamber/vapor`. Default: 'vue'.
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
