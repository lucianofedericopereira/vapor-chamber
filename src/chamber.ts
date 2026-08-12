/**
 * vapor-chamber - Vue Vapor integration
 *
 * v1.10.0 — Vue 3.6.0-rc.2 alignment: #15141 fixed a bug where
 *           `setCurrentInstance`'s restore step re-triggered the default
 *           active-scope instead of truly restoring "no scope" — on a first
 *           client-side vdom→vapor navigation through `<Suspense>`, the vapor
 *           page mounted and was immediately torn down, killing every
 *           watcher created during its setup(). `tryAutoCleanup()` below only
 *           calls the PUBLIC `getCurrentScope()`/`onScopeDispose()` pair, not
 *           the internal restore path itself, so this was never a bug IN this
 *           function — but any composable here called from a vapor page's
 *           setup() reached via that exact navigation was swept up in the
 *           same teardown as the rest of that page's reactive state, with no
 *           userland workaround possible. Now fixed upstream; no code change
 *           needed here, but Nuxt-style vdom-shell/vapor-page apps using
 *           useCommand()/useCommandState() etc. inherit the fix for free.
 * v1.3.0 — Vue 3.6.0-beta.12 alignment: error recovery (component context,
 *           fallthrough props, render effects restored after setup errors);
 *           VDOM slots interop normalization; no code changes needed here.
 * v1.1.0 — Vue 3.6.0-beta.10 alignment: defineVaporCustomElement, defineVaporComponent,
 *           defineVaporAsyncComponent detection; improved hydration interop.
 * v0.4.1 — Added: useCommandGroup (namespace isolation), useCommandError (error boundary).
 * v0.4.0 — Vue 3.6 Vapor alignment: onScopeDispose, Vapor detection,
 *           defineVaporCommand, createVaporChamberApp.
 * v0.3.0 — Fixed: signal shim, resetCommandBus, auto-cleanup on Vue unmount.
 */

import { DEV } from './dev';
import { createCommandBus, disposeAll, type CommandBus, type AsyncCommandBus, type Command, type CommandResult, type CommandMap, type TargetOf, type PayloadOf, type ResultOf, type Handler, type Plugin, type RegisterOptions, type Listener } from './command-bus';
import { configureSignal, signal } from './signal';

/**
 * Build-time flag injected by `scripts/build.mjs` via Vite `define`: `true` in
 * the three IIFE (<script>-tag) bundles, `false` in the ESM build.
 *
 * Declared inline rather than in a `.d.ts` so it travels with this module —
 * `examples/tsconfig.patterns.json` reaches this file through imports and
 * would not pick up an ambient declaration from `src/`.
 *
 * Every call site guards with `typeof __VC_IIFE__ !== 'undefined'`, so the
 * symbol is safe where no define exists (vitest, plain `tsc`, importing `src/`
 * directly). Vite substitutes inside `typeof` too, so the IIFE build still
 * const-folds and drops the dead branch.
 */
declare const __VC_IIFE__: boolean | undefined;

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
// Vue 3.6+ Vapor APIs (introduced across 3.6.0-alpha.3–5)
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

function applyVueModule(vue: any): void {
  if (vue && (typeof vue.shallowRef === 'function' || typeof vue.ref === 'function')) {
    // Push Vue's shallowRef() into the signal module so signal() returns a real
    // alien-signals-backed reactive WITHOUT the deep-Proxy wrap that ref()
    // applies to object/array values via toReactive(). The library only ever
    // REPLACES a signal's value wholesale (state.value = handler(...),
    // errors.value = [...], past.value = [...]) — it never mutates nested fields
    // in place — so shallow tracking is semantically equivalent here while
    // avoiding the per-write proxy cost. Measured on the real dispatch path:
    // array-state useCommandState ~3.4x faster, scalar signals ~1.2x. Direct
    // nested mutation of a returned state (state.value.x = y) would bypass the
    // command bus anyway, which this library treats as an anti-pattern.
    // Falls back to ref() if shallowRef is somehow unavailable (Vue < 3.0).
    configureSignal(vue.shallowRef ?? vue.ref);
  }
  // Keep a handle to the DEEP ref() for the opt-in reactive companion.
  if (vue && typeof vue.ref === 'function') {
    _vueDeepRefFn = vue.ref;
  }

  if (vue && typeof vue.onScopeDispose === 'function') {
    _vueOnScopeDispose = vue.onScopeDispose;
  }
  // getCurrentScope() (Vue 3.2+) — returns the active effect scope or undefined.
  // Used as the guard before calling onScopeDispose, replacing the try/catch pattern.
  if (vue && typeof vue.getCurrentScope === 'function') {
    _vueGetCurrentScope = vue.getCurrentScope;
  }
  if (vue && typeof vue.getCurrentInstance === 'function') {
    _vueGetCurrentInstance = vue.getCurrentInstance;
  }

  // KeepAlive lifecycle hooks (Vue 3.x)
  if (vue && typeof vue.onActivated === 'function') {
    _vueOnActivated = vue.onActivated;
  }
  if (vue && typeof vue.onDeactivated === 'function') {
    _vueOnDeactivated = vue.onDeactivated;
  }

  // Vue 3.6+ Vapor detection
  if (vue && typeof vue.createVaporApp === 'function') {
    _hasVapor = true;
    _createVaporAppFn = vue.createVaporApp;
  }
  if (vue && typeof vue.vaporInteropPlugin !== 'undefined') {
    _vaporInteropPluginRef = vue.vaporInteropPlugin;
  }

  // Vue 3.6+: Vapor custom elements and component definitions
  if (vue && typeof vue.defineVaporCustomElement === 'function') {
    _defineVaporCustomElementFn = vue.defineVaporCustomElement;
  }
  if (vue && typeof vue.defineVaporComponent === 'function') {
    _defineVaporComponentFn = vue.defineVaporComponent;
  }
  if (vue && typeof vue.defineVaporAsyncComponent === 'function') {
    _defineVaporAsyncComponentFn = vue.defineVaporAsyncComponent;
  }
}

