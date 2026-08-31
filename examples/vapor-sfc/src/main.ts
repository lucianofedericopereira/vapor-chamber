// Vapor wiring: none. That is the point of the `vapor-chamber/vapor` entry.
//
// It statically imports Vue's Vapor APIs, so the bundler resolves them at build
// time and they reach the library's registry the moment the module evaluates.
// No configureVue() call, no list of names to keep in sync, and no dependency on
// the runtime probe - which is the part that used to break.
//
// WHAT THIS REPLACES. The package root reaches Vue through a bare dynamic
// `import()`, because the root must also work with no Vue in the tree. That
// resolves under the dev server and CANNOT resolve in a production bundle, so
// this page previously threw "Vue 3.6+ with Vapor mode required. No Vue
// detected." while Vapor sat bundled inside the very same file - dev fine,
// production blank. Pinned by tests/vapor-sfc-prod-detection.test.ts.
//
// The interim fix was an explicit configureVue({ createVaporApp }) here. That
// still works and is still right for anyone who wants it (and remains the only
// option on a no-build page, where nothing can be imported statically at all).
// This entry just removes the step for consumers who have a bundler.
//
// The bus itself is framework-agnostic, so it keeps coming from the root - see
// src/vapor.ts §"WHAT IT DOES NOT RE-EXPORT".
import { createVaporChamberApp } from 'vapor-chamber/vapor';
import App from './App.vue';

createVaporChamberApp(App).mount('#app');
