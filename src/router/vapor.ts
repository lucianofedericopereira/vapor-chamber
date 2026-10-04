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
 * drop: roughly 20 KB brotli - not a fixed number, so it is not written here.
 * `tests/vapor/vapor-outlet-size.test.ts` re-measures it every run with Vite's
 * build API, the bundler consumers ship with, against a baseline derived by
 * the same harness; the stamped values live in docs/router.md
 * (`vc:outletSaving`, `vc:outletOwnArm`). It asserts this module's OWN cost
 * over a router-without-outlet floor as well as a coarse floor on the saving,
 * measured with the consumer's bundler (bundlers disagree on this number).
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 * - **No registry, no `configureVue()`.** Every Vue helper is a STATIC import
 *   from bare `vue`, as in every other router module. Registry access would
 *   bring back the failure class `/vapor` exists to avoid: the probe cannot
 *   resolve in a production bundle, and a miss HERE would render an outlet as
 *   silently empty in production. A static import inverts the
 *   failure mode: an upstream rename is a consumer BUILD error, never a
 *   runtime null.
 * - **No `package.json#sideEffects` entry.** Unlike `/vapor`, importing this
 *   subpath wires nothing; it only exports a component.
 * - **No blade rows.** `makeBladeComponent` is `defineComponent`/`h`, so a
 *   blade row reaching this outlet is an `invalid:component` throw. Blade rows
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

import { createDynamicComponent, createIf, createSlot, defineVaporComponent, inject, provide } from 'vue';
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
    'invalid:component',
    `route "${entry.record.name}" is not a Vapor component${
      DEV
        ? entry.record.blade
          ? ': blade rows render through interop - use the vDOM outlet'
          : ': wrap it in defineVaporComponent (or compile the SFC in vapor mode)'
        : ''
    }`,
  );
}

/** The `createIf` flags compiler-vapor emits for a single-root `v-if` with a single-root `v-else`, keyed. */
const IF_ELSE_SLOT = 261;

export const RouterOutlet = defineVaporComponent({
  name: 'RouterOutlet',
  setup(_props, ctx) {
    const { slots } = ctx;
    const router = inject<Router>(ROUTER_KEY);
    // Coded, matching ./outlet (`routerError` is already in this module's graph
    // for invalid:component, so it costs no bytes).
    if (!router) throw routerError('missing:router', '<RouterOutlet> used without an installed router');

    const depth = inject<number>(OUTLET_DEPTH_KEY, 0);
    provide(OUTLET_DEPTH_KEY, depth + 1);

    const entryAt = () => router.currentRoute.value.render[depth];
    // A literal null when nothing matches: that is what renders a true empty
    // branch, with the fragment's own anchor as the only node left.
    const matched = () =>
      createDynamicComponent(() => {
        const entry = entryAt();
        return entry ? vaporComponentOf(entry) : null;
      });

    // With a default slot, the no-match branch is the slot, and it is created
    // INSIDE a `createIf` branch: each time the branch is entered, in that
    // branch's scope. Removing a fragment stops its scope, so a slot built
    // once in setup and handed back after a child route had replaced it came
    // back as its last DOM with no effect behind it (the reactive-slot arm of
    // tests/vapor/vapor-outlet.test.ts). This is the call compiler-vapor emits
    // for `<component :is="c" v-if="c" /><slot v-else />`, flags included;
    // tests/vapor/vapor-outlet-helpers.test.ts recompiles that template and
    // compares. Without a slot there is no `createIf`: an empty slot fragment
    // still owns an anchor node, and the empty branch must stay one node.
    //
    // "With a default slot" includes one that may appear LATER. A conditional
    // slot, `<template v-if="on" #default>`, compiles to a dynamic source in
    // the raw slots' `$` list, and while its condition is off `slots.default`
    // is undefined. Read once in setup, that sent the outlet down the no-slot
    // path for its whole life (the conditional-slot arm of the same test). So
    // `$` being present is enough to take the slot path; `createSlot` follows
    // the source from there.
    //
    // `slots` and `rawSlots` are the two property reads in the dependency
    // surface: Vapor's `setup` receives the component INSTANCE as its second
    // argument, and there is no public slot-existence helper to ask instead.
    // `rawSlots` is not in the typed setup context, hence the cast and the
    // `?.`: handed a narrower object, the outlet falls back to the setup-time
    // read, it does not throw. tests/vapor/vapor-outlet-helpers.test.ts pins
    // both reads.
    return slots.default || (ctx as { rawSlots?: { $?: unknown } }).rawSlots?.$
      ? createIf(entryAt, matched, () => createSlot('default'), IF_ELSE_SLOT)
      : matched();
  },
});