/**
 * The global slot this library owns for a hand-supplied Vue namespace.
 *
 * Distinct from `__VUE__` on purpose. `__VUE__` belongs to Vue, which assigns
 * the BOOLEAN `true` to it from `prepareApp()` (Vapor) and
 * `baseCreateRenderer()` (vDOM) — i.e. the moment the first app is created.
 * A namespace parked on `__VUE__` therefore survives only until something
 * mounts, after which the sync channel yields a truthy value that cannot be
 * used for anything. Pinned by `tests/vue-detection-global-clobber.test.ts`.
 *
 * This key has exactly one writer.
 */
const VUE_GLOBAL_KEY = '__VAPOR_CHAMBER_VUE__';

/** Reads a usable Vue namespace out of a global slot, or null. */
function readGlobal(key: string): any | null {
  if (typeof globalThis === 'undefined') return null;
  try {
    const vue = (globalThis as any)[key];
    // `__VUE__` is `true` on any page that has mounted — the `.ref` check is
    // what separates a namespace from Vue's devtools marker.
    return vue && typeof vue.ref === 'function' ? vue : null;
  } catch {
    return null;
  }
}

/**
 * configureVue — hand the library Vue's module namespace explicitly.
 *
 * The reliable channel — recommended for every consumer who wants
 * deterministic Vapor wiring, bundler or not. It seeds the registry
 * synchronously (no probe race, wrappers' null path becomes unreachable) and
 * is the one channel that behaves identically however the page obtains Vapor:
 * bundler alias, import map, or the `esm-browser` dist. Essential on
 * no-bundler pages, where it is the only channel that cannot come up empty:
 * Detection otherwise depends on either a global slot Vue overwrites when the
 * first app mounts (see {@link VUE_GLOBAL_KEY}) or a bare-specifier
 * `import('vue')` that cannot resolve in a browser at all — so on a
 * `<script>`-tag page the two automatic channels can both come up empty while
 * Vapor is sitting right there, and `createVaporChamberApp()` throws
 * "Vue 3.6+ with Vapor mode required" on a page that has it.
 *
 * Call this before creating signals or apps. Safe to call more than once; the
 * last usable namespace wins. Mirrors `configureSignal()` — an explicit
 * escape hatch that removes a guess.
 *
 * IMPORTANT: pass the SAME Vue instance the rest of the page uses. Two
 * separately-imported Vue dist files are two disconnected reactivity engines
 * (a `ref()` from one is invisible to a `watchEffect` from the other, with no
 * error) — see the note in `probeVue` below.
 *
 * @example
 * import * as Vue from 'vue/dist/vue.runtime-with-vapor.esm-browser.js';
 * import { configureVue, createVaporChamberApp } from 'vapor-chamber';
 * configureVue(Vue);
 * createVaporChamberApp(App).mount('#app');
 */
export function configureVue(vue: object): void {
  if (!vue) return;
  applyVueModule(vue);
}

/**
 * Reactive dependency collection, suspended for the duration of a callback.
 *
 * Null until Vue detection completes; a plain pass-through when Vue is absent.
 */
let _untrack: (<T>(fn: () => T) => T) | null = null;

/**
 * True once `vapor-chamber/vue` has been imported, i.e. the tracking primitives
 * arrived at BUILD time and this bundle is correct in production.
 *
 * The diagnostic below keys off this rather than off "the probe failed", and
 * the difference matters. Probe failure is only observable in a production
 * bundle, where `DEV` is false and nothing can be logged — so a warning keyed
 * to it fires essentially nowhere, which is what the first version of this
 * diagnostic did. Keying it to "you are on the probe path" instead fires under
 * the dev server, while the app still looks fine and there is time to change
 * one import.
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
 * specifier — never a production bundle. Only the former means "this app is
 * correct once built".
 */
