// Vapor wiring: none. The `vapor-chamber/vapor` entry statically imports
// Vue's Vapor APIs, so the bundler resolves them at build time and they reach
// the library's registry the moment the module evaluates - no configureVue(),
// no runtime probe. (The package root reaches Vue through a bare dynamic
// `import()`, which resolves under the dev server and cannot in a production
// bundle; tests/vapor-sfc-prod-detection.test.ts pins that this page works
// built. configureVue() remains the channel on a no-build page.)
//
// The bus itself is framework-agnostic, so it comes from the root - see
// src/vapor.ts, "WHAT IT DOES NOT RE-EXPORT".
//
// Directives are imported per component (CartPanel.vue), not registered
// app-wide: the selector is in the directive's name, so vue-tsc checks the
// imported form.
import { createVaporChamberApp } from 'vapor-chamber/vapor';
import App from './App.vue';

createVaporChamberApp(App).mount('#app');
