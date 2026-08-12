import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { vaporChamberHMR } from 'vapor-chamber/vite';
import path from 'node:path';

// No vapor flag needed: @vitejs/plugin-vue >=5 detects `<script setup vapor>`
// and routes those components to @vue/compiler-vapor automatically.
//
// BUT: Vue's default `vue` entry (vue.runtime.esm-bundler.js) ships NO Vapor
// runtime. The compiled vapor SFC helpers AND vapor-chamber's createVaporApp/
// defineVaporCustomElement probe both read off `import('vue')`, so we must point
// `vue` at the build that actually contains Vapor.
//
// src/vue-with-vapor.ts synthesizes the esm-bundler entry Vue does not publish.
// Measured on the sibling vapor-sfc example: 122.2 KB -> 74.5 KB, and it stops
// shipping Vue's dev build to production.
export default defineConfig({
  resolve: {
    alias: {
      vue: path.resolve(__dirname, 'src/vue-with-vapor.ts'),
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
