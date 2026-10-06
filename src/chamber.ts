/**
 * vapor-chamber - Vue Vapor integration
 *
 * What `tryAutoCleanup()` relies on from Vue: the PUBLIC `getCurrentScope()` /
 * `onScopeDispose()` pair, and Vue stopping a scope it owns - a component
 * created but never mounted (a sibling's render threw) has its scope stopped
 * on unmount since rc.8 (efa2eae), so a `useCommand().on()` listener does not
 * outlive `app.unmount()` (tests/never-mounted-disposal-fixture.test.ts).
 * `warnUnwired()` is the one production warning, for a Vue app whose
 * composables came from the root with nothing wired. The history is in
 * CHANGELOG.md.
 */

import { DEV } from './dev';
import { disposeAll, _targetKey, unsealBus, _isSyncBus, _errResult, type CommandBus, type Command, type CommandResult, type CommandMap, type TargetOf, type PayloadOf, type ResultOf, type Handler, type Plugin, type RegisterOptions, type Listener } from './command-bus';
import { configureSignal, signal } from './signal';
import { createLedger } from './ledger';
import { countOption } from './bounds';
import { getCommandBus, resetCommandBus, setCommandBus } from './shared-bus';

/**
 * Build-time flag injected by `scripts/build.mjs` via Vite `define`: `true` in
 * the three IIFE (<script>-tag) bundles, `false` in the ESM build.
 *
 * Declared inline rather than in a `.d.ts` so it travels with this module -
 * `examples/tsconfig.patterns.json` reaches this file through imports and
 * would not pick up an ambient declaration from `src/`.
 *
 * Every call site guards with `typeof __VC_IIFE__ !== 'undefined'`, so the
 * symbol is safe where no define exists (vitest, plain `tsc`, importing `src/`
 * directly). Vite substitutes inside `typeof` too, so the IIFE build still
 * const-folds and drops the dead branch.
 */
declare const __VC_IIFE__: boolean | undefined;

/**
 * `true` under a dev server running `vaporChamberWire()` (vapor-chamber/vite),
 * which defines it. It arrives as a GLOBAL, never substituted into this file:
 * Vite leaves dependency code untouched in dev and assigns every define to
 * `globalThis` from its client env module, and vitest does the same in its
 * test runtime - so it is read through the same `typeof` guard as
 * `__VC_IIFE__`. Only {@link warnProbePath} reads it.
 */
declare const __VC_WIRED__: boolean | undefined;

/**
 * `true` in an app BUILD that wires Vue statically: `vaporChamberWire()`
 * defines it in a Vite build, and an esbuild or webpack app defines it with
 * one line when it imports its composables from `vapor-chamber/vue` (or
 * `/vapor`). Such a build needs no runtime probe, so the probe's body and
 * {@link warnUnwired} sit inside a condition on it and fold away; the
 * probe's `import('vue')` is what made esbuild and webpack ship all of Vue
 * (tests/root-probe-builds.test.ts). Absent, nothing changes, which is what
 * keeps a root-only Vue app working on those bundlers. `false` in the IIFE
 * builds (scripts/build.mjs), so the guard costs them nothing.
 *
 * Written as a CONDITION around the code, never an early return: Vite's
 * minifier kept a function's body after a folded `if (true) return`
 * (measured in the 1.26 evaluation).
 */
declare const __VC_WIRED_BUILD__: boolean | undefined;
// The build profile: true from `vaporChamberWire({ profile: 'lean' })`, false
// from the plugin otherwise and from the IIFE builds; undefined (performance)
// through a bundler without the plugin. Read in trackLoading.
declare const __VC_LEAN__: boolean | undefined;

import type { Signal } from './signal';

// ---------------------------------------------------------------------------
// Signal abstraction
// ---------------------------------------------------------------------------
// The minimal signal API lives in `./signal` (no module-load side effects, so
// transports / plugins / form can import it without dragging Vue feature
// detection into ESM consumer bundles). This module adds the heavier behavior:
// async dynamic import of Vue, lifecycle hook detection, Vapor APIs.
//
// When the async probe resolves, applyVueModule() pushes Vue's ref() into the
// signal module via configureSignal() so SPA consumers eventually use the
// alien-signals-backed ref for real reactivity.

// Re-export the signal API so existing import paths (`from 'vapor-chamber'`)
// keep working without source change.
export type { Signal, CreateSignal } from './signal';
export { configureSignal };
export { signal };

let _vueOnScopeDispose: ((fn: () => void) => void) | null = null;
let _vueGetCurrentScope: (() => any) | null = null;
let _vueGetCurrentInstance: (() => any) | null = null;
/** Vue 3.3+. True inside BOTH a Vapor and a VDOM setup() - see tryKeepAliveHooks. */
let _vueHasInjectionContext: (() => boolean) | null = null;
let _vueOnActivated: ((fn: () => void) => void) | null = null;
let _vueOnDeactivated: ((fn: () => void) => void) | null = null;
let _vueProbed = false;
// Vue's DEEP ref(), kept separately from the shallowRef() wired into signal().
// Used only by the opt-in vapor-chamber/reactive companion (deepSignal /
// useDeepCommandState); the core never touches it.
let _vueDeepRefFn: (<T>(v: T) => { value: T }) | null = null;

// Vue 3.6+ Vapor detection
let _hasVapor = false;
let _createVaporAppFn: any = null;
let _vaporInteropPluginRef: any = null;
// Vue 3.6+ Vapor APIs (introduced across 3.6.0-alpha.3-5)
let _defineVaporCustomElementFn: any = null;
let _defineVaporComponentFn: any = null;
let _defineVaporAsyncComponentFn: any = null;

// Dev-only: the "no active Vue scope" warning fires at most once per session.
// Composables are routinely used outside setup()/effectScope() in tests and
// non-component code, and repeating the warning per call floods the output.
let _autoCleanupWarned = false;

/** Promise that resolves once Vue detection is complete. Await this in composables
 *  that need Vue APIs to be available before first use. */
let _probePromise: Promise<void> | null = null;

/** Takes what the library uses from a Vue namespace; every caller passes one. */
function applyVueModule(vue: any): void {
  if ((typeof vue.shallowRef === 'function' || typeof vue.ref === 'function')) {
    // Push Vue's shallowRef() into the signal module so signal() returns a real
    // alien-signals-backed reactive WITHOUT the deep-Proxy wrap that ref()
    // applies to object/array values via toReactive(). The library only ever
    // REPLACES a signal's value wholesale (state.value = handler(...),
    // errors.value = [...], past.value = [...]) - it never mutates nested fields
    // in place - so shallow tracking is semantically equivalent here while
    // avoiding the per-write proxy cost. Measured on the real dispatch path
    // (`tests/signal-shallow-ab.test.ts`): array-state useCommandState
    // ~2.9-3.0x faster, scalar signals ~1.2x. Re-measured on 3.6.0-rc.5, median
    // of 3 full runs (each itself a median of 5 interleaved reps): array/100
    // +196%, array/10 +179%, scalar +23%. Quote the runtime with the number,
    // and prefer the harness's printed table over any figure copied into prose.
    // Measure this with that harness, not with a raw shallowRef-vs-ref loop:
    // outside the dispatch path the two invert, because `ref(primitive)` never
    // builds a proxy and the gap there is a different phenomenon. Direct
    // nested mutation of a returned state (state.value.x = y) would bypass the
    // command bus anyway, which this library treats as an anti-pattern.
    // Falls back to ref() if shallowRef is somehow unavailable (Vue < 3.0).
    configureSignal(vue.shallowRef ?? vue.ref);
  }
  // Keep a handle to the DEEP ref() for the opt-in reactive companion.
  if (typeof vue.ref === 'function') {
    _vueDeepRefFn = vue.ref;
  }

  if (typeof vue.onScopeDispose === 'function') {
    _vueOnScopeDispose = vue.onScopeDispose;
  }
  // getCurrentScope() (Vue 3.2+) - returns the active effect scope or undefined.
  // Used as the guard before calling onScopeDispose, replacing the try/catch pattern.
  if (typeof vue.getCurrentScope === 'function') {
    _vueGetCurrentScope = vue.getCurrentScope;
  }
  if (typeof vue.getCurrentInstance === 'function') {
    _vueGetCurrentInstance = vue.getCurrentInstance;
  }
  // hasInjectionContext() (Vue 3.3+) - the only "am I inside a setup()?" probe
  // that answers TRUE in Vapor as well as VDOM. See tryKeepAliveHooks.
  if (typeof vue.hasInjectionContext === 'function') {
    _vueHasInjectionContext = vue.hasInjectionContext;
  }

  // KeepAlive lifecycle hooks (Vue 3.x)
  if (typeof vue.onActivated === 'function') {
    _vueOnActivated = vue.onActivated;
  }
  if (typeof vue.onDeactivated === 'function') {
    _vueOnDeactivated = vue.onDeactivated;
  }

  // Vue 3.6+ Vapor detection
  if (typeof vue.createVaporApp === 'function') {
    _hasVapor = true;
    _createVaporAppFn = vue.createVaporApp;
  }
  if (typeof vue.vaporInteropPlugin !== 'undefined') {
    _vaporInteropPluginRef = vue.vaporInteropPlugin;
  }

  // Vue 3.6+: Vapor custom elements and component definitions
  if (typeof vue.defineVaporCustomElement === 'function') {
    _defineVaporCustomElementFn = vue.defineVaporCustomElement;
  }
  if (typeof vue.defineVaporComponent === 'function') {
    _defineVaporComponentFn = vue.defineVaporComponent;
  }
  if (typeof vue.defineVaporAsyncComponent === 'function') {
    _defineVaporAsyncComponentFn = vue.defineVaporAsyncComponent;
  }
}

