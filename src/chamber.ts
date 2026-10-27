/**
 * vapor-chamber - Vue Vapor integration
 *
 * What `tryAutoCleanup()` relies on from Vue: the PUBLIC `getCurrentScope()` /
 * `onScopeDispose()` pair, and Vue stopping a scope it owns - a component
 * created but never mounted (a sibling's render threw) has its scope stopped
 * on unmount, so a `useCommand().on()` listener does not
 * outlive `app.unmount()` (tests/never-mounted-disposal-fixture.test.ts).
 * `warnUnwired()` is the one production warning, for a Vue app whose
 * composables came from the root with nothing wired. The history is in
 * CHANGELOG.md.
 */

import { DEV } from './dev';
import { _report } from './report';
import { disposeAll, _pastSeal, _isAsyncBus, _mayReject, _errResult, _scoped, type ScopeOptions, type BaseBus, type CommandBus,type Command, type CommandResult, type CommandMap, type TargetOf, type PayloadOf, type ResultOf, type Handler, type PluginParts, type RegisterOptions, type Listener } from './command-bus';
import { configureSignal, signal } from './signal';
import { createLedger, recordOn } from './ledger';
import { countOption } from './bounds';
import { commandState, type CommandState, type CommandStateOptions } from './command-state';
import { getCommandBus, resetCommandBus, resolveBus, setCommandBus, type BusOption, type ResultOn } from './shared-bus';
import { _paceOf, pace, type PaceOption, type PacedOn } from './pace';

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
// Used only by the opt-in vapor-chamber/reactive companion (deepSignal); the
// core never touches it.
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

/**
 * The async probe's specifier, at module scope so the build keeps it a name.
 *
 * Rolldown inlines a single-use local `const` into a literal `import("vue")`,
 * whatever `external`, `inlineConst` or `treeshake` say. A module-scope one
 * survives. A literal is what a bundler resolves: a Vite dev server answered
 * 500 for the package in an app with no `vue`, and webpack failed to build.
 * Guarded by tests/dist-optional-peers.test.ts and
 * tests/root-no-vue-dev-server.test.ts (log 36.F26).
 */
