/**
 * vapor-chamber/vapor - the entry for Vue 3.6 Vapor apps.
 *
 * Import from HERE and Vapor wiring stops being something you can forget or get
 * subtly wrong. No `configureVue()` call, no probe to lose a race with, no list
 * of names to keep in sync: this module imports Vue's Vapor APIs statically, so
 * the consumer's bundler resolves them at build time and they reach the registry
 * the moment the module is evaluated.
 *
 * @example
 * import { createVaporChamberApp } from 'vapor-chamber/vapor';
 * import App from './App.vue';
 *
 * createVaporChamberApp(App).mount('#app');
 *
 * WHY THIS EXISTS - and why it is a THIRD entry rather than part of
 * `vapor-chamber/vue`. That module is scoped, deliberately, to the surface that
 * exists on Vue **3.5**, which the peer range still supports. The Vapor names
 * below do not exist there, and importing a missing name is a link error, not a
 * soft failure - so a 3.5 consumer importing `vapor-chamber/vue` must not be
 * made to resolve them. Splitting them out is what lets both audiences have a
 * static entry. `src/vue.ts`'s SCOPE note has said "Vapor wiring belongs in a
 * 3.6-only subpath" since it was written; this is that subpath.
 *
 * WHAT IT FIXES, concretely. The package root reaches Vue through a runtime
 * probe - a bare dynamic `import()` of a specifier held in a variable - because
 * the root must survive with no Vue in the tree at all. That probe answers
 * correctly under a dev server and **cannot resolve in a production bundle**,
 * where a bare specifier has nothing to resolve against and the rejection is
 * swallowed. Two failures follow, and both have actually shipped:
 *
 *   1. Vapor detection comes up empty, so `createVaporChamberApp()` throws
 *      "Vue 3.6+ with Vapor mode required. No Vue detected." on a page with
 *      Vapor bundled into it. Pinned by
 *      `tests/vapor-sfc-prod-detection.test.ts`.
 *   2. Registry entries the probe would have supplied are simply absent, and
 *      guards that depend on them go quietly inert - v1.17.0 found
 *      `hasInjectionContext` missing this way, which disabled the KeepAlive
 *      guard in `useCommandHistory` / `useCommandError`. Pinned by
 *      `tests/vue-subpath-wiring-fixture.test.ts`.
 *
 * Both are dev-correct / prod-broken, which is the worst shape a defect can
 * have. A static entry removes the class rather than the instances.
 *
 * COST: none beyond what you already ship. `vue` is external, so these resolve
 * to the copy already in the consumer's graph - never a second reactivity
 * instance. Named imports, not `import * as Vue`: a namespace object forces the
 * bundler to retain every Vue export (measured at 3x bundle size on the
 * vapor-sfc example).
 *
 * SUPERSET: re-exports everything `vapor-chamber/vue` does, so a Vapor app needs
 * one import specifier rather than two. Importing this module runs that one's
 * wiring too - the 3.5-safe primitives and the `@vue/reactivity` tracking pair
 * that keeps `untracked()` from degrading to a pass-through once built.
 *
 * WHAT IT DOES NOT RE-EXPORT, and why that is not an oversight: the
 * framework-agnostic surface - `createCommandBus`, `getCommandBus` /
 * `setCommandBus`, plugins, transports. This entry mirrors `vapor-chamber/vue`'s
 * scope exactly: the **Vue-dependent** surface, because that is the surface
 * whose import has to double as the wiring. The bus and its plugins work with no
 * Vue in the tree at all, the root entry carries them on that basis, and
 * duplicating them here would widen this entry's surface without wiring
 * anything. So a Vapor app importing both is the intended shape:
 *
 * ```ts
 * import { createCommandBus, setCommandBus } from 'vapor-chamber';
 * import { createVaporChamberApp, useCommand } from 'vapor-chamber/vapor';
 * ```
 */

import {
  createVaporApp as vueCreateVaporApp,
  defineVaporAsyncComponent as vueDefineVaporAsyncComponent,
  defineVaporComponent as vueDefineVaporComponent,
} from 'vue';
import { configureVue } from './chamber';

// Evaluated on import - this IS the wiring, and it is why `./dist/vapor.js` is
// listed in package.json#sideEffects: without that a bundler could hoist the
// re-exports below and skip this body entirely.
//
// `configureVue` MERGES - every assignment in `applyVueModule` is
// `typeof`-guarded - so this call adds the Vapor entries without disturbing the
// 3.5-safe ones `./vue` sets, in either evaluation order.
//
// WIRED SET - three of the five Vapor names `applyVueModule` reads, and the
// omissions are measured rather than accidental. A static import is retained by
// the consumer's bundler whether or not their app ever calls it, so "wire
// everything" is not free: it is paid by every consumer, including the ones who
// use none of it. Measured on the vapor-sfc example (raw / gzip kB of the app
// bundle), each row adding one name to the row above:
//
//   createVaporApp                      80.23 / 29.01   <- hand-wired minimum
//   + defineVaporComponent              80.26 / 29.03   +0.03
//   + defineVaporAsyncComponent         82.07 / 29.75   +1.84
//   + defineVaporCustomElement          89.44 / 31.98   +9.21
//   + vaporInteropPlugin               158.50 / 56.64   +78.27  (~2x the app)
//
// So the three wired here cost **+1.84 KB raw / +0.74 KB gzip** over wiring
// `createVaporApp` alone by hand - the price of zero-config for an ordinary
// Vapor SFC app, and small enough to be worth it.
//
// The two omitted are dominated by machinery their audience opts into:
// `defineVaporCustomElement` pulls the custom-element runtime, and
// `vaporInteropPlugin` pulls the whole VDOM interop renderer - 69 KB on its
// own, which would nearly double a pure-Vapor bundle to buy a feature that
// audience does not use. This is the same audience axis the IIFE variants
// already split on (core / elements / full).
//
// **If you use either, wire it yourself - one line, and it composes because
// `configureVue` merges:**
//
// ```ts
// import { defineVaporCustomElement, vaporInteropPlugin } from 'vue';
// import { configureVue } from 'vapor-chamber/vapor';
// configureVue({ defineVaporCustomElement, vaporInteropPlugin });
// ```
//
// Without that, this library's `defineVaporCustomElement()` /
// `getVaporInteropPlugin()` wrappers return `null` - their documented
// Vue-is-absent path. That is the one sharp edge of this entry, and it is why
// the block above exists instead of a shorter comment.
configureVue({
  createVaporApp: vueCreateVaporApp,
  defineVaporComponent: vueDefineVaporComponent,
  defineVaporAsyncComponent: vueDefineVaporAsyncComponent,
});

// Re-exporting `./vue` is also what EVALUATES it, which is the point: one
// import specifier wires both halves. Its surface is the Vue-dependent
// composables plus `configureVue` / `enableVueReactivity` / `signal` /
// `untracked`.
export * from './vue';

// The Vapor surface. These are this library's wrappers - the same functions the
// root exports, not copies, so a mixed codebase cannot end up with two
// registries. Their `null`-returning path is unreachable for anyone importing
// through this module, since the registry is seeded above before any of them
// can be called.
export {
  createVaporChamberApp,
  getVaporInteropPlugin,
  defineVaporCommand,
  defineVaporCustomElement,
  defineVaporComponent,
  defineVaporAsyncComponent,
  useVaporAsyncCommand,
} from './chamber-vapor';
