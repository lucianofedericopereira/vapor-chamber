/**
 * vapor-chamber/vue — the entry for apps that have Vue.
 *
 * Import the composables from HERE instead of the package root and Vue wiring
 * stops being something you can forget. There is no `configure…()` to call and
 * no probe to lose a race with: this module imports Vue's primitives
 * statically, so the consumer's bundler resolves them at build time and they
 * reach the core the moment the module is evaluated.
 *
 * @example
 * import { useCommand, untracked } from 'vapor-chamber/vue';
 *
 * WHY THIS EXISTS. The package root has to survive with no Vue in the tree —
 * Blade sprinkles, vanilla pages, the bus on its own — so it reaches Vue
 * through a runtime probe: a bare dynamic `import()` of a specifier held in a
 * variable. That answers correctly under a dev server and fails in every
 * production bundle, where a bare specifier has nothing to resolve against and
 * the rejection is swallowed. Two things degraded silently as a result:
 * `untracked()` became a pass-through, so a dispatch inside a reactive effect
 * leaked the handler's reads into that effect; and Vapor detection came up
 * empty on pages that had Vapor bundled into them.
 *
 * The root cannot fix that for itself — a static `import … from 'vue'` there
 * would break every Vue-less consumer at link time. An entry only Vue users
 * import can, and that is the split the router subpaths already use: entries
 * that require Vue import it, the entry that must live without it probes.
 *
 * COST: none. `vue` and `@vue/reactivity` are external, so they resolve to the
 * copies already in the consumer's graph — never a second reactivity instance.
 *
 * SCOPE: named imports, and only the Vue 3.5-safe surface. A namespace import
 * (`import * as Vue`) would force the consumer's bundler to retain every Vue
 * export — measured at 3× bundle size on the vapor-sfc example — and the Vapor
 * APIs do not exist on 3.5, where importing them by name is a link error. Vapor
 * wiring belongs in a 3.6-only subpath.
 */

import {
  ref,
  shallowRef,
  getCurrentScope,
  getCurrentInstance,
  onScopeDispose,
  onActivated,
  onDeactivated,
} from 'vue';
import { pauseTracking, resetTracking } from '@vue/reactivity';
import { configureVue, _wireUntrack } from './chamber';

// Evaluated on import — this IS the wiring. Both calls are synchronous and
// idempotent, so anything imported from this module is already correct on its
// first use: no tick to wait for, no probe to beat.
//
// `./dist/vue.js` is listed in package.json#sideEffects so a bundler cannot
// hoist the re-exports below and skip this body.
configureVue({
  ref,
  shallowRef,
  getCurrentScope,
  getCurrentInstance,
  onScopeDispose,
  onActivated,
  onDeactivated,
});

// `@vue/reactivity` and not `vue`: the tracking primitives are not on the `vue`
// entry. Verified against 3.6.0-rc.3 — `pauseTracking`, `resetTracking` and
// `setActiveSub` are absent from both `vue.runtime.esm-bundler.js` and
// `vue.runtime-with-vapor.esm-browser.js`, while `@vue/reactivity` exports all
// three and resolves to the *same module instance* Vue itself uses.
_wireUntrack(pauseTracking, resetTracking, /* viaSubpath */ true);

/**
 * Wire Vue's reactivity into the core explicitly.
 *
 * Only needed by code that must keep importing from the package ROOT — calling
 * it repairs the root's `untracked()` in a production bundle. Importing
 * anything from this module already does the same thing, so prefer that.
 *
 * Idempotent.
 */
export function enableVueReactivity(): void {
  _wireUntrack(pauseTracking, resetTracking, /* viaSubpath */ true);
}

// The Vue-dependent surface, re-exported so that importing it is what wires
// Vue. These are the same functions the root exports — not copies — so a mixed
// codebase cannot end up with two buses or two registries.
export {
  signal,
  untracked,
  useCommand,
  useCommandBus,
  useCommandState,
  useSharedCommandState,
  useCommandHistory,
  useCommandGroup,
  useCommandError,
  useCommandQuery,
  configureVue,
  waitForVueDetection,
  isVaporAvailable,
} from './chamber';

export type { Signal, CreateSignal } from './signal';
