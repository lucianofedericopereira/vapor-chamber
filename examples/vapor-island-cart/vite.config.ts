import { defineConfig } from 'vite';
import { createExampleConfig } from '../vite.base';

// No vapor flag needed: @vitejs/plugin-vue >=5 detects `<script setup vapor>`
// and routes those components to @vue/compiler-vapor automatically.
//
// No `vue` alias: `vue.runtime.esm-bundler.js` re-exports both
// `@vue/runtime-dom` and `@vue/runtime-vapor`, so the default entry carries
// Vapor (pinned by tests/vue-bundler-vapor-exports.test.ts).
//
// `optimizeDeps` and `server` stay HERE rather than moving into
// ../vite.base.ts: the islands are loaded through dynamic imports, so this
// example pre-bundles, and its README names a fixed port. The base documents
// both as deliberately per-example.
export default defineConfig(
  createExampleConfig({
    optimizeDeps: { include: ['vue', 'vapor-chamber'] },
    server: { port: 8889, strictPort: true },
  }),
);