/**
 * The global slot this library owns for a hand-supplied Vue namespace.
 *
 * Distinct from `__VUE__` on purpose. `__VUE__` belongs to Vue, which assigns
 * the BOOLEAN `true` to it from `prepareApp()` (Vapor) and
 * `baseCreateRenderer()` (vDOM) - i.e. the moment the first app is created.
 * A namespace parked on `__VUE__` therefore survives only until something
 * mounts, after which the sync channel yields a truthy value that cannot be
 * used for anything. Pinned by `tests/vue-detection-global-clobber.test.ts`.
 *
 * This key has exactly one writer.
 */
const VUE_GLOBAL_KEY = '__VAPOR_CHAMBER_VUE__';

/** Reads a usable Vue namespace out of a global slot, or null. */
function readGlobal(key: string): any | null {
  try {
    const vue = (globalThis as any)[key];
    // The `.ref` check separates a namespace from anything else parked there.
    return vue && typeof vue.ref === 'function' ? vue : null;
  } catch {
    return null;
  }
}

/**
 * True once `configureVue()` has run (by hand, or from `vapor-chamber/vue`).
 * Only the DEV diagnostic reads it: a hand-configured app keeps reactivity,
 * cleanup and the KeepAlive guard in production and loses only `untracked()`,
 * so the warning must not claim more than that.
 */
let _vueConfigured = false;

/**
 * configureVue - hand the library Vue's module namespace explicitly.
 *
 * The reliable channel - recommended for every consumer who wants
 * deterministic Vapor wiring, bundler or not. It seeds the registry
 * synchronously (no probe race, wrappers' null path becomes unreachable) and
 * is the one channel that behaves identically however the page obtains Vapor:
 * bundler alias, import map, or the `esm-browser` dist. Essential on
 * no-bundler pages, where it is the only channel that cannot come up empty:
 * Detection otherwise depends on either a global slot Vue overwrites when the
 * first app mounts (see {@link VUE_GLOBAL_KEY}) or a bare-specifier
 * `import('vue')` that cannot resolve in a browser at all - so on a
 * `<script>`-tag page the two automatic channels can both come up empty while
 * Vapor is sitting right there, and `createVaporChamberApp()` throws
 * "Vue 3.6+ with Vapor mode required" on a page that has it.
 *
 * Call this before creating signals or apps. Safe to call more than once; the
 * last usable namespace wins. Mirrors `configureSignal()` - an explicit
 * escape hatch that removes a guess.
 *
 * IMPORTANT: pass the SAME Vue instance the rest of the page uses. Two
 * separately-imported Vue dist files are two disconnected reactivity engines
 * (a `ref()` from one is invisible to a `watchEffect` from the other, with no
 * error) - see the note in `probeVue` below.
 *
 * @example
 * import * as Vue from 'vue/dist/vue.runtime-with-vapor.esm-browser.js';
 * import { configureVue, createVaporChamberApp } from 'vapor-chamber';
 * configureVue(Vue);
 * createVaporChamberApp(App).mount('#app');
 */
export function configureVue(vue: object): void {
  if (!vue) return;
  _vueConfigured = true;
  applyVueModule(vue);
}

/**
 * Reactive dependency collection, suspended for the duration of a callback.
 *
 * No-ops until `_wireUntrack` installs Vue's `pauseTracking` / `resetTracking`,
 * so a caller brackets its call with them whether Vue is here or not.
 */
let _pause = (): void => {};
let _reset = (): void => {};

/**
 * True once `vapor-chamber/vue` has been imported, i.e. the tracking primitives
 * arrived at BUILD time and this bundle is correct in production.
 *
 * {@link warnProbePath} keys its diagnostic off this rather than off "the probe
 * failed", and records why that is the choice that fires anywhere.
 */
let _vueSubpathLoaded = false;
/** One-shot guard for the DEV diagnostic in {@link untracked}. */
let _untrackWarned = false;

/**
 * @internal Wire the tracking primitives directly, skipping the probe.
 *
 * Called by `vapor-chamber/vue`, which imports them STATICALLY so the
 * consumer's bundler resolves them at build time.
 *
 * `viaSubpath` distinguishes that call from the runtime probe's, which wires
 * the same primitives but only in environments that can resolve a bare
 * specifier - never a production bundle. Only the former means "this app is
 * correct once built".
 */
export function _wireUntrack(pause: () => void, reset: () => void, viaSubpath = false): void {
  if (viaSubpath) _vueSubpathLoaded = true;
  _pause = pause;
  _reset = reset;
}

/**
 * untracked - run `fn` without its reactive reads becoming dependencies of
 * whatever effect is currently running.
 *
 * A dispatch is an ACTION, not a read: nothing it touches should make the
 * caller re-run. Every composable in this module already applies this to its
 * own dispatches, so you only need it when calling a **raw bus** from inside a
 * reactive effect:
 *
 * @example
 * import { untracked, getCommandBus } from 'vapor-chamber';
 * watchEffect(() => {
 *   // without untracked(), anything the HANDLER reads becomes a dependency
 *   // of this effect, and it re-runs on state it never mentions
 *   untracked(() => getCommandBus().dispatch('cartSync', cart));
 * });
 *
 * No-op when Vue is not present, so it is safe to leave in shared code.
 * Vue fixed the same class of bug twice in 3.6.0-rc.3 (#15203, #15204) by
 * suspending tracking around callbacks - this is that idea at the bus edge.
 */
export function untracked<T>(fn: () => T): T {
  // In an IIFE the wiring below never runs (no bundler can resolve
  // `@vue/reactivity` from a <script> tag), so the slots are provably no-ops.
  // Folding that here lets the minifier reduce this to `fn()` and drop the
  // bracket entirely rather than shipping a branch that can only go one way.
  if (typeof __VC_IIFE__ !== 'undefined' && __VC_IIFE__) return fn();

  // Deliberately BEFORE the wired-path return - see warnProbePath().
  warnProbePath();

  _pause();
  try { return fn(); } finally { _reset(); }
}

/**
 * DEV diagnostic: Vue arrived through the runtime probe, not at build time.
 *
 * Runs at the first dispatch (untracked) and at the first composable call
 * (tryAutoCleanup), whichever comes first - a component that only registers
 * handlers or listens never dispatches, and it degrades in production just
 * the same. The point is to fire while the probe is still succeeding: on the
 * probe path everything works under the dev server and silently stops working
 * once the app is built, so warning only on observed failure would warn only
 * where nothing can be logged. Conditions: Vue is here (`_vueDeepRefFn`), the
 * build-time wiring is not (`_vueSubpathLoaded`), and no `vaporChamberWire()`
 * is wiring the build (`__VC_WIRED__`) - for its users the advice below names
 * an import the plugin already covers. One-shot, since both call sites are
 * hot. Folds away entirely in production builds.
 *
 * Where it shows: in a page where DEV is on - one under Vite's dev server,
 * where the ESM build's DEV reads `import.meta.env.DEV` because a page has no
 * `process` (measured in a real browser, Vite 8, package pre-bundled and
 * served unbundled), or a test runner with a DOM. Not on a server (no
 * `window`): Node resolves the bare `import()` in production too - measured
 * with the package externalized, a root composable gets a real Vue ref under
 * NODE_ENV=production - so there the advice below would be wrong.
 *
 * What a production bundle loses depends on whether `configureVue()` ran: by
 * hand it still wires reactivity, cleanup and the KeepAlive guard, and only
 * `untracked()` degrades (the tracking primitives are not on the `vue` entry).
 * Without it all four go, which is what tests/root-only-prod-fixture.test.ts
 * measures.
 */
