import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { vaporChamberHMR } from 'vapor-chamber/vite';

// `@vitejs/plugin-vue` ≥ 5.x detects `<script setup vapor>` blocks and routes
// them to `@vue/compiler-vapor` automatically.
//
// BUT: Vue's default `vue` entry (vue.runtime.esm-bundler.js) ships NO Vapor
// runtime — without the alias below the build succeeds while
// createVaporChamberApp() throws at runtime ("Vue 3.6+ with Vapor mode
// required"). The compiled vapor SFC helpers AND vapor-chamber's
// createVaporApp probe both read off `import('vue')`, so `vue` must point at
// the build that actually contains Vapor.
//
// `vaporChamberHMR()` preserves the bus (handlers, plugins, hooks, listeners)
// across hot module replacement so app state survives component reloads.

export default defineConfig({
  resolve: {
    alias: {
      vue: 'vue/dist/vue.runtime-with-vapor.esm-browser.js',
    },
  },
  // Re-bundle the aliased vue so the prebundled dep carries the Vapor runtime.
  optimizeDeps: { include: ['vue', 'vapor-chamber'] },
  plugins: [
    vue(),
    vaporChamberHMR({ verbose: false }),
  ],
});
