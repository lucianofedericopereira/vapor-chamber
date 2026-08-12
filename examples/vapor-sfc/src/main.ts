// configureVue() is required, not optional. In a production build neither
// detection channel exists: vaporChamberHMR is apply:'serve' so nothing primes
// the sync slot, and the async `import('vue')` is an unresolvable bare
// specifier. Without this the built page threw while Vapor sat bundled in it.
// Pinned by tests/vapor-sfc-prod-detection.test.ts.
//
// Named imports, not `import * as Vue` — a namespace object forces the bundler
// to retain every export (299 KB vs 76 KB). Pass only what the app uses;
// unsupplied entries stay null in the registry.
import {
  ref, shallowRef, getCurrentScope, getCurrentInstance,
  onScopeDispose, onActivated, onDeactivated,
  createVaporApp,
} from 'vue';
// `configureVue` from the /vue subpath, not the root: same function, but
// importing it also wires Vue's tracking primitives at build time. Without that
// `untracked()` silently degrades to a pass-through once this app is built, and
// the dev server warns about exactly this. The Vapor APIs below still go
// through configureVue, because /vue is the Vue 3.5-safe surface and does not
// carry them.
import { configureVue } from 'vapor-chamber/vue';
import { createVaporChamberApp } from 'vapor-chamber';
import App from './App.vue';

configureVue({
  ref, shallowRef, getCurrentScope, getCurrentInstance,
  onScopeDispose, onActivated, onDeactivated,
  createVaporApp,
});

createVaporChamberApp(App).mount('#app');