function warnProbePath(): void {
  if (DEV && typeof window !== 'undefined' && _vueDeepRefFn !== null && !_vueSubpathLoaded && !_untrackWarned && !(typeof __VC_WIRED__ !== 'undefined' && __VC_WIRED__)) {
    _untrackWarned = true;
    console.warn(
      '[vapor-chamber] Vue detected at runtime rather than at build time.\n' +
      'This works right now because the dev server can resolve a bare ' +
      '`import()`. A production bundle cannot, and there, silently, ' +
      (_vueConfigured
        ? ''
        : 'the composables lose reactivity (their state becomes a plain { value }), ' +
          'cleanup (register() / on() outlive the component) and the KeepAlive guard ' +
          '(history and errors keep recording while deactivated), and ') +
      "untracked() degrades to a pass-through, so dispatches made inside a reactive " +
      "effect leak the handler's reads into that effect - components re-rendering " +
      'on state they never mention, with no error.\n' +
      "Fix: import the composables from 'vapor-chamber/vue' (or 'vapor-chamber/vapor' " +
      "in a Vapor app) instead of 'vapor-chamber'. Same functions, resolved by your " +
      'bundler. Nothing to call.',
    );
  }
}

/** One-shot guard for the production diagnostic in {@link warnUnwired}. */
let _unwiredWarned = false;

/**
 * Production diagnostic: Vue is running, but the registry is empty.
 *
 * The state a root-only Vue consumer lands in once built: the bare
 * `import('vue')` cannot resolve, and `__VUE__` holds Vue's own boolean, set
 * by `createVaporApp()` / `createApp()` in production builds too (see
 * {@link VUE_GLOBAL_KEY}). Nothing wires `configureSignal()`, `onScopeDispose`
 * or `hasInjectionContext`, so every composable hands back a plain `{ value }`,
 * arms no cleanup and skips the KeepAlive guard - measured by
 * tests/root-only-prod-fixture.test.ts. Before this it did so in silence.
 *
 * NOT dev-gated, on the vueDetectionHint() precedent: production is the only
 * place this state exists, so a DEV-only warning would never fire. `__VUE__ ===
 * true` is what keeps a non-Vue page quiet - Vue writes it only on app
 * creation. One-shot. The subpath advice is dropped from the IIFE builds (it
 * folds on `__VC_IIFE__`): a `<script>`-tag page has no bundler, and
 * `configureVue(Vue)`, the tail vueDetectionHint() already gives, is its remedy.
 */
function warnUnwired(): void {
  // Every composable creation passes here, so the test that is false once Vue
  // is wired comes first and alone: the build flag's `typeof` of a global that
  // is not defined is a slow lookup, and it cost useCommand() creation 7-8%
  // (perf-1.26 A/B, log s35.44). A wired build cannot be in this state; the
  // flag stays first INSIDE, so the inner block still folds there (see
  // __VC_WIRED_BUILD__) and the empty `if` goes with it.
  if (_vueDeepRefFn === null) {
    if (!(typeof __VC_WIRED_BUILD__ !== 'undefined' && __VC_WIRED_BUILD__) && !_unwiredWarned && (globalThis as any).__VUE__ === true) {
      _unwiredWarned = true;
      // Short on purpose: unlike the DEV text above, this ships in the IIFEs.
      console.warn(
        '[vapor-chamber] Composables run without reactivity, cleanup or KeepAlive guard. ' +
        (typeof __VC_IIFE__ !== 'undefined' && __VC_IIFE__
          ? ''
          : "Import them from 'vapor-chamber/vue' (or /vapor), or: ") +
        vueDetectionHint(),
      );
    }
  }
  warnProbePath();
}

function probeVue(): void {
  if (_vueProbed) return;
  _vueProbed = true;

  // A wired build has no probe at all (see __VC_WIRED_BUILD__).
  if (!(typeof __VC_WIRED_BUILD__ !== 'undefined' && __VC_WIRED_BUILD__)) {
    // 1. Synchronous probe. This is the only channel that can ever detect Vapor
    //    without a bundler (no-build IIFE / sprinkled-JS pages,
    //    docs/whitepaper.md section 9.6): the async probe below resolves a bare
    //    `import('vue')`, which Vue 3.6 NEVER wires to the Vapor-enabled build
    //    outside a bundler's alias magic (@vitejs/plugin-vue does this per-app
    //    when it sees `<script setup vapor>`) - Vapor is a physically separate
    //    dist file (vue.runtime-with-vapor.esm-*.js).
    //
    //    Only our own slot is read (`__VUE__` is Vue's: it holds a boolean once
    //    an app mounts); `configureVue()` bypasses it.
    //
    //    Do NOT try to "fix" a miss here with a second dynamic import of the
    //    with-vapor build as a fallback - verified directly that two
    //    separately-imported Vue dist files are two disconnected
    //    reactivity-engine instances (a ref() from one is invisible to a
    //    watchEffect from the other, silently, no error), so an automatic
    //    fallback would risk introducing exactly that bug rather than fixing
    //    anything.
    const fromGlobal = readGlobal(VUE_GLOBAL_KEY);
    if (fromGlobal) applyVueModule(fromGlobal);

    // 2. Async probe: dynamic import for ESM / Vite / bundler environments.
    //    Resolved by the time user code's first await/tick completes.
    //    Variable indirection prevents TS from statically resolving the optional peer dep.
    const vuePkg = 'vue';
    _probePromise = import(/* @vite-ignore */ vuePkg)
      .then((vue: any) => {
        applyVueModule(vue);
      })
      .catch(() => {
        // Vue not available - use plain signals, no auto-cleanup
      })
      .then(wireUntracked);

    /**
     * Wire {@link untracked} from `@vue/reactivity`, best-effort.
     *
     * That package and not `vue`: the primitives are simply not on the `vue` entry
     * - re-verified at 3.6.0-rc.6 by enumerating both modules, where
     * `pauseTracking`, `resetTracking`, `enableTracking` and `setActiveSub` are all
     * `undefined` on `vue` and all functions on `@vue/reactivity`, which resolves
     * to the *same module instance* Vue itself uses (a second copy would toggle
     * unrelated state and silently do nothing - checked). First verified at rc.3
     * and unchanged since; the RC is named because an unqualified "not on the vue
     * entry" is the kind of claim that quietly stops being true.
     *
     * SCOPE, measured: this works under a dev server and in vitest, and fails in
     * every production bundle - the specifier is bare, and a built bundle has no
     * import map to resolve it against. It is kept because it is the zero-config
     * path where it does work; production correctness comes from
     * `enableVueReactivity()` in the `vapor-chamber/vue` subpath, which resolves
     * the same primitives at BUILD time. `untracked()` warns once in DEV when this
     * probe has failed, rather than degrading in silence.
     *
     * The specifier is held in a variable so no bundler can fold it back into a
     * literal `import()` of that specifier: that would make the optional peer
     * statically resolvable from the package root and break consumers who lack it. Guarded by
     * `tests/dist-optional-peers.test.ts`, which is also why `src/vue.ts` is built
     * as its own pass in `scripts/build.mjs` - marking the peer external in the
     * main build is exactly what lets the fold happen.
     *
     * Declared inside this block, not beside probeVue: webpack parses a
     * function whether or not anything calls it, and warned "Critical
     * dependency" on the assembled specifier even in a wired build. In the
     * dead branch it is dropped (tests/root-probe-builds.test.ts).
     */
    async function wireUntracked(): Promise<void> {
      // An IIFE is loaded by a <script> tag, where a bare `import()` can never
      // resolve. `__VC_IIFE__` const-folds, so this whole function and its
      // specifier string are dropped from those bundles.
      if (typeof __VC_IIFE__ !== 'undefined' && __VC_IIFE__) return;
      if (_vueDeepRefFn === null) return; // no Vue - nothing to suspend
      try {
        // Assembled, not written. A plain `const pkg = '@vue/reactivity'` is folded
        // straight back into a literal `import()` of that specifier by Rollup now that the
        // package is a declared (optional) peer - Vite's lib mode auto-externalises
        // peers, and an external specifier is exactly what constant propagation is
        // free to inline. That literal is the leak `tests/dist-optional-peers.test.ts`
        // guards: statically resolvable from the package root, so every consumer
        // without the optional peer breaks at dep-optimize. `@vite-ignore` does not
        // prevent it - the pre-bundled dep is re-analysed.
        const pkg = ['@vue', 'reactivity'].join('/');
        const r: any = await import(/* @vite-ignore */ pkg);
        if (typeof r?.pauseTracking === 'function' && typeof r?.resetTracking === 'function') {
          _wireUntrack(r.pauseTracking, r.resetTracking);
        }
      } catch {
        // Probe unavailable. Nothing to record: the diagnostic keys off
        // `_vueSubpathLoaded`, which is already false here.
      }
    }
  }
}

// Kick off Vue detection at module load time so it's resolved
// by the time user code calls signal() (typically after a tick).
probeVue();

/**
 * Wait for Vue detection to complete. Call this in app setup if you need
 * to guarantee Vue APIs are available before the first signal() call.
 *
 * @example
 * import { waitForVueDetection, signal } from 'vapor-chamber';
 * await waitForVueDetection();
 * const count = signal(0); // guaranteed to use Vue ref() if available
 */
