/**
 * vapor-chamber/vue - the entry for apps that have Vue.
 *
 * Import the composables from HERE instead of the package root and Vue wiring
 * stops being something you can forget. There is no `configure...()` to call and
 * no probe to lose a race with: this module imports Vue's primitives
 * statically, so the consumer's bundler resolves them at build time and they
 * reach the core the moment the module is evaluated.
 *
 * @example
 * import { useCommand, untracked } from 'vapor-chamber/vue';
 *
 * WHY THIS EXISTS. The package root has to survive with no Vue in the tree -
 * Blade sprinkles, vanilla pages, the bus on its own - so it reaches Vue
 * through a runtime probe: a bare dynamic `import()` of a specifier held in a
 * variable. That answers correctly under a dev server and fails in every
 * production bundle, where a bare specifier has nothing to resolve against and
 * the rejection is swallowed. Two things degraded silently as a result:
 * `untracked()` became a pass-through, so a dispatch inside a reactive effect
 * leaked the handler's reads into that effect; and Vapor detection came up
 * empty on pages that had Vapor bundled into them.
 *
 * The root cannot fix that for itself - a static `import ... from 'vue'` there
 * would break every Vue-less consumer at link time. An entry only Vue users
 * import can, and that is the split the router subpaths already use: entries
 * that require Vue import it, the entry that must live without it probes.
 *
 * COST: none. `vue` and `@vue/reactivity` are external, so they resolve to the
 * copies already in the consumer's graph - never a second reactivity instance.
 *
 * SCOPE: named imports, and only the Vue 3.5-safe surface. A namespace import
 * (`import * as Vue`) would force the consumer's bundler to retain every Vue
 * export - measured at 3x bundle size on the vapor-sfc example - and the Vapor
 * APIs do not exist on 3.5, where importing them by name is a link error. Vapor
 * wiring belongs in a 3.6-only subpath.
 *
 * THE LIST IS LOAD-BEARING, NOT DECORATIVE - v1.17.0 fixed a name missing from
 * it. `hasInjectionContext` (Vue 3.3+, so inside this entry's 3.5-safe scope)
 * was absent, and `applyVueModule` reads it. Its consumer is
 * `tryKeepAliveHooks`, which gates on it precisely BECAUSE
 * `getCurrentInstance()` returns null inside a Vapor component by design - the
 * rc.4 finding. Without it in the registry that gate silently falls back to
 * `getCurrentInstance()` and goes inert, so `useCommandHistory` /
 * `useCommandError` record commands dispatched into a DEACTIVATED KeepAlive
 * view: the exact bug rc.4 fixed, reintroduced through the wiring path rather
 * than through the guard.
 *
 * Why it survived: `tryKeepAliveHooks` calls `probeVue()` first, and under a
 * dev server (or vitest) the probe resolves `import('vue')` and supplies the
 * FULL namespace, `hasInjectionContext` included - so the omission is invisible
 * everywhere the suite runs. It bites only in a production bundle, where the
 * bare specifier cannot resolve and the registry holds nothing but what this
 * list passed. Dev-correct / prod-broken, the same asymmetry that motivated
 * this entry's existence in the first place.
 *
 * So: when `chamber.ts` starts reading a new registry entry, it must be added
 * here too, or it exists only for probe-path consumers. Pinned by
 * `tests/vue-subpath-wiring-fixture.test.ts`, which blocks the probe to
 * reproduce a built bundle and asserts the KeepAlive guard still holds.
 */

import {
  ref,
  shallowRef,
  getCurrentScope,
  getCurrentInstance,
  hasInjectionContext,
  onScopeDispose,
  onActivated,
  onDeactivated,
} from 'vue';
import { pauseTracking, resetTracking } from '@vue/reactivity';
import { configureVue, _wireUntrack } from './chamber';

// Evaluated on import - this IS the wiring. Both calls are synchronous and
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
  // Load-bearing, and it was MISSING until v1.17.0 - see the note below.
  hasInjectionContext,
  onScopeDispose,
  onActivated,
  onDeactivated,
});

// `@vue/reactivity` and not `vue`: the tracking primitives are not on the `vue`
// entry. Re-verified at 3.6.0-rc.6 by enumerating both modules - `pauseTracking`,
// `resetTracking`, `enableTracking` and `setActiveSub` are all undefined on
// `vue` and all functions on `@vue/reactivity`, which resolves to the *same
// module instance* Vue itself uses. (First verified at rc.3; this was the
// second copy of that claim, and chamber.ts carried the first.)
_wireUntrack(pauseTracking, resetTracking, /* viaSubpath */ true);

/**
 * Wire Vue's reactivity into the core explicitly.
 *
 * Only needed by code that must keep importing from the package ROOT - calling
 * it repairs the root's `untracked()` in a production bundle. Importing
 * anything from this module already does the same thing, so prefer that.
 *
 * Idempotent.
 */
export function enableVueReactivity(): void {
  _wireUntrack(pauseTracking, resetTracking, /* viaSubpath */ true);
}

// The Vue-dependent surface, re-exported so that importing it is what wires
// Vue. These are the same functions the root exports - not copies - so a mixed
// codebase cannot end up with two buses or two registries.
export {
  signal,
  untracked,
  useCommand,
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