export function _wireUntrack(pause: () => void, reset: () => void, viaSubpath = false): void {
  if (viaSubpath) _vueSubpathLoaded = true;
  _untrack = <T>(fn: () => T): T => {
    pause();
    try { return fn(); } finally { reset(); }
  };
}

/**
 * untracked — run `fn` without its reactive reads becoming dependencies of
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
 * suspending tracking around callbacks — this is that idea at the bus edge.
 */
export function untracked<T>(fn: () => T): T {
  // In an IIFE the wiring below never runs (no bundler can resolve
  // `@vue/reactivity` from a <script> tag), so `_untrack` is provably null.
  // Folding that here lets the minifier reduce this to `fn()` and drop the
  // slot entirely rather than shipping a branch that can only go one way.
  if (typeof __VC_IIFE__ !== 'undefined' && __VC_IIFE__) return fn();

  // Deliberately BEFORE the wired-path return: the point is to fire while the
  // probe is still succeeding. On the probe path this call works under the dev
  // server and silently stops working once the app is built, so warning only on
  // observed failure would warn only where nothing can be logged. Conditions:
  // Vue is here (`_vueDeepRefFn`), and the build-time wiring is not
  // (`_vueSubpathLoaded`). One-shot — untracked() is on the dispatch path, and
  // every composable routes through it, so per-call would be a flood. Folds
  // away entirely in production builds.
  if (DEV && _vueDeepRefFn !== null && !_vueSubpathLoaded && !_untrackWarned) {
    _untrackWarned = true;
    console.warn(
      '[vapor-chamber] Vue detected at runtime rather than at build time.\n' +
      'untracked() works right now because the dev server can resolve a bare ' +
      '`import()`. A production bundle cannot, so it will silently degrade to a ' +
      "pass-through and dispatches made inside a reactive effect will leak the " +
      "handler's reads into that effect — components re-rendering on state they " +
      'never mention, with no error.\n' +
      "Fix: import the composables from 'vapor-chamber/vue' instead of " +
      "'vapor-chamber'. Same functions, resolved by your bundler. Nothing to call.",
    );
  }

  return _untrack === null ? fn() : _untrack(fn);
}

/**
 * Wire {@link untracked} from `@vue/reactivity`, best-effort.
 *
 * That package and not `vue`: the primitives are simply not on the `vue` entry
 * — verified against 3.6.0-rc.3, where `pauseTracking`, `resetTracking` and
 * `setActiveSub` are absent from both `vue.runtime.esm-bundler.js` and
 * `vue.runtime-with-vapor.esm-browser.js`, while `@vue/reactivity` exports all
 * three and resolves to the *same module instance* Vue itself uses (a second
 * copy would toggle unrelated state and silently do nothing — checked).
 *
 * SCOPE, measured: this works under a dev server and in vitest, and fails in
 * every production bundle — the specifier is bare, and a built bundle has no
 * import map to resolve it against. It is kept because it is the zero-config
 * path where it does work; production correctness comes from
 * `enableVueReactivity()` in the `vapor-chamber/vue` subpath, which resolves
 * the same primitives at BUILD time. `untracked()` warns once in DEV when this
 * probe has failed, rather than degrading in silence.
 *
 * The specifier is held in a variable so no bundler can fold it into a literal
 * a literal `import()` of that specifier: that would make the optional peer statically
 * resolvable from the package root and break consumers who lack it. Guarded by
 * `tests/dist-optional-peers.test.ts`, which is also why `src/vue.ts` is built
 * as its own pass in `scripts/build.mjs` — marking the peer external in the
 * main build is exactly what lets the fold happen.
 */