export async function waitForVueDetection(): Promise<void> {
  probeVue();
  // Null in a wired build, which runs no probe (see __VC_WIRED_BUILD__).
  if (_probePromise) await _probePromise;
}

// Composables below use signal() and call probeVue() explicitly via tryAutoCleanup.

// ---------------------------------------------------------------------------
// Vue 3.6+ Vapor detection
// ---------------------------------------------------------------------------

/**
 * Returns true if Vue 3.6+ with Vapor mode support is detected.
 */
export function isVaporAvailable(): boolean {
  return _hasVapor;
}

/**
 * @internal - one sentence explaining WHY detection came up empty, appended to
 * the `createVaporChamberApp` error.
 *
 * The failure this exists for is the confusing one: Vue is on the page, Vapor
 * is in the build, and the library still reports it missing because neither
 * automatic channel could reach the namespace. Distinguishing "no Vue here at
 * all" from "Vue is here and I cannot see it" is the difference between a
 * dependency problem and a one-line fix.
 */
export function vueDetectionHint(): string {
  // Deliberately NOT dev-gated. The audience most likely to hit this is the
  // no-bundler `<script>`-tag page (whitepaper section 9.6), which only ever runs a
  // production IIFE - stripping the diagnosis in prod would remove it exactly
  // where it is needed. Kept as small as the three-way distinction allows:
  // one shared tail, three short causes, no helper function.
  const cause =
    // Vue found, no Vapor: a genuine capability gap - the plain `vue` entry
    // ships no Vapor runtime, which is a separate build.
    _vueDeepRefFn !== null
      ? 'Vue lacks the Vapor build (vue/dist/vue.runtime-with-vapor.esm-*)'
      // The order-dependent case pinned by tests/vue-detection-global-clobber:
      // `__VUE__` is `true` because an app mounted, so the sync channel is
      // dead, and a browser cannot resolve the bare-specifier async import.
      : (globalThis as any).__VUE__
        ? 'Vue is on the page but unreachable (__VUE__ is Vue\'s own boolean)'
        : 'No Vue detected';
  return `${cause}. Pass it: configureVue(Vue).`;
}

/** @internal - for chamber-vapor.ts use only */
export function getVaporAppFn(): any { return _createVaporAppFn; }
/** @internal - for chamber-vapor.ts use only */
export function getVaporInteropRef(): any { return _vaporInteropPluginRef; }
/** @internal - for chamber-vapor.ts use only */
export function getDefineVaporCustomElementFn(): any { return _defineVaporCustomElementFn; }
/** @internal - for chamber-vapor.ts use only */
export function getDefineVaporComponentFn(): any { return _defineVaporComponentFn; }
/** @internal - for chamber-vapor.ts use only */
export function getDefineVaporAsyncComponentFn(): any { return _defineVaporAsyncComponentFn; }
/** @internal - Vue's DEEP ref(), for the vapor-chamber/reactive companion only.
 *  Returns null until Vue detection completes (or if Vue is absent). */
export function getVueDeepRefFn(): (<T>(v: T) => { value: T }) | null { return _vueDeepRefFn; }

// ---------------------------------------------------------------------------
// Shared command bus instance
// ---------------------------------------------------------------------------

/**
 * GlobalCommands - module-augmentation hook that types the SHARED bus
 * (pinia-style). Augment it once in your app and every `useCommand()` /
 * `getCommandBus()` call site gets typed dispatch/register with autocomplete
 * and compile errors:
 *
 * @example
 * declare module 'vapor-chamber' {
 *   interface GlobalCommands {
 *     cartAdd: { target: Product; payload: { qty: number }; result: Cart };
 *     cartClear: { target: null; result: Cart };
 *   }
 * }
 *
 * Unaugmented, everything stays exactly as loose as before (string actions,
 * `any` targets). Schema users: derive the entries with `InferMap<S>` from
 * './schema' instead of writing them by hand.
 */
// biome-ignore lint/suspicious/noEmptyInterface: augmentation hook by design
export interface GlobalCommands {}

/**
 * The CommandMap the shared bus is typed with: `GlobalCommands` when augmented,
 * the loose default `CommandMap` otherwise. Wrapped in a mapped type because
 * interfaces have no implicit index signature and would fail the CommandMap
 * constraint.
 */
export type SharedCommandMap = [keyof GlobalCommands] extends [never]
  ? CommandMap
  : { [K in keyof GlobalCommands]: GlobalCommands[K] };

// The shared bus lives in a probe-free module (see its header).
export { getCommandBus, setCommandBus, resetCommandBus };

// ---------------------------------------------------------------------------
// Vue lifecycle detection (optional - works without Vue too)
// ---------------------------------------------------------------------------

/**
 * Try to register a cleanup function on the nearest Vue scope/component.
 *
 * Uses `getCurrentScope()` to check whether a reactive scope is active before
 * calling `onScopeDispose` - no exception-as-control-flow, no `onUnmounted`
 * fallback: every component `setup()`, Vapor included, runs in an effect
 * scope. Registering costs a component no lifecycle update job (Vue creates
 * those lazily, beta.13).
 *
 * The cleanup attaches to whatever `getCurrentScope()` returns from `setup()`;
 * stopping that owner is Vue's job. An HMR rerender stops the scope of
 * children mounted INSIDE an element (rc.6, 9ab65a1) - without that, a
 * `useCommand().on()` listener stayed subscribed once per hot reload
 * (`tests/hmr-render-scope-fixture.test.ts`). Do not "harden" this against
 * leaked generations by tracking them here; the ownership belongs to Vue's
 * scope.
 *
 * No-ops entirely when called outside any Vue scope (e.g. module init time,
 * plain async callbacks). Caller is responsible for calling `dispose()` in
 * those cases.
 */
export function tryAutoCleanup(disposeFn: () => void): void {
  probeVue();
  // Every composable passes through here, so this is where "Vue is on the
  // page but not wired" can be seen before anything silently degrades.
  warnUnwired();

  if (_vueOnScopeDispose && _vueGetCurrentScope?.()) {
    _vueOnScopeDispose(disposeFn);
    return;
  }

  if (
    !_autoCleanupWarned &&
    _vueOnScopeDispose &&
    DEV
  ) {
    _autoCleanupWarned = true;
    console.warn(
      '[vapor-chamber] Heads-up (not an error): a composable ran outside a Vue ' +
      "setup() / effectScope(), so its cleanup won't run automatically. Either call " +
      'the returned dispose() yourself, or run the composable inside setup() / ' +
      'effectScope(). Expected and harmless when intentional - e.g. in tests, ' +
      'one-off scripts, or anywhere you dispose manually. Logged once per module.'
    );
  }
}

// ---------------------------------------------------------------------------
// KeepAlive pause/resume support
// ---------------------------------------------------------------------------

/**
 * Register KeepAlive lifecycle hooks to pause/resume bus subscriptions.
 *
 * When a component is deactivated by KeepAlive, `onPause` is called.
 * When reactivated, `onResume` is called. No-ops if not inside a
 * KeepAlive-wrapped component or if Vue is not available.
 *
 * The guard must answer "am I inside a setup()?" - `onActivated`/`onDeactivated`
 * do not throw outside one, they emit a Vue warning, so an unguarded call would
 * spam every non-component caller.
 *
 * It must NOT be `getCurrentInstance()`. That accessor reads VDOM's
 * `currentInstance`, and a Vapor component is not stored there: measured on
 * 3.6.0-rc.4, it returns null inside `defineVaporComponent({ setup() })` while
 * `onDeactivated()` registered at that same point works and fires. So the
 * former guard silently disabled KeepAlive pause/resume for every VAPOR
 * component - the platform this library is named for - while working in VDOM,
 * which is why no existing test saw it. `hasInjectionContext()` (Vue 3.3+) is
 * the one probe that is true in both modes and false in a bare `effectScope()`,
 * measured alongside. `getCurrentInstance()` remains the fallback for a
 * partially-supplied Vue namespace that predates it.
 * Pinned by `tests/keepalive-input-scope-fixture.test.ts`.
 *
 * rc.5 cycle - this is now known to be PERMANENT, not a gap awaiting a fix.
 * The rc.4 change was made from measurement alone, which left open whether a
 * later Vue release would make `getCurrentInstance()` answer in Vapor and turn
 * this gate back into dead weight. It will not: on the Vapor roadmap
 * (vuejs/core#13687, Jul 20) a Vue core maintainer confirmed the null is
 * INTENTIONAL, with an internal `useInstanceOption` API kept deliberately
 * non-public, and reaffirmed in August that Vapor exposes no general-purpose
 * component instance tree to userland by design. So do not "restore"
 * an instance-accessor probe here on the theory that it will start working.
 *
 * @internal - used by composables that manage bus subscriptions.
 */
