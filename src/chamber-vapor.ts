/**
 * vapor-chamber — Vue 3.6+ Vapor-specific API
 *
 * Vue alignment history (one line per version — full per-item detail lives in
 * CHANGELOG.md and the whitepaper's "Vue 3.6 alignment log" table, the single
 * source of per-beta detail; this header only records changes to THIS file):
 *   vNext / rc.1 — pass-through. All 13 runtime-vapor/hydration fixes land below the define
 *            wrappers, createVaporChamberApp, and getVaporInteropPlugin. No wrapper change.
 *   vNext / beta.17 — pass-through. Two runtime-vapor interop fixes land below the
 *            getVaporInteropPlugin() pass-through: VDOM↔Vapor slot updates now fire paired
 *            beforeUpdate/updated hooks (bcaa753) and the interop slot owner root re-syncs after
 *            child updates (975dd4d) — mixed Vapor/VDOM trees built on the forwarded plugin inherit
 *            both with no wrapper change. The renderer-internal slot-validity (b46322a) and
 *            function-ref tracking (#14986) fixes sit below the define* wrappers. No code change.
 *   vNext / beta.16 — pass-through. createVaporChamberApp returns Vue's app
 *            untouched, so it inherits two hardening fixes directly: .mount() on a
 *            missing selector now no-ops + dev-warns (was throwing) and can return
 *            undefined; .unmount() no longer throws in PRODUCTION builds (app._instance
 *            is dev-only — prod now resolves the root from a WeakMap). Plus pass-through
 *            prop/emit/attr fixes (nullish dynamic props → empty, nullish emit sources
 *            skipped, symbol attr values stringified). No wrapper code change.
 *   v1.6.0 / beta.15 — lib-side: the define* wrappers and createVaporChamberApp
 *            gained an opt-in return generic (`<T = any>`) and `object`-typed
 *            options instead of `any`. Vue 3.6 exports proper Vapor types now,
 *            but importing them here would put a hard `vue` type dependency on
 *            the main barrel and break Vue-less command-bus consumers — callers
 *            opt in: `defineVaporComponent<MyComp>(opts)`. Vue-side (interop
 *            vnode guard, keyed template refs, the teleport group, fragment-class
 *            tree-shaking) is all pass-through.
 *   v1.5.0 / beta.14 — pass-through (custom-element hooks/props, interop bridge
 *            stability + slot-wrapper memoisation, async loadingComponent props,
 *            scope IDs, scheduler flush, v-for lifecycle ordering).
 *   v1.4.0 / beta.13 — pass-through (interop scope IDs on Vapor roots, v-once in
 *            VDOM slot interop, v-once slot/prop snapshots).
 *   v1.3.0 / beta.12 — pass-through (Vapor setup() error recovery, VDOM slot
 *            interop normalization).
 *   v1.1.0 — Added: defineVaporCustomElement, defineVaporComponent,
 *            defineVaporAsyncComponent wrappers (Vue APIs introduced across
 *            3.6.0-alpha.3–5: #13059 / #14017 / #13831); useVaporAsyncCommand.
 *   v0.6.0 — Added: useVaporCommand. v0.4.0 — Added: createVaporChamberApp,
 *            getVaporInteropPlugin, defineVaporCommand.
 *
 * Separated from chamber.ts to keep the core composable module CDCC-compliant.
 */

import {
  getCommandBus,
  signal,
  tryAutoCleanup,
  getVaporAppFn,
  getVaporInteropRef,
  getDefineVaporCustomElementFn,
  getDefineVaporComponentFn,
  getDefineVaporAsyncComponentFn,
} from './chamber';
import type { Handler, RegisterOptions, CommandResult, CommandMap } from './command-bus';

/**
 * Create a Vapor app instance with vapor-chamber ready.
 * Requires Vue 3.6+. Throws if Vapor is not available.
 *
 * Pass-through over Vue's createVaporApp — scope-ID handling, HMR app-instance
 * refresh, and setup() error recovery are Vue runtime behavior (per-beta detail:
 * CHANGELOG / whitepaper alignment log).
 *
 * @example
 * import { createVaporChamberApp } from 'vapor-chamber';
 * import App from './App.vue';
 * createVaporChamberApp(App).mount('#app');
 */