async function wireUntracked(): Promise<void> {
  // An IIFE is loaded by a <script> tag, where a bare `import()` can never
  // resolve. `__VC_IIFE__` const-folds, so this whole function and its
  // specifier string are dropped from those bundles.
  if (typeof __VC_IIFE__ !== 'undefined' && __VC_IIFE__) return;
  if (_vueDeepRefFn === null) return; // no Vue — nothing to suspend
  try {
    // Assembled, not written. A plain `const pkg = '@vue/reactivity'` is folded
    // straight back into a literal `import()` of that specifier by Rollup now that the
    // package is a declared (optional) peer — Vite's lib mode auto-externalises
    // peers, and an external specifier is exactly what constant propagation is
    // free to inline. That literal is the leak `tests/dist-optional-peers.test.ts`
    // guards: statically resolvable from the package root, so every consumer
    // without the optional peer breaks at dep-optimize. `@vite-ignore` does not
    // prevent it — the pre-bundled dep is re-analysed.
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

function probeVue(): void {
  if (_vueProbed) return;
  _vueProbed = true;

  // 1. Synchronous probe. This is the only channel that can ever detect Vapor
  //    without a bundler (no-build IIFE / sprinkled-JS pages,
  //    docs/whitepaper.md §11.6): the async probe below resolves a bare
  //    `import('vue')`, which Vue 3.6 NEVER wires to the Vapor-enabled build
  //    outside a bundler's alias magic (@vitejs/plugin-vue does this per-app
  //    when it sees `<script setup vapor>`) — Vapor is a physically separate
  //    dist file (vue.runtime-with-vapor.esm-*.js).
  //
  //    Two slots are read, ours first. `__VUE__` is kept for compatibility
  //    with pages and docs that already use it, but it is Vue's key: Vue
  //    assigns `true` to it on first app creation, so a namespace left there
  //    is gone the moment anything mounts. Whichever slot still holds a real
  //    namespace wins; `configureVue()` bypasses both.
  //
  //    Do NOT try to "fix" a miss here with a second dynamic import of the
  //    with-vapor build as a fallback — verified directly that two
  //    separately-imported Vue dist files are two disconnected
  //    reactivity-engine instances (a ref() from one is invisible to a
  //    watchEffect from the other, silently, no error), so an automatic
  //    fallback would risk introducing exactly that bug rather than fixing
  //    anything.
  const fromGlobal = readGlobal(VUE_GLOBAL_KEY) ?? readGlobal('__VUE__');
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
      // Vue not available — use plain signals, no auto-cleanup
    })
    .then(wireUntracked);
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
  if (_probePromise) await _probePromise;
}

// Kick off the async probe on first signal() call from this module's
// consumers, so SPA tree code paths get full Vue auto-detection. Composables
// below use signal() and call probeVue() explicitly via tryAutoCleanup.

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
 * @internal — one sentence explaining WHY detection came up empty, appended to
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
  // no-bundler `<script>`-tag page (whitepaper §11.6), which only ever runs a
  // production IIFE — stripping the diagnosis in prod would remove it exactly
  // where it is needed. Kept as small as the three-way distinction allows:
  // one shared tail, three short causes, no helper function.
  const cause =
    // Vue found, no Vapor: a genuine capability gap — the plain `vue` entry
    // ships no Vapor runtime, which is a separate build.
    _vueDeepRefFn !== null
      ? 'Vue lacks the Vapor build (vue/dist/vue.runtime-with-vapor.esm-*)'
      // The order-dependent case pinned by tests/vue-detection-global-clobber:
      // `__VUE__` is `true` because an app mounted, so the sync channel is
      // dead, and a browser cannot resolve the bare-specifier async import.
      : typeof globalThis !== 'undefined' && (globalThis as any).__VUE__
        ? 'Vue is on the page but unreachable (__VUE__ is Vue\'s own boolean)'
        : 'No Vue detected';
  return `${cause}. Pass it: configureVue(Vue).`;
}

/** @internal — for chamber-vapor.ts use only */
export function getVaporAppFn(): any { return _createVaporAppFn; }
/** @internal — for chamber-vapor.ts use only */
export function getVaporInteropRef(): any { return _vaporInteropPluginRef; }
/** @internal — for chamber-vapor.ts use only */
export function getDefineVaporCustomElementFn(): any { return _defineVaporCustomElementFn; }
/** @internal — for chamber-vapor.ts use only */
export function getDefineVaporComponentFn(): any { return _defineVaporComponentFn; }
/** @internal — for chamber-vapor.ts use only */
export function getDefineVaporAsyncComponentFn(): any { return _defineVaporAsyncComponentFn; }
/** @internal — Vue's DEEP ref(), for the vapor-chamber/reactive companion only.
 *  Returns null until Vue detection completes (or if Vue is absent). */
export function getVueDeepRefFn(): (<T>(v: T) => { value: T }) | null { return _vueDeepRefFn; }

// ---------------------------------------------------------------------------
// Shared command bus instance
// ---------------------------------------------------------------------------

/**
 * GlobalCommands — module-augmentation hook that types the SHARED bus
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
 * `any` targets). Schema users: derive the entries with `CommandsOf<S>` from
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

let sharedBus: CommandBus | null = null;

/**
 * Get the shared bus. Typed with {@link SharedCommandMap} — augment
 * {@link GlobalCommands} to make every call site typed. Pass an explicit map
 * to override per call site (`getCommandBus<CommandMap>()` opts back out).
 */
export function getCommandBus<M extends CommandMap = SharedCommandMap>(): CommandBus<M> {
  if (!sharedBus) {
    sharedBus = createCommandBus();
  }
  return sharedBus as CommandBus<M>;
}

