/**
 * vapor-chamber - Vue 3.6+ Vapor-specific API
 *
 * Vue alignment history (one line per version - full per-item detail lives in
 * CHANGELOG.md and the whitepaper's "Vue 3.6 alignment log", section 9.2, the single
 * source of per-beta detail; this header records only changes to THIS file):
 *   rc.5 / rc.2 / rc.1 / beta.17 / beta.16 - pass-through. This file renders
 *          nothing; it forwards Vue's own define* functions, so rendering-side
 *          work (attrs fallthrough, interop, hydration) lands below it.
 *   v1.6.0 / beta.15 - lib-side: the define* wrappers and createVaporChamberApp
 *          gained an opt-in return generic (`<T = any>`) and `object`-typed
 *          options. Importing Vue's Vapor types here would put a hard `vue`
 *          type dependency on the main barrel and break Vue-less command-bus
 *          consumers, so callers opt in: `defineVaporComponent<MyComp>(opts)`.
 *   v1.5.0 / v1.4.0 / v1.3.0 - pass-through.
 *   v1.1.0 - Added: defineVaporCustomElement, defineVaporComponent,
 *          defineVaporAsyncComponent wrappers; useVaporAsyncCommand.
 *   v0.6.0 - Added: useVaporCommand. v0.4.0 - Added: createVaporChamberApp.
 *
 * Separated from chamber.ts to keep the core composable module CDCC-compliant.
 */

import {
  getCommandBus,
  signal,
  tryAutoCleanup,
  untracked,
  getVaporAppFn,
  getVaporInteropRef,
  getDefineVaporCustomElementFn,
  getDefineVaporComponentFn,
  getDefineVaporAsyncComponentFn,
  vueDetectionHint,
} from './chamber';
import type { Handler, RegisterOptions, CommandResult, CommandMap } from './command-bus';
import { _errResult } from './command-bus';
import { DEV } from './dev';

/**
 * Why the `defineVapor*` wrappers warn instead of just returning null.
 *
 * Each returns `null` when the Vapor runtime is absent, and callers are
 * documented to check. But a bare `null` is the same failure shape that hid a
 * real bug for several releases: `tryKeepAliveHooks` guarded on an accessor
 * that silently answers "no" under Vapor, so a feature was inert with nothing
 * to see (rc.4 cycle - see tests/keepalive-input-scope-fixture.test.ts). Silent
 * negatives are how detection bugs survive.
 *
 * So the null stays - throwing would break the documented contract and the
 * tests that assert it - but it is no longer quiet. The call sites gate on
 * `DEV`, so the whole call (and every byte of message text) folds out of the
 * production IIFE builds; this helper is then unreferenced and tree-shaken.
 */
function devWarnNoVapor(api: string): void {
  console.warn(
    `[vapor-chamber] ${api}() returned null - Vue 3.6+ with Vapor mode was not detected, ` +
      `so the component was NOT created. ${vueDetectionHint()} ` +
      'For VDOM mode use the matching define* helper from vue instead.',
  );
}

/**
 * Create a Vapor app instance with vapor-chamber ready.
 * Requires Vue 3.6+. Throws if Vapor is not available.
 *
 * Pass-through over Vue's createVaporApp - scope-ID handling, HMR app-instance
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
    // The bare "Vapor required" message was the same whether Vue was absent,
    // present-without-Vapor, or present-but-unreachable - three different
    // problems with three different fixes. vueDetectionHint() names which.
    throw new Error(
      `[vapor-chamber] Vue 3.6+ with Vapor mode required. ${vueDetectionHint()} ` +
      'For VDOM mode, use createApp() from vue instead.'
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
// Vapor Custom Elements (Vue 3.6 - defineVaporCustomElement introduced in 3.6.0-alpha.4, #14017)
// ---------------------------------------------------------------------------

/**
 * defineVaporCustomElement - create a custom element backed by Vapor rendering.
 *
 * Wraps Vue's `defineVaporCustomElement()` (introduced in 3.6.0-alpha.4, #14017). The generated custom
 * element uses Vapor's compiler-optimized rendering instead of the VDOM, giving
 * zero-overhead DOM updates inside shadow DOM. Safe to call with a reused
 * options object, and children re-render on reactive prop changes (beta.14+;
 * per-beta detail: CHANGELOG / whitepaper alignment log).
 *
 * Returns null if the Vapor runtime (Vue 3.6+) is not detected - check before calling
 * `customElements.define()`.
 *
 * @example
 * import { defineVaporCustomElement } from 'vapor-chamber';
 * const MyEl = defineVaporCustomElement({
 *   props: { label: String },
 *   // A Vapor setup() returns a BLOCK - real DOM nodes - not a render
 *   // function or h() output. An SFC's compiler builds this from its template.
 *   setup(props) {
 *     const span = document.createElement('span');
 *     span.textContent = String(props.label);
 *     return span;
 *   }
 * });
 * if (MyEl) customElements.define('vc-greeting', MyEl);
 */
