/**
 * vapor-chamber — Vue 3.6+ Vapor-specific API
 *
 * v1.1.0 — Added: defineVaporCustomElement, defineVaporComponent,
 *           defineVaporAsyncComponent wrappers (Vue 3.6.0-beta.10+);
 *           useVaporAsyncCommand for Suspense-aware async dispatch.
 * v0.6.0 — Added: useVaporCommand composable.
 * v0.4.0 — Added: createVaporChamberApp, getVaporInteropPlugin, defineVaporCommand.
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
import type { Handler, AsyncHandler, RegisterOptions, CommandResult, Command } from './command-bus';

/**
 * Create a Vapor app instance with vapor-chamber ready.
 * Requires Vue 3.6+. Throws if Vapor is not available.
 *
 * @example
 * import { createVaporChamberApp } from 'vapor-chamber';
 * import App from './App.vue';
 * createVaporChamberApp(App).mount('#app');
 */
export function createVaporChamberApp(rootComponent: any, rootProps?: any) {
  const fn = getVaporAppFn();
  if (!fn) {
    throw new Error(
      '[vapor-chamber] Vue 3.6+ with Vapor mode required. ' +
      'Install vue@^3.6.0-beta.1 or use createApp() for VDOM mode.'
    );
  }
  return fn(rootComponent, rootProps);
}

/**
 * Returns the vaporInteropPlugin if available (Vue 3.6+).
 * Use this to enable mixed Vapor/VDOM component trees.
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
 * zero-overhead DOM updates inside shadow DOM.
 *
 * SSR runtime is automatically tree-shaken from the generated code (beta.10 fix).
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
 * if (MyEl) customElements.define('my-el', MyEl);
 */
export function defineVaporCustomElement(options: any, extraOptions?: any): any | null {
  const fn = getDefineVaporCustomElementFn();
  if (!fn) return null;
  return extraOptions !== undefined ? fn(options, extraOptions) : fn(options);
}

/**
 * defineVaporComponent — define a Vapor component with proper type inference.
 *
 * Wraps Vue 3.6.0-beta.10's `defineVaporComponent()`. Use this to get full
 * TypeScript inference for props, emits, and slots in Vapor components.
 *
 * Returns null if Vue 3.6.0-beta.10+ is not detected.
 *
 * @example
 * import { defineVaporComponent } from 'vapor-chamber';
 * const Comp = defineVaporComponent({
 *   props: { count: Number },
 *   setup(props) { return () => h('div', `Count: ${props.count}`); }
 * });
 */
export function defineVaporComponent(options: any): any | null {
  const fn = getDefineVaporComponentFn();
  if (!fn) return null;
  return fn(options);
}

/**
 * defineVaporAsyncComponent — define an async Vapor component for lazy loading.
 *
 * Wraps Vue 3.6.0-beta.10's `defineVaporAsyncComponent()`. Async Vapor
 * components are properly cached by VaporKeepAlive and hydrate under VDOM
 * Suspense boundaries (beta.10 fix).
 *
 * Returns null if Vue 3.6.0-beta.10+ is not detected.
 *
 * @example
 * import { defineVaporAsyncComponent } from 'vapor-chamber';
 * const AsyncPanel = defineVaporAsyncComponent(() => import('./Panel.vue'));
 */
export function defineVaporAsyncComponent(loader: any): any | null {
  const fn = getDefineVaporAsyncComponentFn();
  if (!fn) return null;
  return fn(loader);
}

// ---------------------------------------------------------------------------
// defineVaporCommand
// ---------------------------------------------------------------------------

/**
 * defineVaporCommand — zero-overhead command for hot paths in Vapor mode.
 *
 * Unlike useCommand(), this skips reactive loading/error signal creation.
 * Ideal for high-frequency dispatches: scroll tracking, mousemove, GA4 events,
 * debounced search, and any fire-and-forget pattern where you don't need
 * reactive loading/error state.
 *
 * @example
 * const { dispatch } = defineVaporCommand('analyticsTrack', (cmd) => {
 *   gtag('event', cmd.target.event, cmd.target.params);
 * });
 * dispatch({ event: 'page_view', params: { page: '/shop' } });
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
    loading.value = true;
    lastError.value = null;
    let result: any;
    try {
      result = bus.dispatch(action, target, payload);
    } catch (e) {
      loading.value = false;
      const error = e as Error;
      lastError.value = error;
      return { ok: false, error };
    }

    // Handle async results (when using async bus or async transport plugins)
    if (result && typeof result.then === 'function') {
      return (result as Promise<CommandResult>).then(
        (r) => { loading.value = false; if (!r.ok) lastError.value = r.error ?? null; return r; },
        (e: Error) => { loading.value = false; lastError.value = e; return { ok: false, error: e }; },
      );
    }

    loading.value = false;
    if (!result.ok) lastError.value = result.error ?? null;
    return result;
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
 * that await async operations.
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
