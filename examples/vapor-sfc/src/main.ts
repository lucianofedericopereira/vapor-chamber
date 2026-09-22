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

// NO app-wide directive registration any more. `v-vc-command` is imported as a
// `vVc` binding in CartPanel.vue, which is the idiomatic form.
//
// It was registered here from rc9/12 until v1.22.0, and not as a style choice:
// vue-tsc type-checked an imported directive's ARGUMENT as a raw string - the
// shape #15490 replaced with a getter - so the imported form failed
// `vue-tsc --noEmit` against a correct .d.ts and a working runtime, and
// app-wide registration passed only because it left vue-tsc no declaration to
// check. That was opting out of checking rather than satisfying it.
//
// The v1.22.0 reshape moved the selector into the NAME, so `v-vc-command` has
// no argument for vue-tsc to mistype, and the imported form type-checks. This
// example's own `vue-tsc --noEmit` build step is the proof.
createVaporChamberApp(App).mount('#app');