export function defineVaporCustomElement<T = any>(options: object, extraOptions?: object): T | null {
  const fn = getDefineVaporCustomElementFn();
  if (!fn) {
    if (DEV) devWarnNoVapor("defineVaporCustomElement");
    return null;
  }
  return (extraOptions !== undefined ? fn(options, extraOptions) : fn(options)) as T;
}

/**
 * defineVaporComponent - define a Vapor component with proper type inference.
 *
 * Wraps Vue's `defineVaporComponent()` (typed since 3.6.0-alpha.5, #13831). Use this to get full
 * TypeScript inference for props, emits, and slots in Vapor components.
 * Pass-through - emits/$attrs routing, v-once interop, scope IDs, and the
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
 *   // Returns DOM nodes (a block), not h(): see defineVaporCustomElement above.
 *   setup(props) {
 *     const div = document.createElement('div');
 *     div.textContent = `Count: ${props.count}`;
 *     return div;
 *   }
 * });
 */
export function defineVaporComponent<T = any>(options: object): T | null {
  const fn = getDefineVaporComponentFn();
  if (!fn) {
    if (DEV) devWarnNoVapor("defineVaporComponent");
    return null;
  }
  return fn(options) as T;
}

/**
 * defineVaporAsyncComponent - define an async Vapor component for lazy loading.
 *
 * Wraps Vue's `defineVaporAsyncComponent()` (introduced in 3.6.0-alpha.3, #13059). Async Vapor
 * components are cached by VaporKeepAlive and hydrate under VDOM Suspense.
 * The loading placeholder receives the deferred component's props and slots
 * (beta.14+) - render a skeleton matching the final shape. Per-beta detail:
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
  if (!fn) {
    if (DEV) devWarnNoVapor("defineVaporAsyncComponent");
    return null;
  }
  return fn(loader) as T;
}

// ---------------------------------------------------------------------------
// defineVaporCommand
// ---------------------------------------------------------------------------

/**
 * defineVaporCommand - zero-overhead command for hot paths in Vapor mode.
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

  // `untracked`, like every other composable's dispatch. This one was the gap,
  // and the worst place for it: a dispatch is an ACTION, not a read, and this
  // helper is documented for hot paths in Vapor mode - i.e. the call most
  // likely to be made from inside a render effect, where the handler's reads
  // become that effect's dependencies and the component re-renders on state it
  // never mentions. Pass-through when Vue is absent, so the "zero reactive
  // overhead" claim above is unaffected for non-Vue consumers.
  function dispatch(target: any, payload?: any): CommandResult {
    return untracked(() => bus.dispatch(action, target, payload));
  }

  function dispose() { unregister(); }

  tryAutoCleanup(dispose);

  return { dispatch, dispose };
}

// ---------------------------------------------------------------------------
// useVaporAsyncCommand
// ---------------------------------------------------------------------------

/**
 * useVaporAsyncCommand - async-aware command dispatch for Vapor components
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
 * Vue 3.6.0-rc.8: an awaiting `<script setup vapor>` compiles to an
 * `async setup()` that uses runtime-core's `withAsyncContext` and returns its
 * template as a render closure, and it registers with the NEAREST `<Suspense>`.
 * Composables called after the `await` - this one, `useCommand()` - arm their
 * cleanup on the restored component scope, including when the app unmounts
 * during the await. Pinned by tests/async-vapor-setup-fixture.test.ts.
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
  // ~1.2x leaner on the dispatch wrapper than runDispatch's .then-chain (measured);
  // this is the awaited HTTP/WS path, so keep it lean. Do not "consolidate" into
  // runDispatch - the consistency isn't worth the wrapper overhead here.
  async function dispatch(action: string, target: any, payload?: any): Promise<CommandResult> {
    loading.value = true;
    lastError.value = null;
    try {
      // Untracked around the SYNCHRONOUS entry only - once the dispatch
      // suspends, the caller's effect has finished and there is no subscriber
      // left to leak into (pinned by the "synchronous entry is the whole
      // exposure" test). Same scope as runDispatch's, one call, so the leaner
      // hand-rolled wrapper above stays leaner.
      const result = await untracked(() => bus.dispatch(action, target, payload));
      if (!result.ok) lastError.value = result.error ?? null;
      return result;
    } catch (e) {
      const error = e as Error;
      lastError.value = error;
      return _errResult(error);
    } finally {
      loading.value = false;
    }
  }

  // Dispatch-only composable (no register/on, unlike useCommand) - there are no
  // subscriptions to tear down. Kept as a no-op for return-shape symmetry with the
  // other composables (callers may destructure `dispose`).
  function dispose() {}

  tryAutoCleanup(dispose);

  return { dispatch, loading, lastError, dispose };
}
