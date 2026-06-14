import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { vaporChamberHMR } from 'vapor-chamber/vite';

// No vapor flag needed: @vitejs/plugin-vue >=5 detects `<script setup vapor>`
// and routes those components to @vue/compiler-vapor automatically.
//
// BUT: Vue's default `vue` entry (vue.runtime.esm-bundler.js) ships NO Vapor
// runtime. The compiled vapor SFC helpers AND vapor-chamber's createVaporApp/
// defineVaporCustomElement probe both read off `import('vue')`, so we must point
// `vue` at the build that actually contains Vapor.
export default defineConfig({
  resolve: {
    alias: {
      vue: 'vue/dist/vue.runtime-with-vapor.esm-browser.js',
    },
  },
  // Re-bundle the aliased vue so the prebundled dep carries the Vapor runtime.
  optimizeDeps: { include: ['vue', 'vapor-chamber'] },
  server: { port: 8889, strictPort: true },
  plugins: [
    vue(),
    vaporChamberHMR({ verbose: false }), // keeps bus state across HMR
  ],
});
