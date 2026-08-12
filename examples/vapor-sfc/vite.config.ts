import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { vaporChamberHMR } from 'vapor-chamber/vite';
import path from 'node:path';

// Vue's `vue` entry ships no Vapor runtime, and at rc.3 with-vapor exists ONLY
// as a pre-bundled esm-browser dist. src/vue-with-vapor.ts synthesizes the
// missing esm-bundler entry from the two packages that do ship one, which
// tree-shakes properly. Measured, same app:
//   esm-browser .prod.js  122.2 KB (br 38.7)
//   synthesized bundler    74.8 KB (br 24.0)
export default defineConfig({
  resolve: { alias: { vue: path.resolve(__dirname, 'src/vue-with-vapor.ts') } },
  define: {
    __VUE_OPTIONS_API__: false,
    __VUE_PROD_DEVTOOLS__: false,
    __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: false,
  },
  build: { target: 'es2022' },
  plugins: [vue(), vaporChamberHMR({ verbose: false })],
});
