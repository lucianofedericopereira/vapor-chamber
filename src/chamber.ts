/**
 * vapor-chamber - Vue Vapor integration
 *
 * v1.1.0 — Vue 3.6.0-beta.10 alignment: defineVaporCustomElement, defineVaporComponent,
 *           defineVaporAsyncComponent detection; improved hydration interop.
 * v0.4.1 — Added: useCommandGroup (namespace isolation), useCommandError (error boundary).
 * v0.4.0 — Vue 3.6 Vapor alignment: onScopeDispose, Vapor detection,
 *           defineVaporCommand, createVaporChamberApp.
 * v0.3.0 — Fixed: signal shim, resetCommandBus, auto-cleanup on Vue unmount.
 */

import { createCommandBus, type CommandBus, type Command, type CommandResult, type Handler, type Plugin, type RegisterOptions, type Listener } from './command-bus';
import { configureSignal, signal } from './signal';
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

let _vueOnUnmounted: ((fn: () => void) => void) | null = null;
let _vueOnScopeDispose: ((fn: () => void) => void) | null = null;
let _vueGetCurrentInstance: (() => any) | null = null;
let _vueOnActivated: ((fn: () => void) => void) | null = null;
let _vueOnDeactivated: ((fn: () => void) => void) | null = null;
let _vueProbed = false;

// Vue 3.6+ Vapor detection
let _hasVapor = false;
let _createVaporAppFn: any = null;
let _vaporInteropPluginRef: any = null;
// Vue 3.6.0-beta.10+ Vapor APIs
let _defineVaporCustomElementFn: any = null;
let _defineVaporComponentFn: any = null;
let _defineVaporAsyncComponentFn: any = null;

/** Promise that resolves once Vue detection is complete. Await this in composables
 *  that need Vue APIs to be available before first use. */
let _probePromise: Promise<void> | null = null;

