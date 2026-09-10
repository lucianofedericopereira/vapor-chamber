import { defineConfig } from 'vite';
import { createExampleConfig } from '../vite.base';

// No `vue` alias, and no synthesized with-vapor entry. Both used to be here,
// and both were justified by a fact that has since expired: "Vue's `vue` entry
// ships no Vapor runtime, and at rc.3 with-vapor exists ONLY as a pre-bundled
// esm-browser dist." True at rc.3. False since rc.5, where Vue's own
// `vue.runtime.esm-bundler.js` became exactly what the shim was:
//
//   export * from "@vue/runtime-dom";
//   export * from "@vue/runtime-vapor";
//
// Verified rather than assumed - building this example with the alias and
// without it produced byte-identical output, same size and same content hash,
// so the shim was reproducing what bare `vue` already resolves to. The
// enumeration behind that claim is pinned by
// tests/vue-bundler-vapor-exports.test.ts, so this can be re-checked each RC
// instead of re-derived.
//
// The Vue feature flags, `build.target` and the plugin pair now come from
// ../vite.base.ts, which documents what it shares and what it deliberately
// leaves to each example.
export default defineConfig(createExampleConfig());
