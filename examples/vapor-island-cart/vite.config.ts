import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { vaporChamberHMR } from 'vapor-chamber/vite';

// No vapor flag needed: @vitejs/plugin-vue >=5 detects `<script setup vapor>`
// and routes those components to @vue/compiler-vapor automatically.
//
// And no `vue` alias any more. This used to point `vue` at a synthesized
// with-vapor entry because "Vue's default `vue` entry ships NO Vapor runtime" -
// true when it was written, false since rc.5, where
// `vue.runtime.esm-bundler.js` became exactly what that shim was:
//
//   export * from "@vue/runtime-dom";
//   export * from "@vue/runtime-vapor";
//
// Verified rather than assumed: building this example with the alias and
// without it produced byte-identical output across all four chunks - same
// sizes, same content hashes. The enumeration behind the claim is pinned by
// tests/vue-bundler-vapor-exports.test.ts.
export default defineConfig({
  optimizeDeps: { include: ['vue', 'vapor-chamber'] },
  server: { port: 8889, strictPort: true },
  plugins: [
    vue(),
    vaporChamberHMR({ verbose: false }), // keeps bus state across HMR
  ],
});