export function createVaporChamberApp<TApp = any>(
  rootComponent: object,
  rootProps?: Record<string, unknown>,
): TApp {
  const fn = getVaporAppFn();
  if (!fn) {
    throw new Error(
      '[vapor-chamber] Vue 3.6+ with Vapor mode required. ' +
      'Install vue@^3.6.0-beta.1 or use createApp() for VDOM mode.'
    );
  }
  return fn(rootComponent, rootProps) as TApp;
}

/**
 * Returns the vaporInteropPlugin if available (Vue 3.6+).
 * Use this to enable mixed Vapor/VDOM component trees.
 *
 * Pass-through over Vue's plugin. Since beta.14 the returned reference is safe
 * to hold across HMR cycles (Vue no longer mutates the bridge), and since
 * beta.15 interop vnode reads are guarded against absent vnodes (per-beta
 * detail: CHANGELOG / whitepaper alignment log).
 *
 * @example
 * import { createApp } from 'vue';
 * import { getVaporInteropPlugin } from 'vapor-chamber';
 * const plugin = getVaporInteropPlugin();
 * if (plugin) createApp(App).use(plugin).mount('#app');
 */
export function getVaporInteropPlugin(): any | null {
  return getVaporInteropRef();
}

// ---------------------------------------------------------------------------
// Vapor Custom Elements (Vue 3.6 — defineVaporCustomElement introduced in 3.6.0-alpha.4, #14017)
// ---------------------------------------------------------------------------

/**
 * defineVaporCustomElement — create a custom element backed by Vapor rendering.
 *
 * Wraps Vue's `defineVaporCustomElement()` (introduced in 3.6.0-alpha.4, #14017). The generated custom
 * element uses Vapor's compiler-optimized rendering instead of the VDOM, giving
 * zero-overhead DOM updates inside shadow DOM. Safe to call with a reused
 * options object, and children re-render on reactive prop changes (beta.14+;
 * per-beta detail: CHANGELOG / whitepaper alignment log).
 *
 * Returns null if the Vapor runtime (Vue 3.6+) is not detected — check before calling
 * `customElements.define()`.
 *
 * @example
 * import { defineVaporCustomElement } from 'vapor-chamber';
 * const MyEl = defineVaporCustomElement({
 *   props: { label: String },
 *   setup(props) { return () => h('span', props.label); }
 * });
 * if (MyEl) customElements.define('vc-greeting', MyEl);
 */
export function defineVaporCustomElement<T = any>(options: object, extraOptions?: object): T | null {
  const fn = getDefineVaporCustomElementFn();
  if (!fn) return null;
  return (extraOptions !== undefined ? fn(options, extraOptions) : fn(options)) as T;
}

/**
 * defineVaporComponent — define a Vapor component with proper type inference.
 *
 * Wraps Vue's `defineVaporComponent()` (typed since 3.6.0-alpha.5, #13831). Use this to get full
 * TypeScript inference for props, emits, and slots in Vapor components.
 * Pass-through — emits/$attrs routing, v-once interop, scope IDs, and the
 * compiler optimizations are Vue behavior (per-beta detail: CHANGELOG /
 * whitepaper alignment log).
 *
 * Returns null if the Vapor runtime (Vue 3.6+) is not detected.
 *
 * @example
 * import { defineVaporComponent } from 'vapor-chamber';
 * const Comp = defineVaporComponent({
 *   props: { count: Number },
 *   emits: ['change'],
 *   setup(props) { return () => h('div', `Count: ${props.count}`); }
 * });
 */
export function defineVaporComponent<T = any>(options: object): T | null {
  const fn = getDefineVaporComponentFn();
  if (!fn) return null;
  return fn(options) as T;
}

/**
 * defineVaporAsyncComponent — define an async Vapor component for lazy loading.
 *
 * Wraps Vue's `defineVaporAsyncComponent()` (introduced in 3.6.0-alpha.3, #13059). Async Vapor
 * components are cached by VaporKeepAlive and hydrate under VDOM Suspense.
 * The loading placeholder receives the deferred component's props and slots
 * (beta.14+) — render a skeleton matching the final shape. Per-beta detail:
 * CHANGELOG / whitepaper alignment log.
 *
 * Returns null if the Vapor runtime (Vue 3.6+) is not detected.
 *
 * @example
 * import { defineVaporAsyncComponent } from 'vapor-chamber';
 * const AsyncPanel = defineVaporAsyncComponent(() => import('./Panel.vue'));
 */