export function tryKeepAliveHooks(onPause: () => void, onResume: () => void): void {
  probeVue();
  const inSetup = _vueHasInjectionContext
    ? _vueHasInjectionContext()
    : !!_vueGetCurrentInstance?.();
  if (!inSetup) return;
  _vueOnDeactivated?.(onPause);
  _vueOnActivated?.(onResume);
}

// ---------------------------------------------------------------------------
// runDispatch - shared loading/error wrapper. Two callers, both in this file:
// `useCommand` and `useCommandQuery`. It takes the bus and the call's
// arguments, not a thunk, and calls `bus.dispatch` / `bus.query` directly.
// Against the thunk shape (one closure per call through `untracked`) this
// takes 0.915-0.934x the time on `useCommand().dispatch`, 2.7-3.9 ns less
// (`npm run ab`, two call lengths, controls within 1%; log s35.53). With both
// callers interleaved the
// workload's own control spread up to 1.36x across processes, so no figure is
// claimed for that shape. A function passed in and called with
// `.call` gained nothing; why is not settled (V8 can inline through a
// parameter when the site's call feedback is monomorphic, and that was not
// checked with --trace-turbo-inlining).
//
// NOT used by chamber-vapor.ts: `useVaporAsyncCommand` hand-rolls its own
// wrapper and says why at its own site (~1.2x leaner than this .then-chain,
// measured, on a path whose entire point is to allocate nothing).
// ---------------------------------------------------------------------------

/** @internal */
export function runDispatch(
  bus: CommandBus,
  query: boolean,
  action: string,
  target: unknown,
  payload: unknown,
  loading: Signal<boolean>,
  lastError: Signal<Error | null>,
  onSuccess?: (value: any) => void,
): CommandResult | Promise<CommandResult> {
  let result: any;
  try {
    // Both opening writes are INSIDE the try. A synchronous subscriber can
    // throw out of a signal write; outside the try that left `loading` true
    // with the error escaping `dispatch`. Here it is a failed result like any
    // other, and the handler does not run
    // (tests/rundispatch-throwing-subscriber.test.ts).
    loading.value = true;
    lastError.value = null;
    // A dispatch is an action, not a read. Without this, every reactive value
    // the HANDLER touches becomes a dependency of whatever effect called the
    // composable, so the component re-runs on state it never mentions. Vue
    // fixed the same class twice in 3.6.0-rc.3 (#15203/#15204) the same way.
    // Pass-through when Vue is absent.
    if (typeof __VC_IIFE__ !== 'undefined' && __VC_IIFE__) {
      result = query ? bus.query(action, target, payload) : bus.dispatch(action, target, payload);
    } else {
      warnProbePath();
      _pause();
      try {
        result = query ? bus.query(action, target, payload) : bus.dispatch(action, target, payload);
      } finally {
        _reset();
      }
    }
  } catch (e) {
    loading.value = false;
    const error = e as Error;
    lastError.value = error;
    return _errResult(error);
  }
  if (result && typeof result.then === 'function') {
    return (result as Promise<CommandResult>).then(
      (r) => {
        loading.value = false;
        if (r.ok) onSuccess?.(r.value);
        else lastError.value = r.error ?? null;
        return r;
      },
      (e: Error) => { loading.value = false; lastError.value = e; return _errResult(e); },
    );
  }
  loading.value = false;
  if (result.ok) onSuccess?.(result.value);
  else lastError.value = result.error ?? null;
  return result;
}

// ---------------------------------------------------------------------------
// useCommand
// ---------------------------------------------------------------------------

/**
 * useCommand - reactive command dispatch with optional bus subscriptions.
 *
 * Returns `dispatch` + reactive `loading` / `lastError`, plus `register` / `on` /
 * `emit` for managing handlers and listeners with auto-cleanup on scope disposal
 * (`onScopeDispose`). Vapor-safe - works in `<script setup vapor>` and VDOM alike,
 * with no `getCurrentInstance()` dependency. For fire-and-forget with zero reactive
 * overhead, use `defineVaporCommand()` instead.
 *
 * (Absorbed the former `useVaporCommand` - the Vapor-safety distinction was obsolete;
 * this is now the single command composable.)
 *
 * @example
 * const { dispatch, register, on, loading, lastError } = useCommand();
 * register('cartAdd', (cmd) => addToCart(cmd.target));
 * dispatch('cartAdd', { id: product.id });
 */
export function useCommand() {
  // Untyped internally; the public dispatch/register signatures below carry
  // the SharedCommandMap typing (GlobalCommands augmentation).
  const bus = getCommandBus<CommandMap>();
  const loading = signal(false);
  const lastError = signal<Error | null>(null);
  const listeners: Array<() => void> = [];
  const registered: Array<{ action: string; handler: Handler; opts?: RegisterOptions; off: (() => void) | null }> = [];

  function dispatch<A extends keyof SharedCommandMap & string>(
    action: A,
    target: TargetOf<SharedCommandMap, A>,
    payload?: PayloadOf<SharedCommandMap, A>,
  ): CommandResult<ResultOf<SharedCommandMap, A>> | Promise<CommandResult<ResultOf<SharedCommandMap, A>>> {
    return runDispatch(bus, false, action, target, payload, loading, lastError);
  }

  function register<A extends keyof SharedCommandMap & string>(
    action: A,
    handler: (cmd: Command<A, TargetOf<SharedCommandMap, A>, PayloadOf<SharedCommandMap, A>>) => ResultOf<SharedCommandMap, A> | Promise<ResultOf<SharedCommandMap, A>>,
    opts?: RegisterOptions,
  ): () => void {
    // Kept so a KeepAlive deactivation can release it and an activation take
    // it back (below); the returned function removes it for good.
    const reg = { action: action as string, handler: handler as Handler, opts, off: bus.register(action, handler as Handler, opts) as (() => void) | null };
    registered.push(reg);
    const unregister = (): void => {
      reg.off?.();
      reg.off = null;
      const at = registered.indexOf(reg);
      if (at !== -1) registered.splice(at, 1);
    };
    listeners.push(unregister);
    return unregister;
  }

  function on(pattern: string, listener: (cmd: Command, result: CommandResult) => void): () => void {
    const unsub = bus.on(pattern, listener);
    listeners.push(unsub);
    return unsub;
  }

  /** Fire a domain event - notifies on() listeners, no handler required, no result. */
  function emit(event: string, data?: any): void {
    untracked(() => bus.emit(event, data));
  }

  function dispose() {
    disposeAll(listeners);
  }

  // A page cached by KeepAlive releases its handlers while it is off screen and
  // takes them back when it returns, so the page on screen is the one that
  // answers. useCommandHistory and useCommandError already followed KeepAlive
  // this way; this composable, the one that registers handlers, did not.
  // register()'s cleanup removes only its own entry, so releasing never takes
  // the visible page's handler. tests/usecommand-keepalive.test.ts.
  tryKeepAliveHooks(
    () => {
      for (const reg of registered) {
        reg.off?.();
        reg.off = null;
      }
    },
    () => {
      for (const reg of registered) reg.off ??= bus.register(reg.action, reg.handler, reg.opts);
    },
  );

  tryAutoCleanup(dispose);

  return { dispatch, register, on, emit, loading, lastError, dispose };
}

// ---------------------------------------------------------------------------
// useSharedCommandState
// ---------------------------------------------------------------------------

/**
 * Shared state attached to one bus. The ref-count tracks how many
 * `useSharedCommandState()` callers are still subscribed; when it hits zero
 * we drop the entry so the WeakMap can collect it (the bus itself is also
 * weakly held).
 */
type SharedCommandStateEntry = {
  inFlight: Signal<number>;
  isAnyLoading: Signal<boolean>;
  lastError: Signal<Error | null>;
  errors: Signal<Error[]>;
  errorCount: Signal<number>;
  refCount: number;
  maxSize: number;
  /** Bus-wide error observer - unhooked when refCount hits 0. */
  unsub: () => void;
  /** Per-(action, target) loading: a map by action, then by the target's
   *  `commandKey` part (`_targetKey`), so a dispatch builds no key string. Null
   *  until the first `isLoading()` call, so a bus nobody asks per-key questions
   *  of pays nothing. */
  slots: Map<string, Map<string, LoadingSlot>> | null;
  /** The slot each started Command counted into, so a settle is matched to
   *  ITS start and never decrements someone else's. On an async bus, or one
   *  this library did not make; a sync bus uses `stack`. */
  started: Map<Command, LoadingSlot> | null;
  /** A sync bus's starts, each Command followed by its slot, innermost last.
   *  Its settles come in LIFO order on every nesting path
   *  (tests/isloading-nesting.test.ts), so a settle is matched at the top. The
   *  match is still by identity: a settle with no start (a query, an emit, a
   *  command already running when tracking began) is not found and takes
   *  nothing, and one below a start that never settled is found and removed
   *  there. */
  stack: Array<Command | LoadingSlot> | null;
  /** The loading before-hook - unhooked with `unsub`. */
  unBefore: (() => void) | null;
  /** Commands started and not yet settled. While above 0 the entry outlives
   *  its last holder, so the next one sees the key still in flight; the
   *  settle that ends the last one releases it. */
  pending: number;
  /** An unread slot back at 0 is pruned only while its action's bucket holds
   *  more than this: 256 in the performance profile (the slot is reused, no
   *  allocation, set or delete per dispatch: 0.848-0.865x on a tracked
   *  dispatch, 21-22 ns, log s35.61), 0 in lean (pruned at once). Set from
   *  `__VC_LEAN__` when tracking starts (trackLoading), never per dispatch. */
  pruneAbove: number;
};

