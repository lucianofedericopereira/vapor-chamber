/**
 * vapor-chamber - Vue Vapor integration
 *
 * v0.4.1 — Added: useCommandGroup (namespace isolation), useCommandError (error boundary).
 * v0.4.0 — Vue 3.6 Vapor alignment: onScopeDispose, Vapor detection,
 *           defineVaporCommand, createVaporChamberApp.
 * v0.3.0 — Fixed: signal shim, resetCommandBus, auto-cleanup on Vue unmount.
 */

import { createCommandBus, type CommandBus, type Command, type CommandResult, type Handler, type Plugin, type RegisterOptions, type Listener } from './command-bus';

// ---------------------------------------------------------------------------
// Signal abstraction
// ---------------------------------------------------------------------------

export type Signal<T> = { value: T };
export type CreateSignal = <T>(initial: T) => Signal<T>;

/**
 * Signal implementation with Vue auto-detection.
 *
 * Priority:
 * 1. User-configured signal via configureSignal() — highest priority
 * 2. Vue ref() from import('vue') — works in VDOM, Vapor, and mixed trees
 * 3. Plain getter/setter fallback — Node/test environments
 *
 * Under Vue 3.6+ (alien-signals), ref() is backed by fine-grained signals
 * internally. No separate signal API is needed — ref() IS the signal.
 */
let _vueRef: ((initial: any) => any) | null = null;
let _vueOnUnmounted: ((fn: () => void) => void) | null = null;
let _vueOnScopeDispose: ((fn: () => void) => void) | null = null;
let _vueGetCurrentInstance: (() => any) | null = null;
let _vueProbed = false;

// Vue 3.6+ Vapor detection
let _hasVapor = false;
let _createVaporAppFn: any = null;
let _vaporInteropPluginRef: any = null;

/** Promise that resolves once Vue detection is complete. Await this in composables
 *  that need Vue APIs to be available before first use. */
let _probePromise: Promise<void> | null = null;

function applyVueModule(vue: any): void {
  if (vue && typeof vue.ref === 'function') {
    _vueRef = vue.ref;
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

  // Vue 3.6+ Vapor detection
  if (vue && typeof vue.createVaporApp === 'function') {
    _hasVapor = true;
    _createVaporAppFn = vue.createVaporApp;
  }
  if (vue && typeof vue.vaporInteropPlugin !== 'undefined') {
    _vaporInteropPluginRef = vue.vaporInteropPlugin;
  }
}

function probeVue(): void {
  if (_vueProbed) return;
  _vueProbed = true;

  // 1. Synchronous probe: check globalThis.__VUE__ (set by Vue devtools or bundler)
  //    This gives immediate availability for signal() calls at module init time.
  if (typeof globalThis !== 'undefined' && (globalThis as any).__VUE__) {
    try {
      // If Vue is already loaded (common in Blade/MPA setups), try synchronous require
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

const fallbackSignal: CreateSignal = <T>(initial: T): Signal<T> => {
  probeVue();

  if (_vueRef) {
    // Use Vue ref() for real reactivity — in 3.6+ this is alien-signals backed
    return _vueRef(initial) as Signal<T>;
  }

  // Plain getter/setter — works in Node/test environments
  let _value = initial;
  return {
    get value() { return _value; },
    set value(v: T) { _value = v; }
  };
};

let _signalFn: CreateSignal = fallbackSignal;

/**
 * Configure the signal factory used by vapor-chamber composables.
 * Call this once at app setup when Vue Vapor's signal API is available.
 *
 * In Vue 3.6+, ref() is already backed by alien-signals, so this is only
 * needed if you want to use a completely custom signal implementation.
 *
 * @example
 * import { ref } from 'vue';
 * import { configureSignal } from 'vapor-chamber';
 * configureSignal(ref); // explicit — usually auto-detected
 */
export function configureSignal(fn: CreateSignal): void {
  _signalFn = fn;
}

export const signal: CreateSignal = <T>(initial: T) => _signalFn(initial);

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
  if (_vueRef && typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production') {
    console.warn(
      '[vapor-chamber] tryAutoCleanup: no Vue scope or component instance found. ' +
      'Call dispose() manually or use this composable inside setup() / effectScope().'
    );
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

  function dispatch(action: string, target: any, payload?: any): CommandResult {
    loading.value = true;
    lastError.value = null;
    const result = bus.dispatch(action, target, payload);
    loading.value = false;
    if (!result.ok) lastError.value = result.error ?? null;
    return result;
  }

  return { dispatch, loading, lastError };
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

  const unsubscribe = bus.onAfter((cmd, result) => {
    if (result.ok && (!filter || filter(cmd))) {
      const newPast = [...past.value, cmd];
      if (newPast.length > maxSize) newPast.shift();
      past.value = newPast;
      future.value = [];
      canUndo.value = true;
      canRedo.value = false;
    }
  });

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

  return { dispatch, register, use, on, namespace, dispose };
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

  const unsubscribe = bus.onAfter((cmd, result) => {
    if (!result.ok && result.error) {
      if (!filter || filter(cmd)) {
        latestError.value = result.error;
        errors.value = [...errors.value, { cmd, error: result.error, timestamp: Date.now() }];
      }
    }
  });

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