const VUE_PKG = 'vue';

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
    // with `npm run ab` (scripts/ab/workloads/signal-backend.mjs) on
    // 3.6.0-rc.11, 2026-10-13: a 100-append array state 2.95-3.13x faster,
    // scalar writes no counted difference (docs/performance.md). Quote the
    // runtime and machine with the number.
    // Measure this on the dispatch path, not with a raw shallowRef-vs-ref loop:
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
 * import { configureVue } from 'vapor-chamber';
 * configureVue(Vue);
 * Vue.createVaporApp(App).mount('#app');
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
 * probe path everything works while Vue reaches the library at runtime and
 * silently stops working in a production bundle, so warning only on observed
 * failure would warn only where nothing can be logged. Conditions: Vue is here (`_vueDeepRefFn`), the
 * build-time wiring is not (`_vueSubpathLoaded`), and no `vaporChamberWire()`
 * is wiring the build (`__VC_WIRED__`) - for its users the advice below names
 * an import the plugin already covers. One-shot, since both call sites are
 * hot. Folds away entirely in production builds.
 *
 * Where it shows: where DEV is on and Vue arrived at runtime - a Vite dev
 * page with vaporChamberHMR(), whose shim fills the library's slot, a test
 * runner with a DOM, or a page whose import map names `vue`. A Vite dev page
 * without that plugin does not get here: the probe's specifier is a runtime
 * name, so it fails and warnUnwired() speaks instead (log 36.F26, both
 * measured in a real browser, Vite 8.3.5). Not on a server (no
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
    _report('warn', 'vue:unexpected:probe',
      'Vue detected at runtime rather than at build time.\n' +
      'This works here because Vue reached the library at runtime ' +
      '(vaporChamberHMR() in dev, a test runner or an import map). A production bundle ' +
      'has none of these, and there, silently, ' +
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
 * tests/root-only-prod-fixture.test.ts.
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
  // is not defined is a slow lookup, and it cost useCommand() creation 7-9%
  // (perf-1.26 A/B, log s35.44). A wired build cannot be in this state; the
  // flag stays first INSIDE, so the inner block still folds there (see
  // __VC_WIRED_BUILD__) and the empty `if` goes with it.
  if (_vueDeepRefFn === null) {
    if (!(typeof __VC_WIRED_BUILD__ !== 'undefined' && __VC_WIRED_BUILD__) && !_unwiredWarned && (globalThis as any).__VUE__ === true) {
      _unwiredWarned = true;
      // Short on purpose: unlike the DEV text above, this ships in the IIFEs.
      _report('warn', 'vue:missing:wiring',
        'Composables run without reactivity, cleanup or KeepAlive guard. ' +
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
    //    `import('vue')`. Without a bundler that reaches a build with no Vapor
    //    (vue.esm-browser.js, or vue.cjs.js in Node), where Vapor ships as a
    //    separate file (vue.runtime-with-vapor.esm-*.js). A bundler's `vue`
    //    entry (vue.runtime.esm-bundler.js) re-exports @vue/runtime-vapor.
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
    //    Resolved by the time user code's first await/tick completes. Only Node
    //    and an import map resolve it: no bundler sees the name (VUE_PKG).
    //    webpack folds a module-scope `const` too, so it is told to leave it.
    _probePromise = import(/* webpackIgnore: true */ /* @vite-ignore */ VUE_PKG)
      .then((vue: any) => {
        // Only into an empty registry, or from the Vue already wired: one Vue
        // is one `ref`. A Vite server build that inlines Vue finds Node's own
        // copy here, and it replaced what /vue had wired at build time
        // (tests/lookup-same-vue.test.ts).
        if (_vueDeepRefFn === null || vue.ref === _vueDeepRefFn) applyVueModule(vue);
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
     * `tests/dist-optional-peers.test.ts`.
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
      // /vue already wired the pair its bundler resolved. In a bundle run in
      // Node, the import below finds Node's own copy, a second reactivity
      // instance, and replacing the pair with it broke untracked()
      // (tests/untracked-build-time-wins.test.ts).
      if (_vueSubpathLoaded) return;
      try {
        // Assembled, not written. A plain local `const pkg = '@vue/reactivity'` is
        // folded straight back into a literal `import()` of that specifier by the
        // build (see VUE_PKG). That literal is the leak `tests/dist-optional-peers.test.ts`
        // guards: statically resolvable from the package root, so every consumer
        // without the optional peer breaks at dep-optimize. `@vite-ignore` does not
        // prevent it - the pre-bundled dep is re-analysed.
        const pkg = ['@vue', 'reactivity'].join('/');
        const r: any = await import(/* @vite-ignore */ pkg);
        // The registry's Vue only: `vue` re-exports this package's own `ref`.
        if (r.ref === _vueDeepRefFn && typeof r.pauseTracking === 'function' && typeof r.resetTracking === 'function') {
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

// Composables below use signal(). They do not start the lookup: the call above
// did, when this module loaded (tests/lookup-starts-at-load.test.ts).

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
export type { BusOption, ResultOn };

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
    _report('warn', 'vue:missing:scope',
      'A composable ran outside a Vue ' +
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
 * `onDeactivated()` registered at that same point works and fires. So a
 * `getCurrentInstance()` guard silently disables KeepAlive pause/resume for
 * every VAPOR component - the platform this library is named for - while
 * working in VDOM. `hasInjectionContext()` (Vue 3.3+) is
 * the one probe that is true in both modes and false in a bare `effectScope()`,
 * measured alongside. `getCurrentInstance()` remains the fallback for a
 * partially-supplied Vue namespace that predates it.
 * Pinned by `tests/keepalive-input-scope-fixture.test.ts`.
 *
 * The null is PERMANENT, not a gap awaiting a fix: on the Vapor roadmap
 * (vuejs/core#13687, Jul 20) a Vue core maintainer confirmed it is
 * INTENTIONAL, with an internal `useInstanceOption` API kept deliberately
 * non-public, and reaffirmed in August that Vapor exposes no general-purpose
 * component instance tree to userland by design. So do not "restore"
 * an instance-accessor probe here on the theory that it will start working.
 *
 * @internal - used by composables that manage bus subscriptions.
 */
export function tryKeepAliveHooks(onPause: () => void, onResume: () => void): void {
  const inSetup = _vueHasInjectionContext
    ? _vueHasInjectionContext()
    : !!_vueGetCurrentInstance?.();
  if (!inSetup) return;
  _vueOnDeactivated?.(onPause);
  _vueOnActivated?.(onResume);
}

// ---------------------------------------------------------------------------
// runCommand and runDispatch - the composables' dispatch brackets. runCommand
// is `useCommand`'s, runDispatch `useCommandQuery`'s (its `loading` and
// `data`). Each takes the bus and the call's arguments, not a thunk, and
// calls `bus.dispatch` / `bus.query` directly. Against the thunk shape (one
// closure per call through `untracked`) this took 0.915-0.934x the time on
// `useCommand().dispatch`, 2.7-3.9 ns less (`npm run ab`, two call lengths,
// controls within 1%; log s35.53). With both callers interleaved the
// workload's own control spread up to 1.36x across processes, so no figure is
// claimed for that shape. A function passed in and called with
// `.call` gained nothing; why is not settled (V8 can inline through a
// parameter when the site's call feedback is monomorphic, and that was not
// checked with --trace-turbo-inlining).
//
// NOT used by chamber-vapor.ts: `useVaporAsyncCommand` hand-rolls its own
// wrapper and says why at its own site (~1.2x leaner than this .then-chain,
// measured, on a path whose entire point is to allocate nothing).
//
// Overlapping queries through one composable: `loading` is true while ANY
// is in flight, written on 0 <-> 1 of `n` (the first to settle cleared it while
// another still ran), and `onSuccess` (`data`) takes only the LATEST query's
// answer, by `seq` (an older one landing last overwrote it).
// tests/composable-overlap.test.ts.
//
// The counts are one record per composable, both fields set at creation
// (docs/V8-RULES.md 1-2), made at its FIRST dispatch, not when it is created.
// Measured for v1.30.0 (`npm run ab`, base 1.29 vs these builds, K 10, n and 4n):
// - the record made with the composable: useCommand creation +5.7 ns, a
//   component's mix +13.6 ns, counted slower;
// - made lazily from `let counts = null`: creation still +2.8 / +3.3 ns at both
//   lengths, counted slower. The initializer is 6 bytes of useCommand's
//   bytecode (184 -> 190), the only change on that path;
// - from `var counts;` with no initializer: a context slot starts undefined,
//   so useCommand's bytecode is the 184 bytes it was, and creation reads no
//   difference (+0.6 / +0.7%, CI includes 1). Dispatch reads -4.5 / -6.2 ns.
// So the slot is a `var` on purpose: an initializer here is measured cost.
// A WeakMap keyed by `loading` instead kept creation at base but cost every
// dispatch +4.7 / +5.9 ns. useCommand's command-state slot is a `var` for the
// same reason.
// ---------------------------------------------------------------------------

/** A failure that escaped a bracket, as a result of the bus's own kind: a promise on an async bus. */
function escaped(bus: CommandBus, error: Error): CommandResult | Promise<CommandResult> {
  const failed = _errResult(error);
  return _isAsyncBus(bus) ? Promise.resolve(failed) : failed;
}

/**
 * @internal useCommand's dispatch: untracked, and a throw is a failed result. `options` is a paced run's cancel signal (`pace`).
 * `rejects` is `_mayReject(bus)`, read once by the composable: a bus that cannot reject gets no `.then`.
 */
export function runCommand(bus: CommandBus, rejects: boolean, action: string, target: unknown, payload: unknown, options?: { signal?: AbortSignal }): CommandResult | Promise<CommandResult> {
  let result: any;
  try {
    // A dispatch is an action, not a read. Without this, every reactive value
    // the HANDLER touches becomes a dependency of whatever effect called the
    // composable, so the component re-runs on state it never mentions. Vue
    // fixed the same class twice in 3.6.0-rc.3 (#15203/#15204) the same way.
    // Pass-through when Vue is absent.
    if (typeof __VC_IIFE__ !== 'undefined' && __VC_IIFE__) {
      result = bus.dispatch(action, target, payload, options);
    } else {
      warnProbePath();
      _pause();
      try {
        result = bus.dispatch(action, target, payload, options);
      } finally {
        _reset();
      }
    }
  } catch (e) {
    // The one throw left by contract, `onMissing: 'throw'`. Its caller is
    // typed for the bus's kind (ResultOn), so it settles as a failed result,
    // a promise on an async bus (tests/composables-result-types.test.ts).
    return escaped(bus, e as Error);
  }
  // On an async bus that can reject the same throw is a rejection: settled as a
  // failed result by one module-level function, no closure per call
  // (tests/usecommand-pending.test.ts). A bus that cannot reject resolves as is.
  return rejects && result && typeof result.then === 'function' ? (result as Promise<CommandResult>).then(undefined, rejected) : result;
}

/** A rejected dispatch as a failed result. */
const rejected = (e: Error): CommandResult => _errResult(e);

/** @internal A composable's in-flight count and its latest dispatch. */
export type DispatchCounts = { n: number; seq: number };

/** @internal useCommandQuery's query: `loading` while any is in flight, `onSuccess` for the latest. */
export function runDispatch(
  bus: CommandBus,
  query: boolean,
  action: string,
  target: unknown,
  payload: unknown,
  loading: Signal<boolean>,
  st: DispatchCounts,
  onSuccess?: (value: any) => void,
): CommandResult | Promise<CommandResult> {
  let result: any;
  const mine = ++st.seq;
  try {
    // The opening write is INSIDE the try. A synchronous subscriber can
    // throw out of a signal write; outside the try that left `loading` true
    // with the error escaping `dispatch`. Here it is a failed result like any
    // other, and the handler does not run
    // (tests/rundispatch-throwing-subscriber.test.ts).
    if (st.n++ === 0) loading.value = true;
    // Untracked, as runCommand's (see there).
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
    if (--st.n === 0) loading.value = false;
    // An async bus never throws here, a subscriber does. Its caller is typed
    // for a promise (ResultOn), so the failure settles as one
    // (tests/composables-result-types.test.ts).
    return escaped(bus, e as Error);
  }
  if (result && typeof result.then === 'function') {
    return (result as Promise<CommandResult>).then(
      (r) => {
        if (--st.n === 0) loading.value = false;
        if (r.ok && mine === st.seq) onSuccess?.(r.value);
        return r;
      },
      (e: Error) => { if (--st.n === 0) loading.value = false; return _errResult(e); },
    );
  }
  if (--st.n === 0) loading.value = false;
  if (result.ok && mine === st.seq) onSuccess?.(result.value);
  return result;
}

// ---------------------------------------------------------------------------
// useCommand
// ---------------------------------------------------------------------------

/**
 * useCommand - command dispatch with bus subscriptions, cleaned up with the scope.
 *
 * `{ debounce: ms }` or `{ throttle: ms }` paces its `dispatch` at the sender
 * (`pace`): a paced dispatch returns a promise, and search as you type passes
 * the typed text as the payload so the keystrokes share one key.
 *
 * Returns `dispatch`, `pending(action, target?)` (the bus's command state for
 * that key, `commandState`), plus `register` / `on` / `emit` for handlers and
 * listeners, all released on scope disposal (`onScopeDispose`). Vapor-safe -
 * works in `<script setup vapor>` and VDOM alike, with no
 * `getCurrentInstance()` dependency. A dispatch's own failure is its result.
 * The bus's recent failures are `useSharedCommandState().errors`.
 *
 * @example
 * const { dispatch, register, pending } = useCommand();
 * register('cartAdd', (cmd) => addToCart(cmd.target));
 * const adding = pending('cartAdd', { id: product.id });
 * dispatch('cartAdd', { id: product.id });
 */
export function useCommand<B extends BaseBus = CommandBus, D extends number | undefined = undefined, T extends number | undefined = undefined>(options?: BusOption<B> & PaceOption<D, T>) {
  // Untyped internally; the public dispatch/register signatures below carry
  // the SharedCommandMap typing (GlobalCommands augmentation).
  const bus = resolveBus(options?.bus);
  const rejects = _mayReject(bus);
  // A `var` with no initializer: see runDispatch (no bytecode on creation).
  // Held from the first pending() call, released with the composable.
  var state: CommandState | undefined;
  const listeners: Array<() => void> = [];
  const registered: Array<{ action: string; handler: Handler; opts?: RegisterOptions; off: (() => void) | null }> = [];

  function direct<A extends keyof SharedCommandMap & string>(
    action: A,
    target: TargetOf<SharedCommandMap, A>,
    payload?: PayloadOf<SharedCommandMap, A>,
  ): PacedOn<B, CommandResult<ResultOf<SharedCommandMap, A>>, D, T> {
    return runCommand(bus, rejects, action, target, payload) as PacedOn<B, CommandResult<ResultOf<SharedCommandMap, A>>, D, T>;
  }

  // Paced at the sender when an option says so, decided here: without one the
  // dispatch is `direct`, with no wrapper and no read per call.
  let dispatch = direct;
  const pacing = _paceOf(options);
  if (pacing !== undefined) {
    const paced = pace((action, target, payload, options) => runCommand(bus, rejects, action, target, payload, options), pacing);
    listeners.push(paced.dispose);
    dispatch = paced as unknown as typeof direct;
  }

  /** In flight for this key, bus-wide (`commandState`'s `pending`). */
  function pending<A extends keyof SharedCommandMap & string>(action: A, target?: TargetOf<SharedCommandMap, A>): Readonly<Signal<boolean>> {
    if (state === undefined) {
      state = commandState(bus);
      listeners.push(state.dispose);
    }
    return state.pending(action, target);
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
  // answers. useCommandHistory and useCommandError pause on KeepAlive the same
  // way.
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

  return { dispatch, pending, register, on, emit, dispose };
}

// ---------------------------------------------------------------------------
// useSharedCommandState
// ---------------------------------------------------------------------------

export type UseSharedCommandStateOptions<B extends BaseBus = BaseBus> = BusOption<B> & CommandStateOptions;

/**
 * useSharedCommandState - the bus's command state (`commandState`) as a Vue
 * view: the same handle, released when the component's scope ends.
 *
 * Every caller on one bus reads the same signals, so 50 components cost one
 * state, not 100 signals. `pending(action, target?)` is in flight for that
 * key, `anyPending` for any command, bus-wide: a dispatch from anywhere counts.
 *
 * @example
 * const { pending, anyPending, lastError } = useSharedCommandState();
 * const saving = pending('cartAdd', { id: product.id });
 * <Button :disabled="anyPending">Save</Button>
 */
export function useSharedCommandState<B extends BaseBus = CommandBus>(options: UseSharedCommandStateOptions<B> = {}): CommandState {
  const state = commandState(resolveBus(options.bus), options);
  tryAutoCleanup(state.dispose);
  return state;
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
export function useCommandHistory(options: ScopeOptions & {
  maxSize?: number;
} & BusOption = {}) {
  const { maxSize } = options;
  const bus = resolveBus(options.bus);

  const past = signal<readonly Command[]>([]);
  const future = signal<readonly Command[]>([]);
  const canUndo = signal(false);
  const canRedo = signal(false);

  // `paused` brackets TIME (a KeepAlive deactivation), not one dispatch; the
  // rest of the recording rule, the recorder and undo/redo live in ONE place,
  // ledger.ts, shared with history(). What is this composable's own: the
  // pause and mirroring the stacks into signals.
  let paused = false;
  const ledger = createLedger({
    maxSize,
    actions: options.actions,
    actionFilter: options.actionFilter,
    bus,
    skip: () => paused,
    onChange: (futureMoved) => {
      past.value = ledger.past;
      // The ledger's own arrays, read-only: each change writes new ones, so
      // no copy. The redo stack is set only when it moved.
      if (futureMoved) future.value = ledger.future;
      canUndo.value = ledger.canUndo();
      canRedo.value = ledger.future.length > 0;
    },
  });

  const unsubscribe = recordOn(bus, ledger);

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
 * Wraps bus.query() with reactive `data` and `loading` signals. A query's own
 * failure is its result. The bus's recent failures are
 * `useSharedCommandState().errors`.
 * query() runs the rules, the steps, the handler and the afterHooks; its
 * start is not counted as pending.
 *
 * Supports both sync and async buses - if the result is a Promise, loading
 * stays true until it resolves.
 *
 * @example
 * const { query, data, loading } = useCommandQuery();
 * const result = query('getUser', { id: 42 });
 * // data.value = result.value after query completes
 */
export function useCommandQuery<B extends BaseBus = CommandBus>(options?: BusOption<B>) {
  const bus = resolveBus(options?.bus);
  // The one composable that arms no cleanup and so never reaches
  // tryAutoCleanup - its signals degrade the same way, so it warns the same way.
  warnUnwired();
  const data = signal<any>(null);
  const loading = signal(false);
  // A `var` with no initializer: see runDispatch (no bytecode on creation).
  var counts: DispatchCounts | undefined;
  const onData = (value: any): void => { data.value = value; };

  function query(action: string, target: any, payload?: any): ResultOn<B> {
    return runDispatch(bus, true, action, target, payload, loading, (counts ??= { n: 0, seq: 0 }), onData) as ResultOn<B>;
  }

  return { query, data, loading };
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
export function useCommandGroup<B extends BaseBus = CommandBus>(namespace: string, options?: BusOption<B>) {
  const bus = resolveBus(options?.bus);
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
  // Measured for v1.15.0, interleaved A/B, 200k calls: 3 distinct names 4.669ms -> 1.244ms
  // (**-73%**), 8 names 5.171ms -> 1.426ms (-72%). The join itself was the
  // cost, not the call: removing the repeated work beats avoiding the
  // indirection by ~70x.
  //
  // Capped like `_prefixCache` in pattern.ts and for the same reason: a
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

  function dispatch(action: string, target: any, payload?: any): ResultOn<B> {
    return untracked(() => bus.dispatch(prefixed(action), target, payload)) as ResultOn<B>;
  }

  /** Read-only dispatch - runs the rules, the steps and the handler, fires afterHooks. */
  function query(action: string, target: any, payload?: any): ResultOn<B> {
    return untracked(() => bus.query(prefixed(action), target, payload)) as ResultOn<B>;
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

  function use(plugin: PluginParts): () => void {
    const remove = bus.use(plugin);
    cleanups.push(remove);
    return remove;
  }

  function on(pattern: string, listener: Listener): () => void {
    // Translate wildcard to namespaced: '*' -> 'cart*', 'add' -> 'cartAdd'
    // `prefixed` keeps a trailing `*`, so `'*'` becomes the namespace's prefix pattern.
    const namespacedPattern = prefixed(pattern);
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
 * Optional `actions` and `actionFilter` narrow which actions are tracked.
 *
 * @example
 * const { latestError, errors, clearErrors } = useCommandError()
 *
 * // Only watch cart commands
 * const { latestError } = useCommandError({ actions: ['cart*'] })
 */
export function useCommandError(options: ScopeOptions & {
  /** Max errors retained - oldest are dropped first (ring buffer). Default: 50. */
  maxSize?: number;
} & BusOption = {}) {
  const inside = _scoped(options); // asked once per action; null while there is no scope
  const maxSize = countOption(options.maxSize, 50); // a NaN is the default (bounds.ts)
  const bus = resolveBus(options.bus);

  type ErrorEntry = { cmd: Command; error: Error; timestamp: number };
  const errors = signal<ErrorEntry[]>([]);
  const latestError = signal<Error | null>(null);
  let paused = false;

  const unsubscribe = _pastSeal(bus, () => bus.onAfter((cmd, result) => {
    if (paused) return;
    if (!result.ok && result.error) {
      if (inside === null || inside(cmd.action)) {
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