export function defineVaporAsyncComponent<T = any>(
  loader: (() => Promise<unknown>) | object,
): T | null {
  const fn = getDefineVaporAsyncComponentFn();
  if (!fn) return null;
  return fn(loader) as T;
}

// ---------------------------------------------------------------------------
// defineVaporCommand
// ---------------------------------------------------------------------------

/**
 * defineVaporCommand — zero-overhead command for hot paths in Vapor mode.
 *
 * Unlike useCommand(), this skips reactive loading/error signal creation.
 * Ideal for high-frequency, fire-and-forget patterns where reactive
 * loading/error state isn't needed: scroll-position tracking, mousemove
 * sampling, telemetry / metrics events, debounced search, autosave.
 *
 * @example
 * const { dispatch } = defineVaporCommand('telemetryEvent', (cmd) => {
 *   // forward to whatever metrics / analytics SDK you use
 *   sendMetric(cmd.target.name, cmd.target.params);
 * });
 * dispatch({ name: 'page_view', params: { page: '/landing' } });
 */
export function defineVaporCommand(
  action: string,
  handler: Handler,
  options?: RegisterOptions
) {
  const bus = getCommandBus<CommandMap>();
  const unregister = bus.register(action, handler, options);

  function dispatch(target: any, payload?: any): CommandResult {
    return bus.dispatch(action, target, payload);
  }

  function dispose() { unregister(); }

  tryAutoCleanup(dispose);

  return { dispatch, dispose };
}

// ---------------------------------------------------------------------------
// useVaporAsyncCommand
// ---------------------------------------------------------------------------

/**
 * useVaporAsyncCommand — async-aware command dispatch for Vapor components
 * used inside Suspense boundaries.
 *
 * Vue 3.6.0-beta.10 introduced proper async component hydration under VDOM
 * Suspense. This composable wraps an AsyncCommandBus dispatch with reactive
 * loading/error state, making it safe for `<script setup vapor>` components
 * that await async operations. Error-boundary rendering and scheduler-flush
 * behavior around async components are Vue runtime concerns (per-beta detail:
 * CHANGELOG / whitepaper alignment log).
 *
 * The dispatch function returns a Promise<CommandResult>, matching the
 * AsyncCommandBus interface. Use this when your commands hit async transports
 * (HTTP bridge, WS bridge) and you need awaitable results.
 *
 * @example
 * // In a <script setup vapor> component under <Suspense>:
 * import { useVaporAsyncCommand } from 'vapor-chamber';
 * const { dispatch, loading, lastError } = useVaporAsyncCommand(asyncBus);
 * const result = await dispatch('orderCreate', { items: cart });
 */
export function useVaporAsyncCommand(asyncBus?: { dispatch: (action: string, target: any, payload?: any) => Promise<CommandResult> }) {
  const bus = asyncBus ?? (getCommandBus() as any);
  const loading = signal(false);
  const lastError = signal<Error | null>(null);

  // Intentionally hand-rolled, NOT routed through the shared runDispatch() that
  // useCommand / useCommandQuery use. A single async/await is
  // ~1.2× leaner on the dispatch wrapper than runDispatch's .then-chain (measured);
  // this is the awaited HTTP/WS path, so keep it lean. Do not "consolidate" into
  // runDispatch — the consistency isn't worth the wrapper overhead here.
  async function dispatch(action: string, target: any, payload?: any): Promise<CommandResult> {
    loading.value = true;
    lastError.value = null;
    try {
      const result = await bus.dispatch(action, target, payload);
      if (!result.ok) lastError.value = result.error ?? null;
      return result;
    } catch (e) {
      const error = e as Error;
      lastError.value = error;
      return { ok: false, error };
    } finally {
      loading.value = false;
    }
  }

  // Dispatch-only composable (no register/on, unlike useCommand) — there are no
  // subscriptions to tear down. Kept as a no-op for return-shape symmetry with the
  // other composables (callers may destructure `dispose`).
  function dispose() {}

  tryAutoCleanup(dispose);

  return { dispatch, loading, lastError, dispose };
}
