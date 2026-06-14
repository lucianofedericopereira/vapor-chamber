/**
 * vapor-chamber - Vue Vapor integration
 *
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
// Vue 3.6.0-beta.10+ Vapor APIs
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
/** @internal — Vue's DEEP ref(), for the vapor-chamber/reactive companion only.
 *  Returns null until Vue detection completes (or if Vue is absent). */
export function getVueDeepRefFn(): (<T>(v: T) => { value: T }) | null { return _vueDeepRefFn; }

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
 */
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
    typeof process !== 'undefined' &&
    process.env?.NODE_ENV !== 'production'
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
// and useVaporCommand (chamber-vapor.ts). Accepts a thunk so the bus call is
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
    result = busCall();
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
 * useCommand - dispatch commands with reactive loading/error state
 *
 * Auto-cleanup on Vue component unmount or scope disposal.
 */
export function useCommand() {
  const bus = getCommandBus();
  const loading = signal(false);
  const lastError = signal<Error | null>(null);

  function dispatch(action: string, target: any, payload?: any): CommandResult | Promise<CommandResult> {
    return runDispatch(() => bus.dispatch(action, target, payload), loading, lastError);
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
  const bus = options.bus ?? getCommandBus();
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
    // useVaporCommand, useCommand, raw bus.dispatch, anywhere — lands in the
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
      result = bus.dispatch(action, target, payload, opts);
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
  const bus = getCommandBus();
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