/**
 * Replace the shared bus instance.
 *
 * SSR WARNING: the shared bus is a module global — one per Node process, not
 * per request. The set-render-reset pattern (see ssr.ts) is only safe when
 * requests render strictly one at a time. Under CONCURRENT SSR renders,
 * interleaved requests stomp each other's bus: handlers and state leak across
 * requests. For concurrent servers, don't use the shared bus on the server —
 * create a bus per request and pass it explicitly (every composable and plugin
 * accepts a `bus` option / argument).
 *
 * Accepts either bus flavor — the composables' dispatch path already handles
 * thenable results (`runDispatch` awaits them), so an AsyncCommandBus works at
 * runtime; previously callers had to cast. `getCommandBus()`'s static type
 * stays `CommandBus` for compatibility.
 */
export function setCommandBus(bus: CommandBus | AsyncCommandBus): void {
  sharedBus = bus as CommandBus;
}

/**
 * Reset the shared bus to null. Useful in test teardown to prevent
 * handler/hook leaks between test files.
 */
export function resetCommandBus(): void {
  sharedBus = null;
}

// ---------------------------------------------------------------------------
// Vue lifecycle detection (optional — works without Vue too)
// ---------------------------------------------------------------------------

/**
 * Try to register a cleanup function on the nearest Vue scope/component.
 *
 * Uses `getCurrentScope()` (Vue 3.2+) to check whether a reactive scope is
 * active before calling `onScopeDispose`. This replaces the earlier try/catch
 * pattern — no exception-as-control-flow, no `onUnmounted` fallback needed.
 *
 * In Vue 3.5+ (the minimum peer dep), every component `setup()` — including
 * Vapor components — is wrapped in an effect scope, so `getCurrentScope()`
 * inside setup always returns something. The `onUnmounted` fallback is
 * unreachable under Vue 3.5+ and has been removed.
 *
 * Vue 3.6.0-beta.13 (runtime-vapor: only create lifecycle update jobs when
 * needed): lifecycle update jobs are now created lazily — only when a component
 * actually has reactive state that can trigger updates. Registering
 * `onScopeDispose` via this function no longer causes a lifecycle update job
 * to be allocated for every vapor-chamber composable call. Components that use
 * vapor-chamber composables solely for dispatch (no reactive signals consumed
 * in the template) incur zero update-job overhead.
 *
 * No-ops entirely when called outside any Vue scope (e.g. module init time,
 * plain async callbacks). Caller is responsible for calling `dispose()` in
 * those cases.
 */