/** One key's in-flight count and the flag its readers subscribe to. `flag` is
 *  null until `isLoading()` reads the key, created then from the count, so a key
 *  nobody asks about costs no signal and no reactive write per dispatch
 *  (0.969-0.982x on a tracked dispatch, 3.6-6.1 ns, log s35.53). Once
 *  created it is written only on 0 <-> 1, so a reader re-runs on transitions of
 *  ITS key and on nothing else, and the slot is kept when its count returns to
 *  0, since the reader holds the signal and later dispatches must write that
 *  same one. A slot without one is pruned then in the lean profile; the
 *  performance profile keeps it for the next dispatch of its key while its
 *  bucket holds 256 or fewer (see `pruneAbove`). */
type LoadingSlot = { key: string; n: number; flag: Signal<boolean> | null; bucket: Map<string, LoadingSlot> };

const _sharedStates = new WeakMap<CommandBus, SharedCommandStateEntry>();

function loadingSlot(slots: Map<string, Map<string, LoadingSlot>>, action: string, key: string): LoadingSlot {
  let bucket = slots.get(action);
  if (bucket === undefined) {
    bucket = new Map();
    slots.set(action, bucket);
  }
  let slot = bucket.get(key);
  if (slot === undefined) {
    slot = { key, n: 0, flag: null, bucket };
    bucket.set(key, slot);
  }
  return slot;
}

/** Unhook the entry from its bus and forget it. */
function releaseSharedState(entry: SharedCommandStateEntry, bus: CommandBus): void {
  entry.unsub(); // the bus-wide error observer
  entry.unBefore?.(); // and the loading before-hook, if one was installed
  _sharedStates.delete(bus);
}

/**
 * Install a composable's observer past the seal. `seal()` protects the
 * handler/plugin topology, not the observation layer (command-bus.ts), so the
 * library's own hooks go in, and the bus is sealed again before this returns.
 * tests/composables-sealed-bus.test.ts.
 */
function pastSeal<T>(bus: CommandBus, install: () => T): T {
  const sealed = bus.isSealed();
  if (sealed) unsealBus(bus);
  try { return install(); }
  finally { if (sealed) bus.seal(); }
}

/**
 * Install per-key tracking on first use: a before-hook starts a Command, the
 * entry's `on('*')` observer settles it. On a sealed bus the hook is the
 * library's own, installed past the seal: the bus is sealed again before
 * this returns.
 */
function trackLoading(entry: SharedCommandStateEntry, bus: CommandBus): Map<string, Map<string, LoadingSlot>> {
  if (entry.slots === null) {
    const slots = new Map<string, Map<string, LoadingSlot>>();
    // The build profile, read once per entry: a `typeof` of a global nobody
    // defined is a slow lookup (docs/V8-RULES.md rule 6), and a define folds
    // this line to the write or to nothing.
    if (typeof __VC_LEAN__ !== 'undefined' && __VC_LEAN__) entry.pruneAbove = 0;
    pastSeal(bus, () => {
      if (_isSyncBus(bus)) {
        const stack: Array<Command | LoadingSlot> = [];
        entry.unBefore = bus.onBefore((cmd: Command) => {
          const slot = loadingSlot(slots, cmd.action, _targetKey(cmd.target));
          if (slot.n++ === 0 && slot.flag !== null) slot.flag.value = true;
          entry.pending++;
          stack.push(cmd, slot);
        });
        entry.stack = stack;
      } else {
        // A Map, not a WeakMap: every start is deleted at its settle, and a start
        // that never settled would already hold `pending` above 0 (the entry and
        // the key stay), so weakness would free only the Command. The WeakMap cost
        // 24-26 ns of a tracked dispatch's ~188 (this Map: 0.858-0.871x, log s35.53).
        const started = new Map<Command, LoadingSlot>();
        entry.unBefore = bus.onBefore((cmd: Command) => {
          const slot = loadingSlot(slots, cmd.action, _targetKey(cmd.target));
          if (slot.n++ === 0 && slot.flag !== null) slot.flag.value = true;
          entry.pending++;
          started.set(cmd, slot);
        });
        entry.started = started;
      }
    });
    entry.slots = slots;
  }
  return entry.slots;
}

export type UseSharedCommandStateOptions = {
  /**
   * How many recent errors to retain in `errors`. The list is kept
   * newest-last; older entries drop off. Default: 10.
   */
  maxSize?: number;
  /**
   * Bus to attach to. Defaults to the shared instance from `getCommandBus()`,
   * which matches the single-bus pattern most apps use. Pass an explicit bus
   * to scope shared state to a feature group / island.
   */
  bus?: CommandBus;
};

/**
 * useSharedCommandState - one set of reactive signals shared across every
 * caller, instead of two signals (`loading`, `lastError`) per call.
 *
 * Designed for component-heavy pages where many components need to react to
 * "is *anything* in flight?" or "what was the last error?". Replaces
 * `N x useCommand()` allocations with a single shared state per bus.
 *
 * Memory math: 50 components x 2 signals each = 100 signal nodes today.
 * With shared state: ~5 signal nodes total + a counter, regardless of
 * subscriber count.
 *
 * @example
 * // Components using this share isAnyLoading, errors, etc.
 * const { dispatch, isAnyLoading, lastError } = useSharedCommandState();
 * await dispatch('cartAdd', product);
 *
 * @example
 * // Disable an entire toolbar while any command is in flight.
 * const { isAnyLoading } = useSharedCommandState();
 * <Button :disabled="isAnyLoading.value">Save</Button>
 *
 * Auto-cleanup on Vue scope/component disposal via tryAutoCleanup.
 */