function applyVueModule(vue: any): void {
  if (vue && typeof vue.ref === 'function') {
    // Push Vue's ref() into the signal module so signal() returns real
    // alien-signals-backed reactives going forward.
    configureSignal(vue.ref);
  }

  // Prefer onScopeDispose (Vue 3.5+) — works in effectScope, VDOM, and Vapor
  if (vue && typeof vue.onScopeDispose === 'function') {
    _vueOnScopeDispose = vue.onScopeDispose;
  }

  if (vue && typeof vue.onUnmounted === 'function') {
    _vueOnUnmounted = vue.onUnmounted;
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

  // Vue 3.6.0-beta.10+: Vapor custom elements and component definitions
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

function probeVue(): void {
  if (_vueProbed) return;
  _vueProbed = true;

  // 1. Synchronous probe: check globalThis.__VUE__ (set by Vue devtools or bundler)
  //    This gives immediate availability for signal() calls at module init time.
  if (typeof globalThis !== 'undefined' && (globalThis as any).__VUE__) {
    try {
      // If Vue is already loaded as a global (common in MPA / server-rendered
      // page setups where Vue ships via a `<script>` tag), use it synchronously.
      const vue = (globalThis as any).__VUE__;
      if (typeof vue.ref === 'function') {
        applyVueModule(vue);
      }
    } catch { /* not available synchronously */ }
  }

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
    });
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

// ---------------------------------------------------------------------------
// Shared command bus instance
// ---------------------------------------------------------------------------

let sharedBus: CommandBus | null = null;

export function getCommandBus(): CommandBus {
  if (!sharedBus) {
    sharedBus = createCommandBus();
  }
  return sharedBus;
}

export function setCommandBus(bus: CommandBus): void {
  sharedBus = bus;
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
 * v0.4.0: Prefers onScopeDispose (Vue 3.5+) over onUnmounted.
 * onScopeDispose works in component setup, effectScope(), Vapor components,
 * and SSR — making it the correct choice for library composables.
 *
 * Falls back to onUnmounted if onScopeDispose is not available.
 * No-ops entirely if not inside a Vue context.
 */
export function tryAutoCleanup(disposeFn: () => void): void {
  probeVue();

  // Prefer onScopeDispose — works in effectScope + both VDOM and Vapor
  if (_vueOnScopeDispose) {
    try {
      _vueOnScopeDispose(disposeFn);
      return;
    } catch {
      // Not in a reactive scope — try onUnmounted fallback
    }
  }

  // Fallback: onUnmounted (requires component setup context).
  // NOTE: In Vue 3.6+ Vapor components, getCurrentInstance() returns null
  // even inside <script setup>. This fallback only works for VDOM components.
  // Vapor components are already covered by onScopeDispose above.
  if (_vueOnUnmounted && _vueGetCurrentInstance) {
    try {
      if (_vueGetCurrentInstance()) {
        _vueOnUnmounted(disposeFn);
        return;
      }
    } catch {
      // Not in a setup context — caller must call dispose() manually
    }
  }

  // If Vue is detected but neither scope nor instance is available,
  // the caller is likely outside setup() — warn in dev mode.
  // (Use `_vueOnScopeDispose` as the "Vue detected" probe — it's set in the
  //  same applyVueModule() pass that used to set the now-relocated _vueRef.)
  if (_vueOnScopeDispose && typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production') {
    console.warn(
      '[vapor-chamber] tryAutoCleanup: no Vue scope or component instance found. ' +
      'Call dispose() manually or use this composable inside setup() / effectScope().'
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
 * @internal — used by composables that manage bus subscriptions.
 */
export function tryKeepAliveHooks(onPause: () => void, onResume: () => void): void {
  probeVue();
  if (_vueOnDeactivated) {
    try { _vueOnDeactivated(onPause); } catch { /* not in component context */ }
  }
  if (_vueOnActivated) {
    try { _vueOnActivated(onResume); } catch { /* not in component context */ }
  }
}

// ---------------------------------------------------------------------------
// useCommand
// ---------------------------------------------------------------------------

/**
 * useCommand - dispatch commands with reactive loading/error state
 *
 * Auto-cleanup on Vue component unmount or scope disposal.
 */
export function useCommand() {
  const bus = getCommandBus();
  const loading = signal(false);
  const lastError = signal<Error | null>(null);

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

  return { dispatch, loading, lastError };
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
  const bus = options.bus ?? getCommandBus();
  const errorCap = options.errorCap ?? 10;

  let state = _sharedStates.get(bus);
  if (!state) {
    state = {
      inFlight: signal(0),
      isAnyLoading: signal(false),
      lastError: signal<Error | null>(null),
      errors: signal<Error[]>([]),
      errorCount: signal(0),
      refCount: 0,
      errorCap,
    };
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
      result = bus.dispatch(action, target, payload, opts);
    } catch (e) {
      const error = e as Error;
      recordError(error);
      decrement();
      return { ok: false, error, value: undefined };
    }

    if (result && typeof result.then === 'function') {
      return (result as Promise<CommandResult>).then(
        (r) => { if (!r.ok && r.error) recordError(r.error); decrement(); return r; },
        (e: Error) => { recordError(e); decrement(); return { ok: false, error: e, value: undefined }; },
      );
    }

    if (!result.ok && result.error) recordError(result.error);
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

/**
 * useCommandState - create reactive state that updates via commands
 *
 * Auto-cleanup on Vue component unmount or scope disposal.
 */
export function useCommandState<T>(
  initial: T,
  handlers: {
    [action: string]: (state: T, cmd: Command) => T;
  }
) {
  const bus = getCommandBus();
  const state = signal(initial);

  const unregisters: Array<() => void> = [];

  for (const [action, handler] of Object.entries(handlers)) {
    const unregister = bus.register(action, (cmd) => {
      state.value = handler(state.value, cmd);
      return state.value;
    });
    unregisters.push(unregister);
  }

  const dispose = () => {
    unregisters.forEach(fn => fn());
    unregisters.length = 0;
  };

  tryAutoCleanup(dispose);

  return { state, dispose };
}

// ---------------------------------------------------------------------------
// useCommandBus
// ---------------------------------------------------------------------------

/**
 * useCommandBus - lightweight composable wrapper around the shared bus.
 */
export function useCommandBus() {
  return getCommandBus();
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
  const bus = getCommandBus();

  const past = signal<Command[]>([]);
  const future = signal<Command[]>([]);
  const canUndo = signal(false);
  const canRedo = signal(false);

  let paused = false;

  const unsubscribe = bus.onAfter((cmd, result) => {
    if (paused) return;
    if (result.ok && (!filter || filter(cmd))) {
      const newPast = [...past.value, cmd];
      if (newPast.length > maxSize) newPast.shift();
      past.value = newPast;
      future.value = [];
      canUndo.value = true;
      canRedo.value = false;
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
      // Pause tracking so the re-dispatch doesn't double-record
      paused = true;
      try {
        bus.dispatch(cmd.action, cmd.target, cmd.payload);
      } catch (e) {
        console.error(`[vapor-chamber] Redo dispatch error for "${cmd.action}":`, e);
      } finally {
        paused = false;
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
  const bus = getCommandBus();
  const data = signal<any>(null);
  const loading = signal(false);
  const lastError = signal<Error | null>(null);

  function query(action: string, target: any, payload?: any): CommandResult | Promise<CommandResult> {
    loading.value = true;
    lastError.value = null;
    let result: any;
    try {
      result = bus.query(action, target, payload);
    } catch (e) {
      loading.value = false;
      const error = e as Error;
      lastError.value = error;
      return { ok: false, error };
    }

    // Handle async results
    if (result && typeof result.then === 'function') {
      return (result as Promise<CommandResult>).then(
        (r) => {
          loading.value = false;
          if (r.ok) data.value = r.value;
          else lastError.value = r.error ?? null;
          return r;
        },
        (e: Error) => { loading.value = false; lastError.value = e; return { ok: false, error: e }; },
      );
    }

    loading.value = false;
    if (result.ok) data.value = result.value;
    else lastError.value = result.error ?? null;
    return result;
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
  const bus = getCommandBus();
  const cleanups: Array<() => void> = [];

  function prefixed(action: string): string {
    return namespace + action.charAt(0).toUpperCase() + action.slice(1);
  }

  function dispatch(action: string, target: any, payload?: any): CommandResult {
    return bus.dispatch(prefixed(action), target, payload);
  }

  /** Read-only dispatch — skips onBefore hooks, runs handler + plugins, fires afterHooks. */
  function query(action: string, target: any, payload?: any): CommandResult {
    return bus.query(prefixed(action), target, payload);
  }

  /** Fire a namespaced domain event — notifies on() listeners, no handler required. */
  function emit(event: string, data?: any): void {
    bus.emit(prefixed(event), data);
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
    cleanups.forEach(fn => fn());
    cleanups.length = 0;
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
} = {}) {
  const { filter } = options;
  const bus = getCommandBus();

  type ErrorEntry = { cmd: Command; error: Error; timestamp: number };
  const errors = signal<ErrorEntry[]>([]);
  const latestError = signal<Error | null>(null);
  let paused = false;

  const unsubscribe = bus.onAfter((cmd, result) => {
    if (paused) return;
    if (!result.ok && result.error) {
      if (!filter || filter(cmd)) {
        latestError.value = result.error;
        errors.value = [...errors.value, { cmd, error: result.error, timestamp: Date.now() }];
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
