/**
 * vapor-chamber/router/vapor - the router's Vapor render surface.
 *
 * Sibling to `./vdom`, and named the same way: for what it costs. Importing
 * from here opts into Vue's **Vapor** runtime, so it carries a stricter floor
 * than the package's peer range (Vue >= 3.6), exactly like
 * `vapor-chamber/vapor`. A 3.5 consumer must not import it.
 *
 *   import { createRouter } from 'vapor-chamber/router';        // neither renderer
 *   import { RouterOutlet } from 'vapor-chamber/router/vdom';   // vDOM
 *   import { RouterOutlet } from 'vapor-chamber/router/vapor';  // Vapor
 *
 * The export is `RouterOutlet`, the same name `./vdom` exports: the subpath is
 * already the namespace, so moving between the two is an import-path change
 * rather than a rename.
 *
 * Same snapshot contract as `./outlet.ts` (`render[depth]`, the
 * `OUTLET_DEPTH_KEY` provide/inject ladder, keyless so the resolved component
 * decides a swap), rendered through Vapor's own helpers instead of
 * `defineComponent` + `h()`. A pure-Vapor app therefore mounts no vnode and
 * needs no `vaporInteropPlugin`, which is the whole cost this module exists to
 * drop: >= 20 KB brotli, re-measured every run by
 * `tests/vapor/vapor-outlet-size.test.ts` against a baseline derived with the
 * same harness.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 * - **No registry, no `configureVue()`.** Every Vue helper is a STATIC import
 *   from bare `vue`, as in every other router module. Registry access would
 *   re-import the failure class v1.17.0 shipped `/vapor` to kill: the probe
 *   cannot resolve in a production bundle, and a miss HERE would render an
 *   outlet as silently empty in production. A static import inverts the
 *   failure mode: an upstream rename is a consumer BUILD error, never a
 *   runtime null.
 * - **No `package.json#sideEffects` entry.** Unlike `/vapor`, importing this
 *   subpath wires nothing; it only exports a component.
 * - **No blade rows.** `makeBladeComponent` is `defineComponent`/`h`, so a
 *   blade row reaching this outlet is a `mode_mismatch` throw. Blade rows
 *   render through `./vdom` plus `vaporInteropPlugin`.
 * - **No interop fallback.** Falling back silently would restore the whole
 *   cost the module exists to avoid; the guard below refuses instead.
 * - **No transition / KeepAlive / SSR integration**, parity with `./vdom`,
 *   which is keyless and exposes no scoped slot around the changing component.
 *
 * The helpers used here are what compiled Vapor SFCs call, not documented
 * user-facing API. `tests/vapor/vapor-outlet-helpers.test.ts` enumerates that
 * dependency surface through the bundler entry, so an upstream rename fails in
 * this repo before it fails at a consumer.
 *
 * SIZE. This module is held to 0.5 KB brotli as its own BUNDLE-SIZES row. The
 * shape below is what fits: the whole DEV branch is one inline dead expression
 * rather than a helper call, so a consumer's production build drops both
 * message variants in a single step. Do not restructure it into a helper
 * without re-running `npm run size:doc`.
 */

import { createDynamicComponent, createSlot, defineVaporComponent, inject, provide } from 'vue';
import { DEV } from '../dev';
import { routerError } from './errors';
import { OUTLET_DEPTH_KEY, ROUTER_KEY } from './keys';
import type { Router } from './router-type';
import type { RenderEntry } from './types';

/**
 * Mode guard. Upstream has none to inherit.
 *
 * `createDynamicComponent` gates its vnode branch on interop being installed
 * (`appContext.vdom`). With no interop a vDOM component does not error: it
 * falls through to Vapor-mode component creation, which is wrong-mode
 * rendering with no upstream diagnostic. So the guard is this outlet's own,
 * and it throws a coded error rather than installing interop behind the
 * consumer's back.
 *
 * `defineVaporComponent` stamps `__vapor === true`; a vDOM component has
 * `undefined`. The read is on the COMPONENT and nothing is written back: a
 * mode flag on `RenderEntry` would fork the shape every outlet reads, and
 * `loadComponent`/the engine stay render-agnostic by design.
 */
function vaporComponentOf(entry: RenderEntry): unknown {
  const component = entry.component as { __vapor?: unknown } | null | undefined;
  if (component?.__vapor === true) return component;
  // Unconditional: handlers switch on `code`, so the throw cannot be dev-only.
  // Only the cause/fix tail is gated. Two causes, two fixes, so two tails; the
  // blade one is the documented v1 caveat made loud at the exact moment a
  // consumer hits it.
  throw routerError(
    'mode_mismatch',
    `route "${entry.record.name}" is not a Vapor component${
      DEV
        ? entry.record.blade
          ? ': blade rows render through interop - use the vDOM outlet'
          : ': wrap it in defineVaporComponent (or compile the SFC in vapor mode)'
        : ''
    }`,
  );
}

export const RouterOutlet = defineVaporComponent({
  name: 'RouterOutlet',
  setup(_props, { slots }) {
    const router = inject<Router>(ROUTER_KEY);
    // Coded, matching ./outlet. `routerError` is already in this module's graph
    // for mode_mismatch, and it prepends the same prefix this string used to
    // carry inline, so the message is unchanged and the bytes do not grow.
    if (!router) throw routerError('no_router', '<RouterOutlet> used without an installed router');

    const depth = inject<number>(OUTLET_DEPTH_KEY, 0);
    provide(OUTLET_DEPTH_KEY, depth + 1);

    // Built once in setup, never inside the branch getter: `createSlot` reads
    // the current scope owner and allocates a fragment per call, so one call
    // per navigation would leak fragments and defeat branch keying. Gated on
    // the slot existing because an empty slot fragment still owns an anchor
    // node, so the no-slot no-match case must reach `createDynamicComponent`
    // as a LITERAL null, which is what renders a true empty branch. The two
    // helpers are mutually exclusive per branch, not composable.
    //
    // `slots` is the ninth item of the dependency surface: Vapor's `setup`
    // receives the component INSTANCE as its second argument, and there is no
    // public slot-existence helper to ask instead.
    const fallback = slots.default ? createSlot('default') : null;

    return createDynamicComponent(() => {
      const entry = router.currentRoute.value.render[depth];
      return entry ? vaporComponentOf(entry) : fallback;
    });
  },
});