export function useSharedCommandState(options: UseSharedCommandStateOptions = {}) {
  const bus = options.bus ?? getCommandBus<CommandMap>();
  const maxSize = countOption(options.maxSize, 10); // a NaN is the default (bounds.ts)

  let state = _sharedStates.get(bus);
  if (!state) {
    // Observe errors BUS-WIDE, not only dispatches made through this
    // composable's own dispatch wrapper. Any failed command on the bus - from
    // useCommand, raw bus.dispatch, anywhere - lands in the
    // shared error list. (Both sync and async buses fan results to on('*')
    // listeners after settling.)
    //
    // The same observer settles per-key loading (isLoading). Before-hooks and
    // this fan-out are paired on every dispatch exit - normal, handler
    // throw/reject, a before-hook's throw - or neither fires (a buffered miss).
    // Some exits settle with NO start: a pre-flight abort, a query, emit(), a
    // before-hook that threw ahead of ours. Matching by Command object ignores
    // those rather than decrementing another dispatch's count. One exit starts
    // and never settles: a PLUGIN that throws or rejects escapes the runner, so
    // no listener fires and that key stays true. All pinned by
    // tests/command-loading-fixture.test.ts. inFlight/isAnyLoading stay scoped
    // to this composable's wrapper, which does catch that throw.
    // That exit is closed now: the runners turn a plugin's throw into a
    // <plugin>:failed:plugin result (pluginThrew), and the one throw left by contract,
    // `onMissing: 'throw'`, is settled before it is re-thrown
    // (syncRunSettling), so every start has a settle.
    // Declared ahead of `entry`, which it reads only when a command settles,
    // long after the literal below has run.
    const observe: Listener = (cmd, result) => {
      let slot: LoadingSlot | undefined;
      const stack = entry.stack;
      if (stack !== null) {
        let i = stack.length - 2;
        if (i >= 0 && stack[i] === cmd) {
          slot = stack.pop() as LoadingSlot;
          stack.pop();
        } else {
          i -= 2;
          while (i >= 0 && stack[i] !== cmd) i -= 2;
          if (i >= 0) slot = stack.splice(i, 2)[1] as LoadingSlot;
        }
      } else if (entry.started !== null) {
        slot = entry.started.get(cmd);
        if (slot !== undefined) entry.started.delete(cmd);
      }
      if (slot !== undefined) {
        if (--slot.n === 0) {
          if (slot.flag !== null) slot.flag.value = false;
          else if (slot.bucket.size > entry.pruneAbove) slot.bucket.delete(slot.key);
        }
        if (--entry.pending === 0 && entry.refCount <= 0) releaseSharedState(entry, bus);
      }
      if (!result.ok && result.error) {
        entry.lastError.value = result.error;
        const next = entry.errors.value.slice();
        next.push(result.error);
        while (next.length > entry.maxSize) next.shift();
        entry.errors.value = next;
        entry.errorCount.value = next.length;
      }
    };
    const entry: SharedCommandStateEntry = {
      inFlight: signal(0),
      isAnyLoading: signal(false),
      lastError: signal<Error | null>(null),
      errors: signal<Error[]>([]),
      errorCount: signal(0),
      refCount: 0,
      maxSize,
      unsub: bus.on('*', observe),
      slots: null,
      started: null,
      stack: null,
      unBefore: null,
      pending: 0,
      pruneAbove: 256,
    };
    state = entry;
    _sharedStates.set(bus, state);
  } else if (maxSize < state.maxSize) {
    // Tighten the cap if the new caller wants a smaller buffer; never grow
    // it above another caller's request (avoid surprise memory growth).
    state.maxSize = maxSize;
  }
  state.refCount++;

  function recordError(err: Error): void {
    // `onMissing: 'throw'` is now settled by the bus before it is re-thrown,
    // so the on('*') observer above has already recorded this exact error;
    // recording it again from the catch below would double-count it.
    if (state!.lastError.value === err) return;
    state!.lastError.value = err;
    const next = state!.errors.value.slice();
    next.push(err);
    while (next.length > state!.maxSize) next.shift();
    state!.errors.value = next;
    state!.errorCount.value = next.length;
  }

  function decrement(): void {
    const n = Math.max(0, state!.inFlight.value - 1);
    state!.inFlight.value = n;
    state!.isAnyLoading.value = n > 0;
  }

  function increment(): void {
    state!.inFlight.value++;
    state!.isAnyLoading.value = true;
  }

  function dispatch(
    action: string,
    target: any,
    payload?: any,
    opts?: { signal?: AbortSignal },
  ): CommandResult | Promise<CommandResult> {
    increment();
    let result: any;
    try {
      result = untracked(() => bus.dispatch(action, target, payload, opts));
    } catch (e) {
      const error = e as Error;
      recordError(error);
      decrement();
      return _errResult(error);
    }

    if (result && typeof result.then === 'function') {
      return (result as Promise<CommandResult>).then(
        // Settled results are recorded by the bus-wide on('*') observer -
        // recording here too would double-count.
        (r) => { decrement(); return r; },
        // A rejected dispatch promise bypassed the bus's errResult fan-out,
        // so no listener fired - record it here.
        (e: Error) => { recordError(e); decrement(); return _errResult(e); },
      );
    }

    // Settled sync results already hit the bus-wide on('*') observer.
    decrement();
    return result;
  }

  /** Wipe accumulated errors. Does not affect in-flight counter. */
  function clear(): void {
    state!.errors.value = [];
    state!.errorCount.value = 0;
    state!.lastError.value = null;
  }

  /**
   * Reactive "is THIS (action, target) in flight?", bus-wide - any dispatch
   * counts, not only this composable's. Keyed like `commandKey`, so object
   * targets match by value. `isLoading(action)` is the exact key
   * `(action, undefined)`, not "any target of this action".
   *
   * Atomic: each key has its own signal, written only when its count crosses
   * 0 <-> 1, so a reader re-runs on ITS key's transitions and no other's.
   * Tracking starts on the first call for this bus; a dispatch already in
   * flight then is not counted. It works on a sealed bus (see trackLoading),
   * and a key still in flight when the last holder leaves reads lit for the
   * next one (see `pending`).
   */
  function isLoading(action: string, target?: unknown): Readonly<Signal<boolean>> {
    const slot = loadingSlot(trackLoading(state!, bus), action, _targetKey(target));
    // Created on the first read, lit if the key is already in flight.
    if (slot.flag === null) slot.flag = signal(slot.n > 0);
    return slot.flag;
  }

  // Once per holder: a manual dispose() followed by the scope's own would
  // count this holder out twice and release an entry a later holder uses
  // (tests/shared-state-dispose-twice.test.ts).
  let held = true;
  function dispose(): void {
    if (!held) return;
    held = false;
    // With a command in flight the entry stays (see `pending`).
    if (--state!.refCount <= 0 && state!.pending === 0) releaseSharedState(state!, bus);
  }

  tryAutoCleanup(dispose);

  return {
    dispatch,
    /** Reactive per-(action, target) loading flag - see isLoading above. */
    isLoading,
    /** Number of dispatches currently in flight across all subscribers. */
    inFlight: state.inFlight,
    /** True when `inFlight > 0`. Bind to button `disabled` etc. */
    isAnyLoading: state.isAnyLoading,
    /** Most recent error (across all subscribers). */
    lastError: state.lastError,
    /** Ring buffer of recent errors, newest last, capped at `maxSize`. */
    errors: state.errors,
    /** Current size of the `errors` buffer. */
    errorCount: state.errorCount,
    /** Wipe accumulated errors. */
    clear,
    /** Manually unhook. Most callers don't need this - `tryAutoCleanup`
     *  hooks Vue's scope/unmount lifecycle. */
    dispose,
  };
}

// ---------------------------------------------------------------------------
// useCommandState
// ---------------------------------------------------------------------------

export type UseCommandStateOptions = {
  /**
   * When true, multiple synchronous dispatches within the same microtask are
   * accumulated and the signal is written once via `queueMicrotask`. Pairs with
   * Vue 3.6.0-beta.12's v-for source coalescing: our side defers the signal
   * write, Vue's runtime coalesces the resulting DOM update into one pass.
   *
   * Vue 3.6.0-beta.13: v-for consumers of coalesced state benefit from two
   * additional runtime optimizations - specialized v-for block operations
   * (runtime-vapor: specialize v-for block operations) and reduced v-if branch
   * scope overhead (runtime-vapor: reduce v-if branch scope overhead). Signal
   * writes flushed here land into a faster Vapor runtime patch path.
   *
   * Trade-off: 1 microtask of signal latency. Use for arrays consumed by v-for
   * that receive rapid bulk updates (batch dispatch, form field arrays, scroll
   * position lists). Default: false (immediate write per dispatch).
   */
  coalesce?: boolean;
};

/**
 * useCommandState - create reactive state that updates via commands.
 *
 * Auto-cleanup on Vue component unmount or scope disposal.
 *
 * @example
 * // Immediate mode (default):
 * const { state } = useCommandState([], { cartAdd: (s, cmd) => [...s, cmd.target] });
 *
 * @example
 * // Coalesced mode - batch writes for v-for lists:
 * const { state } = useCommandState([], { cartAdd: (s, cmd) => [...s, cmd.target] }, { coalesce: true });
 */
export function useCommandState<T>(
  initial: T,
  handlers: {
    [action: string]: (state: T, cmd: Command) => T;
  },
  options: UseCommandStateOptions = {}
) {
  return _createCommandState(initial, handlers, options, signal);
}

/**
 * @internal - shared core for `useCommandState` (shallow, default) and the
 * opt-in `useDeepCommandState` from `vapor-chamber/reactive` (deep). The only
 * difference between the two is the `createSignal` factory: the core passes the
 * shallow `signal()`; the companion passes a deep `ref()`-backed factory. All
 * dispatch/coalesce/cleanup logic is identical and lives here so the two
 * variants can never drift.
 */
export function _createCommandState<T>(
  initial: T,
  handlers: {
    [action: string]: (state: T, cmd: Command) => T;
  },
  options: UseCommandStateOptions,
  createSignal: <V>(v: V) => Signal<V>,
): { state: Signal<T>; dispose: () => void } {
  const { coalesce = false } = options;
  const bus = getCommandBus<CommandMap>();
  const state = createSignal(initial);
  const unregisters: Array<() => void> = [];

  // coalesce bookkeeping - only allocated when coalesce: true
  let _pending: T = initial;
  let _hasPending = false;
  let _scheduled = false;

  for (const [action, handler] of Object.entries(handlers)) {
    const unregister = bus.register(action, (cmd) => {
      if (coalesce) {
        _pending = handler(_hasPending ? _pending : state.value, cmd);
        _hasPending = true;
        if (!_scheduled) {
          _scheduled = true;
          queueMicrotask(() => {
            state.value = _pending;
            _hasPending = false;
            _scheduled = false;
          });
        }
        return _pending;
      }
      state.value = handler(state.value, cmd);
      return state.value;
    });
    unregisters.push(unregister);
  }

  const dispose = () => {
    disposeAll(unregisters);
  };

  tryAutoCleanup(dispose);

  return { state, dispose };
}

// ---------------------------------------------------------------------------
// useCommandHistory
// ---------------------------------------------------------------------------

/**
 * useCommandHistory - undo/redo with reactive state
 *
 * Auto-cleanup on Vue component unmount or scope disposal.
 * Undo dispatches `<action>$undo`, which runs the inverse registered via register(action, handler, { undo }).
 */