export function tryAutoCleanup(disposeFn: () => void): void {
  probeVue();

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
      'effectScope(). Expected and harmless when intentional — e.g. in tests, ' +
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
 * `getCurrentInstance()` is the correct guard: `onActivated`/`onDeactivated`
 * throw when called outside a component setup context, so the upfront check
 * replaces the earlier two try/catch blocks.
 *
 * @internal — used by composables that manage bus subscriptions.
 */
export function tryKeepAliveHooks(onPause: () => void, onResume: () => void): void {
  probeVue();
  if (!_vueGetCurrentInstance?.()) return;
  _vueOnDeactivated?.(onPause);
  _vueOnActivated?.(onResume);
}

// ---------------------------------------------------------------------------
// runDispatch — shared loading/error wrapper used by useCommand, useCommandQuery,
// (chamber-vapor.ts). Accepts a thunk so the bus call is
// made inside the try block.
// ---------------------------------------------------------------------------

/** @internal */
export function runDispatch(
  busCall: () => any,
  loading: Signal<boolean>,
  lastError: Signal<Error | null>,
  onSuccess?: (value: any) => void,
): CommandResult | Promise<CommandResult> {
  loading.value = true;
  lastError.value = null;
  let result: any;
  try {
    // A dispatch is an action, not a read. Without this, every reactive value
    // the HANDLER touches becomes a dependency of whatever effect called the
    // composable, so the component re-runs on state it never mentions. Vue
    // fixed the same class twice in 3.6.0-rc.3 (#15203/#15204) the same way.
    // Pass-through when Vue is absent.
    result = untracked(busCall);
  } catch (e) {
    loading.value = false;
    const error = e as Error;
    lastError.value = error;
    return { ok: false, error };
  }
  if (result && typeof result.then === 'function') {
    return (result as Promise<CommandResult>).then(
      (r) => {
        loading.value = false;
        if (r.ok) onSuccess?.(r.value);
        else lastError.value = r.error ?? null;
        return r;
      },
      (e: Error) => { loading.value = false; lastError.value = e; return { ok: false, error: e }; },
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
 * useCommand — reactive command dispatch with optional bus subscriptions.
 *
 * Returns `dispatch` + reactive `loading` / `lastError`, plus `register` / `on` /
 * `emit` for managing handlers and listeners with auto-cleanup on scope disposal
 * (`onScopeDispose`). Vapor-safe — works in `<script setup vapor>` and VDOM alike,
 * with no `getCurrentInstance()` dependency. For fire-and-forget with zero reactive
 * overhead, use `defineVaporCommand()` instead.
 *
 * (Absorbed the former `useVaporCommand` — the Vapor-safety distinction was obsolete;
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

  function dispatch<A extends keyof SharedCommandMap & string>(
    action: A,
    target: TargetOf<SharedCommandMap, A>,
    payload?: PayloadOf<SharedCommandMap, A>,
  ): CommandResult<ResultOf<SharedCommandMap, A>> | Promise<CommandResult<ResultOf<SharedCommandMap, A>>> {
    return runDispatch(() => bus.dispatch(action, target, payload), loading, lastError);
  }

  function register<A extends keyof SharedCommandMap & string>(
    action: A,
    handler: (cmd: Command<A, TargetOf<SharedCommandMap, A>, PayloadOf<SharedCommandMap, A>>) => ResultOf<SharedCommandMap, A> | Promise<ResultOf<SharedCommandMap, A>>,
    opts?: RegisterOptions,
  ): () => void {
    const unregister = bus.register(action, handler as Handler, opts);
    listeners.push(unregister);
    return unregister;
  }

  function on(pattern: string, listener: (cmd: Command, result: CommandResult) => void): () => void {
    const unsub = bus.on(pattern, listener);
    listeners.push(unsub);
    return unsub;
  }

  /** Fire a domain event — notifies on() listeners, no handler required, no result. */
  function emit(event: string, data?: any): void {
    untracked(() => bus.emit(event, data));
  }

  function dispose() {
    disposeAll(listeners);
  }

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
  errorCap: number;
  /** v1.6.0: bus-wide error observer — unhooked when refCount hits 0. */
  unsub: () => void;
};

const _sharedStates = new WeakMap<CommandBus, SharedCommandStateEntry>();

export type UseSharedCommandStateOptions = {
  /**
   * How many recent errors to retain in `errors`. The list is kept
   * newest-last; older entries drop off. Default: 10.
   */
  errorCap?: number;
  /**
   * Bus to attach to. Defaults to the shared instance from `getCommandBus()`,
   * which matches the single-bus pattern most apps use. Pass an explicit bus
   * to scope shared state to a feature group / island.
   */
  bus?: CommandBus;
};

/**
 * useSharedCommandState — one set of reactive signals shared across every
 * caller, instead of two signals (`loading`, `lastError`) per call.
 *
 * Designed for component-heavy pages where many components need to react to
 * "is *anything* in flight?" or "what was the last error?". Replaces
 * `N × useCommand()` allocations with a single shared state per bus.
 *
 * Memory math: 50 components × 2 signals each = 100 signal nodes today.
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
  const errorCap = options.errorCap ?? 10;

  let state = _sharedStates.get(bus);
  if (!state) {
    const entry: SharedCommandStateEntry = {
      inFlight: signal(0),
      isAnyLoading: signal(false),
      lastError: signal<Error | null>(null),
      errors: signal<Error[]>([]),
      errorCount: signal(0),
      refCount: 0,
      errorCap,
      unsub: () => {},
    };
    // v1.6.0: observe errors BUS-WIDE, not only dispatches made through this
    // composable's own dispatch wrapper. Any failed command on the bus — from
    // useCommand, raw bus.dispatch, anywhere — lands in the
    // shared error list. (Both sync and async buses fan results to on('*')
    // listeners after settling.) inFlight/isAnyLoading remain scoped to this
    // composable's dispatch wrapper: bus-wide in-flight tracking would need
    // guaranteed before/after pairing on every dispatch path, which the bus
    // does not promise for all error paths.
    entry.unsub = bus.on('*', (_cmd, result) => {
      if (!result.ok && result.error) {
        entry.lastError.value = result.error;
        const next = entry.errors.value.slice();
        next.push(result.error);
        while (next.length > entry.errorCap) next.shift();
        entry.errors.value = next;
        entry.errorCount.value = next.length;
      }
    });
    state = entry;
    _sharedStates.set(bus, state);
  } else if (errorCap < state.errorCap) {
    // Tighten the cap if the new caller wants a smaller buffer; never grow
    // it above another caller's request (avoid surprise memory growth).
    state.errorCap = errorCap;
  }
  state.refCount++;

  function recordError(err: Error): void {
    state!.lastError.value = err;
    const next = state!.errors.value.slice();
    next.push(err);
    while (next.length > state!.errorCap) next.shift();
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
      return { ok: false, error, value: undefined };
    }

    if (result && typeof result.then === 'function') {
      return (result as Promise<CommandResult>).then(
        // Settled results are recorded by the bus-wide on('*') observer —
        // recording here too would double-count (v1.6.0).
        (r) => { decrement(); return r; },
        // A rejected dispatch promise bypassed the bus's errResult fan-out,
        // so no listener fired — record it here.
        (e: Error) => { recordError(e); decrement(); return { ok: false, error: e, value: undefined }; },
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

  function dispose(): void {
    state!.refCount--;
    if (state!.refCount <= 0) {
      state!.unsub(); // unhook the bus-wide error observer
      _sharedStates.delete(bus);
    }
  }

  tryAutoCleanup(dispose);

  return {
    dispatch,
    /** Number of dispatches currently in flight across all subscribers. */
    inFlight: state.inFlight,
    /** True when `inFlight > 0`. Bind to button `disabled` etc. */
    isAnyLoading: state.isAnyLoading,
    /** Most recent error (across all subscribers). */
    lastError: state.lastError,
    /** Ring buffer of recent errors, newest last, capped at `errorCap`. */
    errors: state.errors,
    /** Current size of the `errors` buffer. */
    errorCount: state.errorCount,
    /** Wipe accumulated errors. */
    clear,
    /** Manually unhook. Most callers don't need this — `tryAutoCleanup`
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
   * additional runtime optimizations — specialized v-for block operations
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
 * // Coalesced mode — batch writes for v-for lists:
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
 * @internal — shared core for `useCommandState` (shallow, default) and the
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

  // coalesce bookkeeping — only allocated when coalesce: true
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
// useCommandBus
// ---------------------------------------------------------------------------

/**
 * useCommandBus - lightweight composable wrapper around the shared bus.
 * Typed via GlobalCommands augmentation, same as getCommandBus().
 */
export function useCommandBus<M extends CommandMap = SharedCommandMap>(): CommandBus<M> {
  return getCommandBus<M>();
}

// ---------------------------------------------------------------------------
// useCommandHistory
// ---------------------------------------------------------------------------

/**
 * useCommandHistory - undo/redo with reactive state
 *
 * Auto-cleanup on Vue component unmount or scope disposal.
 * Undo executes inverse handlers when registered via register(action, handler, { undo }).
 */
export function useCommandHistory(options: {
  maxSize?: number;
  filter?: (cmd: Command) => boolean;
} = {}) {
  const { maxSize = 50, filter } = options;
  const bus = getCommandBus<CommandMap>();

  const past = signal<Command[]>([]);
  const future = signal<Command[]>([]);
  const canUndo = signal(false);
  const canRedo = signal(false);

  let paused = false;
  /** One-shot identity fallback for redos whose primitive payload cannot
   *  carry the `__origin` marker — see redo(). */
  let expectedRedo: Command | null = null;

  const unsubscribe = bus.onAfter((cmd, result) => {
    // `paused` brackets TIME (a KeepAlive deactivation), not one dispatch —
    // that distinction is why it is still a flag here and why redo() no longer
    // uses one. A redo is identified by the marker it dispatched with.
    if (paused || cmd.meta?.origin === 'redo') return;
    const exp = expectedRedo;
    if (exp && cmd.action === exp.action && cmd.target === exp.target && cmd.payload === exp.payload) {
      expectedRedo = null; // one-shot — consumed by the first match
      return;
    }
    if (result.ok && (!filter || filter(cmd))) {
      // One allocation: slice drops the oldest only when at cap, push appends.
      const newPast = past.value.slice(past.value.length >= maxSize ? 1 : 0);
      newPast.push(cmd);
      past.value = newPast;
      // Only clear the redo stack when there is one — a fresh [] every dispatch
      // is a new identity that re-triggers every future/canRedo watcher.
      if (future.value.length !== 0) {
        future.value = [];
        canRedo.value = false;
      }
      canUndo.value = true;
    }
  });

  // KeepAlive: pause tracking when deactivated, resume when activated
  tryKeepAliveHooks(
    () => { paused = true; },
    () => { paused = false; },
  );

  function undo(): Command | undefined {
    const p = [...past.value];
    const cmd = p.pop();
    if (cmd) {
      past.value = p;
      future.value = [...future.value, cmd];
      canUndo.value = p.length > 0;
      canRedo.value = true;

      // Execute inverse handler if available
      const undoHandler = bus.getUndoHandler(cmd.action);
      if (undoHandler) {
        try {
          undoHandler(cmd);
        } catch (e) {
          console.error(`[vapor-chamber] Undo handler error for "${cmd.action}":`, e);
        }
      }
    }
    return cmd;
  }

  function redo(): Command | undefined {
    const f = [...future.value];
    const cmd = f.pop();
    if (cmd) {
      future.value = f;
      // Suppression rides ON the dispatch. A `paused = true` flag cleared in
      // `finally` held only on a sync bus, where onAfter fires inside
      // dispatch(). On an async bus dispatch returns a pending promise and the
      // hook fires when it SETTLES — after the flag was cleared — so the redo
      // was recorded twice: once here, once by the unsuppressed hook. Undo
      // then needed two steps to walk back one redo, and the duplicate wiped
      // the redo stack again.
      //
      // With `__origin: 'redo'` the hook recognises it and skips, so the
      // manual push below is the single write path on both bus types.
      //
      // A PRIMITIVE payload (string/number/array) cannot carry the marker —
      // wrapping it would change what the handler receives. For those the
      // hook falls back to a one-shot identity match (`expectedRedo` below):
      // same action + same target + same payload reference, consumed on
      // first hit. Narrower than the marker (an identical concurrent
      // dispatch settling inside the window could be swallowed instead),
      // but strictly better than the double-record it replaces.
      const markable =
        cmd.payload === null || cmd.payload === undefined ||
        (typeof cmd.payload === 'object' && !Array.isArray(cmd.payload));
      const payload = !markable
        ? cmd.payload
        : cmd.payload === null || cmd.payload === undefined
          ? { __origin: 'redo' }
          : { ...(cmd.payload as object), __origin: 'redo' };
      if (!markable) expectedRedo = cmd;
      try {
        bus.dispatch(cmd.action, cmd.target, payload);
      } catch (e) {
        console.error(`[vapor-chamber] Redo dispatch error for "${cmd.action}":`, e);
      }
      past.value = [...past.value, cmd];
      canUndo.value = true;
      canRedo.value = f.length > 0;
    }
    return cmd;
  }

  function clear() {
    past.value = [];
    future.value = [];
    canUndo.value = false;
    canRedo.value = false;
  }

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
 * useCommandQuery — CQRS read-side composable with reactive state.
 *
 * Wraps bus.query() with reactive `data`, `loading`, and `lastError` signals.
 * query() skips onBefore hooks (no auth gates, no loading spinners for reads)
 * but runs plugins, handlers, and afterHooks.
 *
 * Supports both sync and async buses — if the result is a Promise, loading
 * stays true until it resolves.
 *
 * @example
 * const { query, data, loading, lastError } = useCommandQuery();
 * const result = query('getUser', { id: 42 });
 * // data.value = result.value after query completes
 */
export function useCommandQuery() {
  const bus = getCommandBus<CommandMap>();
  const data = signal<any>(null);
  const loading = signal(false);
  const lastError = signal<Error | null>(null);

  function query(action: string, target: any, payload?: any): CommandResult | Promise<CommandResult> {
    return runDispatch(
      () => bus.query(action, target, payload),
      loading,
      lastError,
      (value) => { data.value = value; },
    );
  }

  return { query, data, loading, lastError };
}

// ---------------------------------------------------------------------------
// useCommandGroup
// ---------------------------------------------------------------------------

/**
 * useCommandGroup — namespace isolation for large apps and multi-team projects.
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
 * // Orders feature — completely isolated
 * const orders = useCommandGroup('orders')
 * orders.dispatch('cancel', { id }) // dispatches 'ordersCancel'
 */
export function useCommandGroup(namespace: string) {
  const bus = getCommandBus<CommandMap>();
  const cleanups: Array<() => void> = [];

  // camelCase namespace join ('cart' + 'add' → 'cartAdd'). Inlined, NOT a shared
  // helper — DO NOT consolidate, settled, do not re-evaluate. This is a per-dispatch
  // path; a same-process A/B measured a shared-call indirection ~1% slower. Mirrored
  // inline at all three sites (createChamber / transitions / here) — keep in sync.
  function prefixed(action: string): string {
    return namespace + action.charAt(0).toUpperCase() + action.slice(1);
  }

  function dispatch(action: string, target: any, payload?: any): CommandResult {
    return untracked(() => bus.dispatch(prefixed(action), target, payload));
  }

  /** Read-only dispatch — skips onBefore hooks, runs handler + plugins, fires afterHooks. */
  function query(action: string, target: any, payload?: any): CommandResult {
    return untracked(() => bus.query(prefixed(action), target, payload));
  }

  /** Fire a namespaced domain event — notifies on() listeners, no handler required. */
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
    // Translate wildcard to namespaced: '*' → 'cart*', 'add' → 'cartAdd'
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
 * useCommandError — component-scoped error boundary for command failures.
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
  /** Max errors retained — oldest are dropped first (ring buffer). Default: 50. */
  errorCap?: number;
} = {}) {
  const { filter, errorCap = 50 } = options;
  const bus = getCommandBus<CommandMap>();

  type ErrorEntry = { cmd: Command; error: Error; timestamp: number };
  const errors = signal<ErrorEntry[]>([]);
  const latestError = signal<Error | null>(null);
  let paused = false;

  const unsubscribe = bus.onAfter((cmd, result) => {
    if (paused) return;
    if (!result.ok && result.error) {
      if (!filter || filter(cmd)) {
        latestError.value = result.error;
        const next = errors.value.slice();
        next.push({ cmd, error: result.error, timestamp: Date.now() });
        while (next.length > errorCap) next.shift();
        errors.value = next;
      }
    }
  });

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
