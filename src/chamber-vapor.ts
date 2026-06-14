/**
 * vapor-chamber — Vue 3.6+ Vapor-specific API
 *
 * Vue alignment history (one line per version — full per-item detail lives in
 * CHANGELOG.md and the whitepaper's "Vue 3.6 alignment log" table, the single
 * source of per-beta detail; this header only records changes to THIS file):
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
 *            defineVaporAsyncComponent wrappers (beta.10+); useVaporAsyncCommand.
 *   v0.6.0 — Added: useVaporCommand. v0.4.0 — Added: createVaporChamberApp,
 *            getVaporInteropPlugin, defineVaporCommand.
 *
 * Separated from chamber.ts to keep the core composable module CDCC-compliant.
 */

import {
  getCommandBus,
  signal,
  tryAutoCleanup,
  runDispatch,
  getVaporAppFn,
  getVaporInteropRef,
  getDefineVaporCustomElementFn,
  getDefineVaporComponentFn,
  getDefineVaporAsyncComponentFn,
} from './chamber';
import type { Handler, RegisterOptions, CommandResult, Command } from './command-bus';

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
// Vue 3.6.0-beta.10+ Vapor Custom Elements
// ---------------------------------------------------------------------------

/**
 * defineVaporCustomElement — create a custom element backed by Vapor rendering.
 *
 * Wraps Vue 3.6.0-beta.10's `defineVaporCustomElement()`. The generated custom
 * element uses Vapor's compiler-optimized rendering instead of the VDOM, giving
 * zero-overhead DOM updates inside shadow DOM. Safe to call with a reused
 * options object, and children re-render on reactive prop changes (beta.14+;
 * per-beta detail: CHANGELOG / whitepaper alignment log).
 *
 * Returns null if Vue 3.6.0-beta.10+ is not detected — check before calling
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
 * Wraps Vue 3.6.0-beta.10's `defineVaporComponent()`. Use this to get full
 * TypeScript inference for props, emits, and slots in Vapor components.
 * Pass-through — emits/$attrs routing, v-once interop, scope IDs, and the
 * compiler optimizations are Vue behavior (per-beta detail: CHANGELOG /
 * whitepaper alignment log).
 *
 * Returns null if Vue 3.6.0-beta.10+ is not detected.
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
 * Wraps Vue 3.6.0-beta.10's `defineVaporAsyncComponent()`. Async Vapor
 * components are cached by VaporKeepAlive and hydrate under VDOM Suspense.
 * The loading placeholder receives the deferred component's props and slots
 * (beta.14+) — render a skeleton matching the final shape. Per-beta detail:
 * CHANGELOG / whitepaper alignment log.
 *
 * Returns null if Vue 3.6.0-beta.10+ is not detected.
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
  const bus = getCommandBus();
  const unregister = bus.register(action, handler, options);

  function dispatch(target: any, payload?: any): CommandResult {
    return bus.dispatch(action, target, payload);
  }

  function dispose() { unregister(); }

  tryAutoCleanup(dispose);

  return { dispatch, dispose };
}

// ---------------------------------------------------------------------------
// useVaporCommand
// ---------------------------------------------------------------------------

/**
 * useVaporCommand — reactive command dispatch designed for Vapor components.
 *
 * Like useCommand() but safe for `<script setup vapor>` where
 * getCurrentInstance() returns null. Provides reactive loading/error signals
 * and relies exclusively on onScopeDispose for cleanup (no onUnmounted path).
 *
 * For fire-and-forget (no loading/error state), prefer defineVaporCommand().
 *
 * @example
 * // In a <script setup vapor> component:
 * import { useVaporCommand } from 'vapor-chamber';
 * const { dispatch, loading, lastError } = useVaporCommand();
 * dispatch('cartAdd', { id: product.id });
 */
export function useVaporCommand() {
  const bus = getCommandBus();
  const loading = signal(false);
  const lastError = signal<Error | null>(null);
  const listeners: Array<() => void> = [];

  function dispatch(action: string, target: any, payload?: any): CommandResult | Promise<CommandResult> {
    return runDispatch(() => bus.dispatch(action, target, payload), loading, lastError);
  }

  function register(action: string, handler: Handler, opts?: RegisterOptions): () => void {
    const unregister = bus.register(action, handler, opts);
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
    bus.emit(event, data);
  }

  function dispose() {
    listeners.forEach(fn => fn());
    listeners.length = 0;
  }

  tryAutoCleanup(dispose);

  return { dispatch, register, on, emit, loading, lastError, dispose };
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
  const listeners: Array<() => void> = [];

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

  function dispose() {
    listeners.forEach(fn => fn());
    listeners.length = 0;
  }

  tryAutoCleanup(dispose);

  return { dispatch, loading, lastError, dispose };
}