export function useCommandHistory(options: {
  maxSize?: number;
  filter?: (cmd: Command) => boolean;
} = {}) {
  const { maxSize, filter } = options;
  const bus = getCommandBus<CommandMap>();

  const past = signal<Command[]>([]);
  const future = signal<Command[]>([]);
  const canUndo = signal(false);
  const canRedo = signal(false);

  // `paused` brackets TIME (a KeepAlive deactivation), not one dispatch; the
  // rest of the recording rule, and undo/redo, live in ONE place,
  // createLedger (ledger.ts), shared with the history() plugin. What is this
  // composable's own: recording through onAfter, the pause, and mirroring the
  // stacks into signals.
  let paused = false;
  const ledger = createLedger({
    maxSize,
    filter,
    bus,
    skip: () => paused,
    onChange: (futureMoved) => {
      past.value = ledger.past.slice();
      // Only renew the redo stack when it moved - a fresh [] every dispatch
      // is a new identity that re-triggers every future/canRedo watcher.
      if (futureMoved) future.value = ledger.future.slice();
      canUndo.value = ledger.canUndo();
      canRedo.value = ledger.future.length > 0;
    },
  });

  const unsubscribe = pastSeal(bus, () => bus.onAfter((cmd, result) => ledger.record(cmd, result)));

  tryKeepAliveHooks(
    () => { paused = true; },
    () => { paused = false; },
  );

  const undo = (): Command | undefined => ledger.undo();
  const redo = (): Command | undefined => ledger.redo();
  const clear = (): void => ledger.clear();

  function dispose() {
    unsubscribe();
  }

  tryAutoCleanup(dispose);

  return {
    past,
    future,
    canUndo,
    canRedo,
    undo,
    redo,
    clear,
    dispose,
  };
}

// ---------------------------------------------------------------------------
// useCommandQuery
// ---------------------------------------------------------------------------

/**
 * useCommandQuery - CQRS read-side composable with reactive state.
 *
 * Wraps bus.query() with reactive `data`, `loading`, and `lastError` signals.
 * query() skips onBefore hooks (no auth gates, no loading spinners for reads)
 * but runs plugins, handlers, and afterHooks.
 *
 * Supports both sync and async buses - if the result is a Promise, loading
 * stays true until it resolves.
 *
 * @example
 * const { query, data, loading, lastError } = useCommandQuery();
 * const result = query('getUser', { id: 42 });
 * // data.value = result.value after query completes
 */
export function useCommandQuery() {
  const bus = getCommandBus<CommandMap>();
  // The one composable that arms no cleanup and so never reaches
  // tryAutoCleanup - its signals degrade the same way, so it warns the same way.
  warnUnwired();
  const data = signal<any>(null);
  const loading = signal(false);
  const lastError = signal<Error | null>(null);
  const onData = (value: any): void => { data.value = value; };

  function query(action: string, target: any, payload?: any): CommandResult | Promise<CommandResult> {
    return runDispatch(bus, true, action, target, payload, loading, lastError, onData);
  }

  return { query, data, loading, lastError };
}

// ---------------------------------------------------------------------------
// useCommandGroup
// ---------------------------------------------------------------------------

/**
 * useCommandGroup - namespace isolation for large apps and multi-team projects.
 *
 * All dispatch/register/on calls are automatically prefixed with the namespace
 * in camelCase. This prevents action name collisions when composing multiple
 * feature modules.
 *
 * @example
 * // Cart feature
 * const cart = useCommandGroup('cart')
 * cart.register('add', handler)    // registers 'cartAdd'
 * cart.dispatch('add', product)    // dispatches 'cartAdd'
 * cart.on('*', listener)           // listens to 'cart*'
 *
 * // Orders feature - completely isolated
 * const orders = useCommandGroup('orders')
 * orders.dispatch('cancel', { id }) // dispatches 'ordersCancel'
 */
export function useCommandGroup(namespace: string) {
  const bus = getCommandBus<CommandMap>();
  const cleanups: Array<() => void> = [];

  // camelCase namespace join ('cart' + 'add' -> 'cartAdd'), memoised per group.
  //
  // Unlike the transition bridge - where every hook name is fixed at build time
  // and the join was hoisted out of the dispatch path entirely - the short name
  // arrives here as a runtime ARGUMENT, so it cannot be precomputed. It can be
  // cached: a group dispatches a small, stable set of names ('add', 'remove',
  // 'clear'), so the second and every later dispatch of a name is a Map hit
  // instead of two allocations plus a concat.
  //
  // Measured, interleaved A/B, 200k calls: 3 distinct names 4.669ms -> 1.244ms
  // (**-73%**), 8 names 5.171ms -> 1.426ms (-72%). This replaces the old
  // "inlined, DO NOT consolidate, a shared call costs ~1%" note: the 1% was
  // real but it was the wrong thing to optimise - the join itself was the cost,
  // not the call, and removing the repeated work beats avoiding the indirection
  // by ~70x.
  //
  // Capped like `_prefixCache` in command-bus.ts and for the same reason: a
  // long-lived group dispatching generated names would otherwise grow the Map
  // without bound. Same 256-entry FIFO eviction, so a pathological caller
  // degrades to the uncached concat cost rather than leaking.
  const _nameCache = new Map<string, string>();
  function prefixed(action: string): string {
    let v = _nameCache.get(action);
    if (v === undefined) {
      v = namespace + action.charAt(0).toUpperCase() + action.slice(1);
      if (_nameCache.size >= 256) _nameCache.delete(_nameCache.keys().next().value!);
      _nameCache.set(action, v);
    }
    return v;
  }

  function dispatch(action: string, target: any, payload?: any): CommandResult {
    return untracked(() => bus.dispatch(prefixed(action), target, payload));
  }

  /** Read-only dispatch - skips onBefore hooks, runs handler + plugins, fires afterHooks. */
  function query(action: string, target: any, payload?: any): CommandResult {
    return untracked(() => bus.query(prefixed(action), target, payload));
  }

  /** Fire a namespaced domain event - notifies on() listeners, no handler required. */
  function emit(event: string, data?: any): void {
    untracked(() => bus.emit(prefixed(event), data));
  }

  function register(action: string, handler: Handler, opts?: RegisterOptions): () => void {
    const unregister = bus.register(prefixed(action), handler, opts);
    cleanups.push(unregister);
    return unregister;
  }

  function use(plugin: Plugin): () => void {
    const remove = bus.use(plugin);
    cleanups.push(remove);
    return remove;
  }

  function on(pattern: string, listener: Listener): () => void {
    // Translate wildcard to namespaced: '*' -> 'cart*', 'add' -> 'cartAdd'
    const namespacedPattern = pattern === '*' ? `${namespace}*` : prefixed(pattern);
    const unsub = bus.on(namespacedPattern, listener);
    cleanups.push(unsub);
    return unsub;
  }

  function dispose() {
    disposeAll(cleanups);
  }

  tryAutoCleanup(dispose);

  return { dispatch, query, emit, register, use, on, namespace, dispose };
}

// ---------------------------------------------------------------------------
// useCommandError
// ---------------------------------------------------------------------------

/**
 * useCommandError - component-scoped error boundary for command failures.
 *
 * Subscribes to the bus and captures all failed command results reactively.
 * Optional filter narrows which actions are tracked.
 *
 * @example
 * const { latestError, errors, clearErrors } = useCommandError()
 *
 * // Only watch cart commands
 * const { latestError } = useCommandError({ filter: cmd => cmd.action.startsWith('cart') })
 */
export function useCommandError(options: {
  filter?: (cmd: Command) => boolean;
  /** Max errors retained - oldest are dropped first (ring buffer). Default: 50. */
  maxSize?: number;
} = {}) {
  const { filter } = options;
  const maxSize = countOption(options.maxSize, 50); // a NaN is the default (bounds.ts)
  const bus = getCommandBus<CommandMap>();

  type ErrorEntry = { cmd: Command; error: Error; timestamp: number };
  const errors = signal<ErrorEntry[]>([]);
  const latestError = signal<Error | null>(null);
  let paused = false;

  const unsubscribe = pastSeal(bus, () => bus.onAfter((cmd, result) => {
    if (paused) return;
    if (!result.ok && result.error) {
      if (!filter || filter(cmd)) {
        latestError.value = result.error;
        const next = errors.value.slice();
        next.push({ cmd, error: result.error, timestamp: Date.now() });
        while (next.length > maxSize) next.shift();
        errors.value = next;
      }
    }
  }));

  // KeepAlive: pause error capture when deactivated, resume when activated
  tryKeepAliveHooks(
    () => { paused = true; },
    () => { paused = false; },
  );

  function clearErrors() {
    errors.value = [];
    latestError.value = null;
  }

  function dispose() {
    unsubscribe();
  }

  tryAutoCleanup(dispose);

  return { errors, latestError, clearErrors, dispose };
}
