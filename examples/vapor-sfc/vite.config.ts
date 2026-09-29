import { defineConfig } from 'vite';
import { createExampleConfig } from '../vite.base';

// No `vue` alias: `vue.runtime.esm-bundler.js` re-exports both
// `@vue/runtime-dom` and `@vue/runtime-vapor`, so the default entry carries
// Vapor (pinned by tests/vue-bundler-vapor-exports.test.ts). The Vue feature
// flags, `build.target` and the plugin pair come from ../vite.base.ts.
export default defineConfig(createExampleConfig());
