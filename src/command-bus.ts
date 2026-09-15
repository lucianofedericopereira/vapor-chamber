/**
 * vapor-chamber - Command Bus for Vue Vapor
 *
 * Sizes are not quoted here. This header carried "~3.6 KB brotli core" while
 * the generated table measured 4.2 - a hand-typed number in a source file that
 * no generator can reach and no gate can check. `docs/BUNDLE-SIZES.md` is
 * regenerated every run and is the only place a size should be read from.
 * DevTools is loaded dynamically.
 */

// ---------------------------------------------------------------------------
// Structured error codes - machine-readable, LLM-friendly, i18n-ready
// ---------------------------------------------------------------------------

/**
 * Severity level for bus diagnostics.
 * - `'error'`: dispatch failed, result.ok === false
 * - `'warn'`: recoverable issue, dispatch may succeed (e.g. naming violation)
 * - `'info'`: informational (e.g. handler overwrite, circuit breaker state change)
 */
import { DEV } from './dev';
import { dict } from './dict';
export type BusSeverity = 'error' | 'warn' | 'info';

/**
 * Emitter tag - which subsystem produced the diagnostic.
 * Allows filtering/routing in logging and monitoring.
 */
export type BusEmitter =
  | 'core'           // command-bus.ts dispatch/query/emit path
  | 'plugin'         // plugin pipeline (cache, circuitBreaker, rateLimit, etc.)
  | 'hook'           // onBefore/onAfter hooks
  | 'listener'       // on()/once() pattern listeners
  | 'transport'      // HTTP/WS/SSE bridges
  | 'form'           // FormBus validation
  | 'schema'         // Schema/LLM layer
  | 'workflow'       // createWorkflow compensation
  | 'test';          // TestBus

/**
 * Structured error code enum. Every error in vapor-chamber has a unique code.
 *
 * Naming: `VC_{EMITTER}_{DESCRIPTION}` - VC = vapor-chamber prefix.
 *
 * @example
 * if (result.error instanceof BusError) {
 *   switch (result.error.code) {
 *     case 'VC_CORE_NO_HANDLER':    // register a handler
 *     case 'VC_CORE_BEFORE_CANCEL': // a beforeHook threw
 *     case 'VC_PLUGIN_CIRCUIT_OPEN': // circuit breaker tripped
 *   }
 * }
 */
export type BusErrorCode =
  // Core
  | 'VC_CORE_NO_HANDLER'          // No handler registered for action
  | 'VC_CORE_HANDLER_THREW'       // Handler threw an exception
  | 'VC_CORE_BEFORE_CANCEL'       // A beforeHook threw to cancel dispatch
  | 'VC_CORE_NAMING_VIOLATION'    // Action name doesn't match naming pattern
  | 'VC_CORE_HANDLER_OVERWRITE'   // Handler replaced without unregister
  | 'VC_CORE_REQUEST_TIMEOUT'     // request() timed out
  | 'VC_CORE_THROTTLED'           // Handler throttled, retry later
  | 'VC_CORE_MAX_DEPTH'           // Recursive dispatch depth exceeded
  | 'VC_CORE_SEALED'              // Mutation attempted on a sealed bus
  | 'VC_CORE_ABORTED'             // Dispatch aborted via signal (AbortController)
  // Plugins
  | 'VC_PLUGIN_CIRCUIT_OPEN'      // Circuit breaker is open
  | 'VC_PLUGIN_RATE_LIMITED'      // Rate limit exceeded
  | 'VC_PLUGIN_THREW'             // A plugin threw or rejected in its own body (a pipeline bug; not retryable)
  | 'VC_PLUGIN_CACHE_MISS'        // Cache miss (info-level, not an error)
  | 'VC_VALIDATION_FAILED'        // Schema / per-action validation rejected the dispatch
  // Workflow
  | 'VC_WORKFLOW_STEP_FAILED'     // A workflow step failed, compensating
  | 'VC_WORKFLOW_COMPENSATE_FAILED' // Compensation step also failed
  // Hooks/Listeners
  | 'VC_HOOK_ERROR'               // afterHook threw (logged, not fatal)
  | 'VC_LISTENER_ERROR'           // on() listener threw (logged, not fatal)
  // Generic
  | 'VC_UNKNOWN';                 // Unclassified error

/**
 * BusError - structured error with machine-readable code, severity, and emitter.
 *
 * Extends native Error so it works everywhere errors work (catch, result.error, etc.).
 * The `code` field enables switch-based handling, the `severity` enables log filtering,
 * and the `emitter` enables source-based routing.
 *
 * @example
 * const result = bus.dispatch('missing', {});
 * if (!result.ok && result.error instanceof BusError) {
 *   console.log(result.error.code);     // 'VC_CORE_NO_HANDLER'
 *   console.log(result.error.severity); // 'error'
 *   console.log(result.error.emitter);  // 'core'
 *   console.log(result.error.action);   // 'missing'
 * }
 */
export class BusError extends Error {
  /** Machine-readable error code for switch/lookup. */
  declare readonly code: BusErrorCode;
  /** Severity: error, warn, or info. */
  declare readonly severity: BusSeverity;
  /** Which subsystem produced this error. */
  declare readonly emitter: BusEmitter;
  /** The action name involved (if applicable). */
  declare readonly action?: string;
  /** Additional context (e.g. retryIn for throttle, threshold for circuit breaker). */
  declare readonly context?: Record<string, unknown>;

  constructor(
    code: BusErrorCode,
    message: string,
    opts: {
      severity?: BusSeverity;
      emitter?: BusEmitter;
      action?: string;
      context?: Record<string, unknown>;
      cause?: Error;
    } = {},
  ) {
    super(message, opts.cause ? { cause: opts.cause } : undefined);
    this.code = code;
    this.severity = opts.severity ?? 'error';
    this.emitter = opts.emitter ?? 'core';
    this.action = opts.action;
    this.context = opts.context;
    this.name = 'BusError';
  }
}

/**
 * BusError codes that mark transient failures - safe to retry.
 *
 * Deliberately a tiny standalone set (not a registry lookup): the full
 * ERROR_CODE_REGISTRY lives in the schema/LLM layer, which retry() consumers
 * must not pull into their bundles. tests/schema.test.ts asserts this set
 * stays in sync with the registry's `retryable: true` entries.
 *
 * @example
 * if (result.error instanceof BusError && RETRYABLE_CODES.has(result.error.code)) {
 *   // transient - safe to re-dispatch
 * }
 */
export const RETRYABLE_CODES: ReadonlySet<string> = new Set([
  'VC_CORE_HANDLER_THREW',
  'VC_CORE_REQUEST_TIMEOUT',
  'VC_CORE_THROTTLED',
  'VC_PLUGIN_CIRCUIT_OPEN',
  'VC_PLUGIN_RATE_LIMITED',
  'VC_UNKNOWN',
]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Automatic metadata stamped on every command. */
export type CommandMeta = {
  /**
   * Wall-clock stamp for correlation and audit - NOT a timing instrument.
   *
   * Read from `Date.now()` **once per microtask turn** and shared by every
   * command dispatched inside that turn. The first command of each turn carries
   * an exact stamp; the 2nd..nth of the same synchronous run repeat it. Since
   * `Date.now()` is millisecond-resolution and a typical burst is
   * sub-millisecond, those commands would almost always have received the same
   * number anyway - what is actually given up is intra-burst resolution in
   * bursts long enough to cross a millisecond (a thousand-command `rehydrate`
   * reads as instantaneous). Bought ~15-25ns per dispatch; measured in
   * `tests/clock-source-ab.test.ts`.
   *
   * **Ordering does not depend on this field.** `meta.id` is a monotonic
   * counter and stays unique and ordered - use it, not `ts`, to sequence
   * commands.
   *
   * **Do not measure durations with it, cached or not.** `Date.now()` is wall
   * clock: millisecond-resolution and *not monotonic*, so an NTP correction or
   * a clock change can move it, backwards included. That was true before this
   * cache and is not a consequence of it. For real timing use
   * `performance.now()` in a plugin; on a hot loop use `createFastLane()`,
   * which stamps no meta at all.
   */
  ts: number;
  /**
   * Unique, monotonically increasing command ID - the ordering key.
   *
   * Default generator: a per-process random prefix plus an incrementing
   * counter (`configureUid` swaps it; `crypto.randomUUID` is the documented
   * opt-in for cross-process auditing, and is NOT the default - this line used
   * to say it was, contradicting the `ts` field above, which correctly calls
   * `id` a monotonic counter).
   */
  id: string;
  /** ID of the command that caused this one (set manually via payload.__causationId). */
  causationId?: string;
  /** Correlation ID for tracing a chain of commands (propagates from parent). */
  correlationId?: string;
  /**
   * Idempotency key stamped by the `idempotent` plugin. Transports (e.g. the
   * HTTP bridge) forward it as an `Idempotency-Key` header so the backend can
   * reject duplicate writes. Not set by default - only when `idempotent` runs.
   */
  idempotencyKey?: string;
  /**
   * Where the command originated. `undefined` (the default) means local user
   * code called dispatch directly. The core never sets this field - dispatchers
   * that proxy external traffic (bridges, sync layers, replay tooling, agent
   * endpoints) stamp it post-hoc via plugins so downstream plugins, hooks, and
   * listeners can distinguish local intent from mirrored or machine-driven
   * commands (e.g. skip re-broadcasting a `'sync'` command, or audit-log
   * everything marked `'agent'`).
   *
   * Well-known values: `'user'`, `'remote'`, `'sync'`, `'replay'`, `'agent'` -
   * but any string is accepted for custom origins. Since v1.20.0 the core does
   * stamp two of its own: `'undo'` on every dispatch made synchronously inside
   * an undo handler and `'redo'` on a redo and what its handler dispatches
   * (`_withOriginScope`); the history plugin and `useCommandHistory` record
   * neither.
   *
   * @example
   * bus.use((cmd, next) => {
   *   if (cmd.meta?.origin === 'agent') console.info('LLM-driven:', cmd.action);
   *   return next();
   * });
   */
  origin?: 'user' | 'remote' | 'sync' | 'replay' | 'agent' | 'undo' | 'redo' | (string & {});
};

export type Command<A extends string = string, T = any, P = any> = {
  action: A;
  target: T;
  payload?: P;
  /** Auto-stamped metadata - timestamp, unique id, correlation/causation tracing.
   *  Always present on commands from dispatch/query/emit. Optional on manually constructed commands. */
  meta?: CommandMeta;
  /**
   * AbortSignal forwarded by `bus.dispatch(..., { signal })`. Async handlers
   * may listen to `cmd.signal.aborted` / `cmd.signal.addEventListener('abort', ...)`
   * to short-circuit work; transport plugins (HTTP) auto-propagate it to the
   * underlying fetch / xhr. Sync bus paths ignore this field - sync dispatch
   * is atomic and not cancelable.
   */
  signal?: AbortSignal;
};

/** Optional per-dispatch options. Currently: `{ signal }` for cancellation. */
export type DispatchOptions = {
  /** Abort the dispatch before it starts (if already aborted) or signal async
   *  handlers and transports to cancel mid-flight. Async bus only. */
  signal?: AbortSignal;
};

/**
 * Result of a dispatch/query - a discriminated union on `ok`.
 *
 * `if (result.ok)` narrows away `error`; on the failure arm `error` is a
 * guaranteed `Error` (no `!` or `?.` needed). `value` stays optional on the
 * success arm because void commands legitimately produce no value.
 */
export type CommandResult<V = any> =
  | { ok: true; value?: V; error?: undefined }
  | { ok: false; error: Error; value?: undefined };

export type Handler<T = any, P = any, R = any> = (cmd: Command<string, T, P>) => R;
export type AsyncHandler<T = any, P = any, R = any> = (cmd: Command<string, T, P>) => Promise<R>;
/** A plugin that owns timers or connections may carry `dispose()`: the bus's dispose() runs it
 *  (since v1.20.0; debounce, throttle and retry do). */
export type Plugin = ((cmd: Command, next: () => CommandResult) => CommandResult) & { dispose?: () => void };
export type AsyncPlugin = ((cmd: Command, next: () => CommandResult | Promise<CommandResult>) => CommandResult | Promise<CommandResult>) & { dispose?: () => void };
export type Hook = (cmd: Command, result: CommandResult) => void;
export type AsyncHook = (cmd: Command, result: CommandResult) => void | Promise<void>;
/** Fires before the handler runs. Throw to cancel the dispatch (returns `{ ok: false }`).
 *  Since v1.20.0 the error is a `VC_CORE_BEFORE_CANCEL` BusError with your throw as `cause`
 *  and as its message; a thrown BusError passes through as itself. */
export type BeforeHook = (cmd: Command) => void;
/** Fires before the handler runs on an async bus. Throw or reject to cancel.
 *  The error is a `VC_CORE_BEFORE_CANCEL` BusError as for `BeforeHook`. */
export type AsyncBeforeHook = (cmd: Command) => void | Promise<void>;

/** Options for plugin registration. Higher priority runs first (outermost). Default: 0. */
export type PluginOptions = { priority?: number };

/** Batch dispatch input */
export type BatchCommand = { action: string; target: any; payload?: any };

/** Options for batch dispatch */
export type BatchOptions = {
  continueOnError?: boolean;
  /**
   * All-or-nothing semantics: if any command fails, automatically run the
   * registered undo handler for every command that already succeeded (in reverse order).
   * Requires undo handlers to be registered via `register(action, handler, { undo })`.
   * Commands without an undo handler are skipped during rollback.
   * Mutually exclusive with `continueOnError`.
   */
  transactional?: boolean;
  /**
   * AbortSignal applied to the whole batch. Aborting before the batch starts
   * skips it entirely; aborting mid-flight stops further commands from
   * dispatching (the in-flight one runs to completion since per-command
   * abort already happened or is the handler's responsibility) and the
   * batch result is
   * `{ ok: false, error: BusError('VC_CORE_ABORTED'), results: [...partial] }`
   * - a BusError rather than the raw DOMException so the code is queryable
   * (see `abortedResult`; a caller-supplied `signal.reason` is passed through
   * unchanged). Under `transactional`, rollback runs first and
   * `successCount` is reported as 0.
   * Async bus only - sync `dispatchBatch` accepts the option for type
   * uniformity but ignores it.
   */
  signal?: AbortSignal;
};

/** Result of a batch dispatch */
export type BatchResult = {
  ok: boolean;
  results: CommandResult[];
  error?: Error;
  /** Number of commands that completed successfully */
  successCount: number;
  /** Number of commands that failed */
  failCount: number;
  /** Results of undo handlers run during transactional rollback (reverse order). Only present when `transactional: true` and a command failed. */
  rollbacks?: CommandResult[];
};

/**
 * Dead letter mode - what to do when a command has no registered handler.
 * - `'error'` (default): returns `{ ok: false, error }`
 * - `'throw'`: throws the error
 * - `'ignore'`: returns `{ ok: true, value: undefined }`
 * - `'buffer'`: queue the command (per action, FIFO) and replay it - in order -
 *   the moment a handler for that action is `register()`-ed. Built for
 *   lazy/async wiring where a command can be dispatched before its handler
 *   exists (e.g. Astro/island hydration, code-split panels): the click isn't
 *   lost, it fires when the handler arrives. The synchronous dispatch returns
 *   `{ ok: true, value: undefined }` (the real handler runs later). `query`
 *   never buffers (it must return a value) - it falls back to `'error'`.
 *   Bounded by `bufferLimit` (drop-oldest + dev warning on overflow).
 * - function: called with the command, return value used as result
 */
export type DeadLetterMode = 'error' | 'throw' | 'ignore' | 'buffer' | ((cmd: Command) => CommandResult);

/**
 * Naming convention configuration.
 * Enforces a regex pattern on action names at register and dispatch time.
 */
export type NamingConvention = {
  /** Regex pattern that action names must match */
  pattern: RegExp;
  /** What to do on violation: 'warn' logs, 'throw' throws, 'ignore' skips */
  onViolation?: 'warn' | 'throw' | 'ignore';
};

/** Per-command registration options */
export type RegisterOptions = {
  /** Throttle this handler: execute immediately, then block for N ms. */
  throttle?: number;
  /** Inverse handler for undo support. Called with the original command. */
  undo?: Handler;
};

export type CommandBusOptions = {
  onMissing?: DeadLetterMode;
  /** Enforce naming convention on action names */
  naming?: NamingConvention;
  /**
   * Max commands buffered per action when `onMissing: 'buffer'`. When exceeded,
   * the oldest queued command for that action is dropped (with a dev warning).
   * Default: 256.
   */
  bufferLimit?: number;
  /**
   * Max age (ms) a buffered command may wait for its handler when
   * `onMissing: 'buffer'`. Expired entries are reaped lazily - on the next
   * buffer push for that action and at flush time - so a handler that never
   * arrives (e.g. an island that fails to hydrate) cannot pin stale commands
   * in memory indefinitely. Default: no TTL (entries wait until `bufferLimit`
   * pushes them out).
   */
  bufferTTL?: number;
  /**
   * Called when `onMissing: 'buffer'` drops a queued command - either because
   * the per-action queue hit `bufferLimit` (oldest dropped) or because the
   * entry outlived `bufferTTL`. Use for observability: without this, drops are
   * only visible as dev-mode console warnings.
   */
  onBufferOverflow?: (action: string, dropped: { target: any; payload: any }) => void;
};

/** Listener callback for on() subscriptions (wildcard-capable) */
export type Listener = (cmd: Command, result: CommandResult) => void;

/**
 * Options for `on()`/`once()` subscriptions.
 * The returned unsubscribe function also carries `Symbol.dispose`, so
 * `using off = bus.on(...)` works without an explicit `off()` call.
 */
export type ListenerOptions = {
  /** Auto-unsubscribe when the signal aborts. Already-aborted at call time
   *  means the listener is never added - matches DOM `addEventListener`. */
  signal?: AbortSignal;
};

/**
 * Typed command map - define action names, target, payload, and result shapes.
 * Use with createCommandBus<MyMap>() for type-safe dispatch and register.
 *
 * @example
 * type AppCommands = {
 *   cartAdd: { target: { id: number }; payload: { qty: number }; result: void };
 *   cartClear: { target: {}; result: number };
 * };
 * const bus = createCommandBus<AppCommands>();
 * bus.dispatch('cartAdd', { id: 1 }, { qty: 2 }); // fully typed
 */
export type CommandMap = Record<string, { target?: any; payload?: any; result?: any }>;

/** Extract the target type for action A from a CommandMap. Used in typed bus interfaces. */
export type TargetOf<M extends CommandMap, A extends keyof M> = M[A] extends { target: infer T } ? T : any;
/** Extract the payload type for action A from a CommandMap. */
export type PayloadOf<M extends CommandMap, A extends keyof M> = M[A] extends { payload: infer P } ? P : any;
/** Extract the result type for action A from a CommandMap. */
export type ResultOf<M extends CommandMap, A extends keyof M> = M[A] extends { result: infer R } ? R : any;

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

/**
 * Structural base interface for both sync and async buses.
 * Use this as the parameter type in utilities (createChamber, createWorkflow, etc.)
 * to avoid `as any` casts when working with either bus variant.
 */
export interface BaseBus {
  dispatch(action: string, target: any, payload?: any, options?: DispatchOptions): any;
  /** Read-only dispatch - skips beforeHooks, runs handler + plugins, fires afterHooks. No mutation intent. */
  query(action: string, target: any, payload?: any): any;
  /** Fire a domain event - notifies on() listeners, no handler required, no result returned. */
  emit(event: string, data?: any): void;
  register(action: string, handler: any, options?: RegisterOptions): () => void;
  use(plugin: any, options?: PluginOptions): () => void;
  /** Subscribe before dispatch. Throw to cancel (returns `{ ok: false }`, its error a
   *  `VC_CORE_BEFORE_CANCEL` BusError carrying the throw as `cause` since v1.20.0). */
  onBefore(hook: any): () => void;
  onAfter(hook: any): () => void;
  on(pattern: string, listener: Listener, options?: ListenerOptions): () => void;
  once(pattern: string, listener: Listener, options?: ListenerOptions): () => void;
  /** Remove all `on()` listeners matching the given pattern, or all listeners if omitted. */
  offAll(pattern?: string): void;
  hasHandler(action: string): boolean;
  /** Returns all registered action names. Useful for introspection and DevTools. */
  registeredActions(): string[];
  clear(): void;
  /**
   * Full teardown - calls clear() and cancels all pending timers/requests. Use in SSR or component-scoped buses.
   * Since v1.20.0 "requests" holds: a request() still waiting on its responder settles at once as
   * VC_CORE_ABORTED with its timer cleared; the responder is not told (only the caller's own signal
   * reaches cmd.signal, on the async bus). There is no disposed state - the bus stays usable - and
   * dispose() works on a sealed bus, which stays sealed. It also runs each installed plugin's
   * `dispose()` first (debounce, throttle and retry own timers), before the plugins are dropped.
   */
  dispose(): void;
  /**
   * Seal the bus - prevents further register(), use(), onBefore(), onAfter(), respond() calls.
   * Dispatch, query, emit, on(), once() still work - seal protects the handler/plugin topology,
   * not the observation layer. Listeners via on()/once() can still subscribe after seal.
   * Call after app initialization to lock down the graph in production. Throws BusError
   * with code 'VC_CORE_SEALED' on any mutation attempt. Cleared by clear() for HMR compat.
   * (Superseded in v1.20.0: clear() is a mutation too and throws on a sealed bus, since it
   * would delete the undo handlers and plugins the seal commits. For HMR, call unsealBus()
   * first, then clear(), as unsealBus's example shows. dispose() still works on a sealed
   * bus and leaves it sealed.)
   */
  seal(): void;
  /** Returns true if the bus has been sealed. */
  isSealed(): boolean;
}

export interface CommandBus<M extends CommandMap = CommandMap> extends BaseBus {
  /**
   * Sync dispatch. The optional `options.signal` is accepted for type
   * compatibility with `AsyncCommandBus` but **ignored at runtime** - sync
   * dispatches are atomic and not cancelable. Pass a signal here only if
   * you also use the async bus and want a uniform call site.
   */
  dispatch<A extends keyof M & string>(
    action: A,
    target: TargetOf<M, A>,
    payload?: PayloadOf<M, A>,
    options?: DispatchOptions,
  ): CommandResult<ResultOf<M, A>>;
  /** Read-only dispatch - skips beforeHooks (no mutation gating), runs handler + plugins, fires afterHooks. */
  query<A extends keyof M & string>(action: A, target: TargetOf<M, A>, payload?: PayloadOf<M, A>): CommandResult<ResultOf<M, A>>;
  /** Fire a domain event - notifies on() listeners, no handler required, no result. */
  emit(event: string, data?: any): void;
  dispatchBatch(commands: BatchCommand[], options?: BatchOptions): BatchResult;
  register<A extends keyof M & string>(action: A, handler: (cmd: Command<A, TargetOf<M, A>, PayloadOf<M, A>>) => ResultOf<M, A>, options?: RegisterOptions): () => void;
  use(plugin: Plugin, options?: PluginOptions): () => void;
  /** Subscribe before dispatch. Throw to cancel - dispatch returns `{ ok: false }`. */
  onBefore(hook: BeforeHook): () => void;
  onAfter(hook: Hook): () => void;
  on(pattern: string, listener: Listener, options?: ListenerOptions): () => void;
  /** Subscribe to the first matching command only; auto-unsubscribes after it fires. */
  once(pattern: string, listener: Listener, options?: ListenerOptions): () => void;
  offAll(pattern?: string): void;
  /**
   * Request/response: a responder answers, a timeout (default 5000 ms) bounds the wait, and
   * `signal` settles the request - before the responder runs if already aborted, at once if
   * aborted while waiting. The sync command carries no signal (see Command.signal), so the
   * responder is not told; without a responder this is a dispatch.
   */
  request<A extends keyof M & string>(action: A, target: TargetOf<M, A>, payload?: PayloadOf<M, A>, options?: { timeout?: number; signal?: AbortSignal }): Promise<CommandResult<ResultOf<M, A>>>;
  respond(action: string, handler: (cmd: Command) => any | Promise<any>): () => void;
  /** Returns true if a handler is registered for the given action. */
  hasHandler(action: string): boolean;
  /** Returns all registered action names. */
  registeredActions(): string[];
  /**
   * @internal Used by the history plugin to retrieve an undo handler registered alongside
   * a command handler. Do not call this from application code - it will be moved to a
   * plugin-private channel in a future release.
   */
  getUndoHandler(action: string): Handler | undefined;
  /** Remove all handlers, plugins, hooks, and listeners. Useful for testing and HMR. */
  clear(): void;
  /** Freeze configuration - rejects register/use/clear after sealing. */
  seal(): void;
  /** Returns true if the bus is sealed. */
  isSealed(): boolean;
  /**
   * Clean teardown - clears state, cancels timers, marks bus as disposed.
   * (Superseded in v1.20.0: there is no disposed state - the bus stays usable after dispose().
   * It cancels throttle timers and settles pending request()s as VC_CORE_ABORTED.)
   */
  dispose(): void;
}

export interface AsyncCommandBus<M extends CommandMap = CommandMap> extends BaseBus {
  /**
   * Async dispatch with optional `AbortSignal`. If `options.signal` is already
   * aborted at call time, resolves immediately with `{ ok: false, error: AbortError }`
   * without invoking the handler. If aborted mid-flight, the handler observes
   * `cmd.signal.aborted === true`; HTTP transport plugins propagate the signal
   * to the underlying fetch automatically.
   */
  dispatch<A extends keyof M & string>(
    action: A,
    target: TargetOf<M, A>,
    payload?: PayloadOf<M, A>,
    options?: DispatchOptions,
  ): Promise<CommandResult<ResultOf<M, A>>>;
  /** Read-only dispatch - skips beforeHooks (no mutation gating), runs handler + plugins, fires afterHooks. */
  query<A extends keyof M & string>(action: A, target: TargetOf<M, A>, payload?: PayloadOf<M, A>): Promise<CommandResult<ResultOf<M, A>>>;
  /** Fire a domain event - notifies on() listeners, no handler required, no result. */
  emit(event: string, data?: any): void;
  dispatchBatch(commands: BatchCommand[], options?: BatchOptions): Promise<BatchResult>;
  register<A extends keyof M & string>(action: A, handler: (cmd: Command<A, TargetOf<M, A>, PayloadOf<M, A>>) => Promise<ResultOf<M, A>>, options?: RegisterOptions): () => void;
  use(plugin: AsyncPlugin, options?: PluginOptions): () => void;
  /** Subscribe before dispatch. Throw or reject to cancel - dispatch returns `{ ok: false }`. */
  onBefore(hook: AsyncBeforeHook): () => void;
  onAfter(hook: AsyncHook): () => void;
  on(pattern: string, listener: Listener, options?: ListenerOptions): () => void;
  /** Subscribe to the first matching command only; auto-unsubscribes after it fires. */
  once(pattern: string, listener: Listener, options?: ListenerOptions): () => void;
  offAll(pattern?: string): void;
  /**
   * Request/response: a responder answers, a timeout (default 5000 ms) bounds the wait, identical
   * in-flight requests share one promise, and `signal` settles the request and reaches the
   * responder on cmd.signal; without a responder this is a dispatch.
   */
  request<A extends keyof M & string>(action: A, target: TargetOf<M, A>, payload?: PayloadOf<M, A>, options?: { timeout?: number; signal?: AbortSignal }): Promise<CommandResult<ResultOf<M, A>>>;
  respond(action: string, handler: (cmd: Command) => any | Promise<any>): () => void;
  /** Returns true if a handler is registered for the given action. */
  hasHandler(action: string): boolean;
  /** Returns all registered action names. */
  registeredActions(): string[];
  /**
   * @internal Used by the history plugin to retrieve an undo handler registered alongside
   * a command handler. Do not call this from application code - it will be moved to a
   * plugin-private channel in a future release.
   */
  getUndoHandler(action: string): Handler | undefined;
  /** Remove all handlers, plugins, hooks, and listeners. Useful for testing and HMR. */
  clear(): void;
  /** Freeze configuration - rejects register/use/clear after sealing. */
  seal(): void;
  /** Returns true if the bus is sealed. */
  isSealed(): boolean;
  /**
   * Clean teardown - clears state, cancels timers, marks bus as disposed.
   * (Superseded in v1.20.0: there is no disposed state - the bus stays usable after dispose().
   * It cancels throttle timers and settles pending request()s as VC_CORE_ABORTED.)
   */
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Internal state types
// ---------------------------------------------------------------------------

/** Max nested dispatch depth - prevents infinite loops from reactions/listeners re-dispatching. */
const MAX_DISPATCH_DEPTH = 16;



/**
 * @internal Symbol used by unsealBus() - not on the public interface.
 * Exported, underscored like `_stampMeta`, so createTestBus carries it too:
 * unsealBus() reopens a sealed TestBus as it reopens a real bus. No package
 * entry re-exports it.
 */
export const _UNSEAL = Symbol('vapor-chamber:unseal');

/** @internal Symbol used by inspectBus() - not on the public interface. */
const _INSPECT = Symbol('vapor-chamber:inspect');

/** Guard: throw if the bus is sealed. */
function assertNotSealed(s: { sealed: boolean }, method: string): void {
  if (s.sealed) throw new BusError('VC_CORE_SEALED', `Cannot call ${method}() on a sealed bus. The bus was sealed with bus.seal() to prevent runtime mutations.`, { emitter: 'core' });
}

type SyncState = {
  readonly opts: CommandBusOptions;
  handlers: Map<string, Handler>;
  undoHandlers: Map<string, Handler>;
  pluginEntries: Array<{ plugin: Plugin; priority: number }>;
  beforeHooks: BeforeHook[];
  afterHooks: Hook[];
  /** Exact-match listeners - O(1) lookup on the hot path. Action-keyed. */
  exactListeners: Map<string, Listener[]>;
  /** Wildcard listeners ('*' or 'foo*') - walked per dispatch with a precomputed prefix (WildcardEntry). */
  wildcardListeners: WildcardEntry[];
  responders: Map<string, (cmd: Command) => any | Promise<any>>;
  runner: (cmd: Command, execute: () => CommandResult) => CommandResult;
  /** Current nested dispatch depth - guards against infinite recursion. */
  dispatchDepth: number;
  /** When true, register/use/onBefore/onAfter/respond throw. */
  sealed: boolean;
  /** Per-instance throttle timers - dispose() cancels only this bus's timers. */
  throttleTimers: Set<ReturnType<typeof setTimeout>>;
  /** onMissing:'buffer' queue - per-action FIFO of {target,payload}, replayed on
   *  register(). Lazily null unless onMissing:'buffer' is configured, so non-buffer
   *  buses don't allocate it. */
  deferred: Map<string, Array<{ target: any; payload: any; at: number }>> | null;
  /** One cancel per request() still waiting on its responder. dispose() runs them, so
   *  each settles at once as VC_CORE_ABORTED with its timer cleared, and polices nothing
   *  afterwards - no disposed state, as Vue 3.6 rc.8's EffectScope.stop() has none.
   *  Lazily null until the first such request, like `deferred`. */
  waiting: Set<() => void> | null;
};

type AsyncState = {
  readonly opts: CommandBusOptions;
  handlers: Map<string, AsyncHandler>;
  undoHandlers: Map<string, Handler>;
  pluginEntries: Array<{ plugin: AsyncPlugin; priority: number }>;
  beforeHooks: AsyncBeforeHook[];
  afterHooks: AsyncHook[];
  /** Exact-match listeners - O(1) lookup on the hot path. Action-keyed. */
  exactListeners: Map<string, Listener[]>;
  /** Wildcard listeners ('*' or 'foo*') - walked per dispatch with a precomputed prefix (WildcardEntry). */
  wildcardListeners: WildcardEntry[];
  responders: Map<string, (cmd: Command) => any | Promise<any>>;
  runner: (cmd: Command, execute: () => Promise<CommandResult>) => Promise<CommandResult>;
  /** Per-instance dedup map for in-flight async requests - avoids module-level singleton leak in SSR. */
  pendingRequests: Map<string, Promise<CommandResult>>;
  /** Current nested dispatch depth - guards against infinite recursion. */
  dispatchDepth: number;
  /** When true, register/use/onBefore/onAfter/respond throw. */
  sealed: boolean;
  /** Per-instance throttle timers - dispose() cancels only this bus's timers. */
  throttleTimers: Set<ReturnType<typeof setTimeout>>;
  /** onMissing:'buffer' queue - per-action FIFO of {target,payload}, replayed on
   *  register(). Lazily null unless onMissing:'buffer' is configured, so non-buffer
   *  buses don't allocate it. */
  deferred: Map<string, Array<{ target: any; payload: any; at: number }>> | null;
  /** One cancel per request() still waiting on its responder. dispose() runs them, so
   *  each settles at once as VC_CORE_ABORTED with its timer cleared, and polices nothing
   *  afterwards - no disposed state, as Vue 3.6 rc.8's EffectScope.stop() has none.
   *  Lazily null until the first such request, like `deferred`. */
  waiting: Set<() => void> | null;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Lightweight unique ID - counter + per-process random prefix.
 *
 * V8-aligned: monotonic counter + module-load random + module-load timestamp.
 * No `crypto.randomUUID()` syscall, no per-call `Date.now()`, no per-call
 * `Math.random()`. Re-measured on Node 24 (2026-08-17, `hrtime` medians over
 * 21x200k reps): **~12ns per call vs ~104ns for `crypto.randomUUID()`, ~8x**.
 * The figures this comment carried before ("~30-50ns vs ~1-2us", implying
 * 20-60x) no longer describe any current runtime - modern V8/Node batch UUID
 * entropy, so `randomUUID` got ~10x cheaper while this counter stayed put.
 * The decision is unchanged and the direction still holds; only the margin is
 * smaller than it was when first measured. Quote the runtime with the number:
 * an unqualified ns figure is what let this drift unnoticed.
 *
 * Command IDs are correlation tokens, not security tokens - uniqueness is
 * required across one process; cross-process collision risk is acceptable
 * for tracing/observability use cases. If you need cryptographically unique
 * IDs (cross-process auditing, distributed tracing IDs), call
 * `configureUid(crypto.randomUUID.bind(crypto))` at app setup.
 */
const _uidPrefix = (
  Date.now().toString(36) + '-' +
  ((Math.random() * 0xffffffff) >>> 0).toString(36)
);
let _uidCounter = 0;
let _uidFn: () => string = () => _uidPrefix + '-' + (++_uidCounter).toString(36);

// Held as a binding, not called literally, so `configureClock` can swap it.
//
// Whatever occupies this slot READS THE GLOBAL on every call rather than being
// `Date.now` itself - true of the cached default below, and the rule any
// replacement must follow. (This paragraph used to open "the default is
// `() => Date.now()`", which stopped being true when the cached clock landed
// and left it contradicting the paragraph directly beneath it. The reasoning
// survived the change; the statement of the default did not.) Assigning the
// function reference captures
// the intrinsic at module load, so test doubles that replace the global
// (`vi.useFakeTimers`, `vi.setSystemTime`) never reach it, and `meta.ts` silently
// keeps reporting real time. That was the first version of this code and
// `tests/clock-source-contained.test.ts` caught it: the indirection added to
// make the clock swappable had itself broken the fake-timer behaviour the
// default exists to preserve. The wrapper costs one call; correctness of the
// default is not negotiable against that.
//
// It is a named constant, and `configureClock()` restores it, because the
// obvious way to "put it back" - `configureClock(Date.now)` - is the same trap
// wearing a different hat. That footgun was hit twice while writing this, once
// in the implementation and once in the test's own teardown, which is two more
// times than a comment would have prevented.
// The DEFAULT: one real clock read per microtask turn, reused by every command
// dispatched inside that turn.
//
// Note the refresh is EAGER - the clock is read on the first call of each turn,
// not scheduled for later. A lazy version (return the old value, queue a
// refresh) would hand the first dispatch after an idle period a timestamp from
// whenever the module loaded, which is arbitrarily stale. Reading first and
// only then arming the reset means the first command of every turn carries an
// EXACT timestamp, and only the 2nd..nth command of the same synchronous run
// shares it. Since a `Date.now()` is millisecond-resolution and a typical burst
// is sub-millisecond, those commands would overwhelmingly have received the
// same number anyway.
//
// What is genuinely lost: intra-burst duration in bursts long enough to cross a
// millisecond (a thousand-command rehydrate reads as instantaneous), and
// tracking of `vi.setSystemTime` for the 2nd..nth command in a turn. Ordering is
// NOT lost - `meta.id` is a monotonic counter and remains unique and ordered.
// Consumers who need exact per-command wall clock stamp it themselves - see the
// note on `CommandMeta.ts`.
//
// What `ts` is and is not - a wall clock, not an ordering key, not a duration
// source - is on `CommandMeta.ts`. If an exact wall clock is ever genuinely
// needed, the cheap door is a `clock?: () => number` bus option - one branch,
// no build step, and addable later without breaking anyone.

// A boolean rather than a `0` sentinel. `_clockNow === 0` meaning "re-read me"
// reads as safe - `Date.now()` cannot return 0, that is 1970 - but it is only
// true in production: under a test clock pinned to the epoch
// (`vi.useFakeTimers({ now: 0 })`) the cache silently never engages, and a
// benchmark would measure the uncached path while believing otherwise.
let _clockNow = 0;
let _clockStale = true;
const CACHED_CLOCK = (): number => {
  if (_clockStale) {
    _clockNow = Date.now();
    _clockStale = false;
    queueMicrotask(() => { _clockStale = true; });
  }
  return _clockNow;
};

let _clockFn: () => number = CACHED_CLOCK;
function uid(): string { return _uidFn(); }

/**
 * Swap the unique-ID generator. Call once at app setup if you need a different
 * format (e.g. `crypto.randomUUID` for distributed tracing).
 *
 * @example
 * import { configureUid } from 'vapor-chamber';
 * configureUid(() => crypto.randomUUID());
 */
export function configureUid(fn: () => string): void { _uidFn = fn; }

/**
 * Swap the clock `stampMeta` reads. `_configureClock()` with no argument
 * restores the cached default.
 *
 * @internal - NOT public API, not exported from the barrel, no semver promise.
 * It exists so `tests/clock-source-ab.test.ts` can A/B the two clock sources
 * through the real dispatch path, and so
 * `tests/clock-source-contained.test.ts` can drive a deliberately frozen clock
 * to prove no TTL depends on this. Underscored for the same reason
 * `_stampMeta` is.
 *
 * There is deliberately no consumer-facing option. An option only earns its
 * place when both settings are right for different people; here the cached
 * clock is what essentially everyone wants, and the rare need for exact
 * per-command wall-clock is served by reading the clock yourself - see the
 * note on `CommandMeta.ts`.
 */
export function _configureClock(fn?: () => number): void { _clockFn = fn ?? CACHED_CLOCK; }

// V8 optimization: monomorphic result factories - always same hidden class
function okResult(value: any): CommandResult { return { ok: true, value, error: undefined }; }
function errResult(error: Error): CommandResult { return { ok: false, value: undefined, error }; }

/** The sync and async buses share these two failures' wording. */
function maxDepthResult(action: string): CommandResult {
  return errResult(new BusError('VC_CORE_MAX_DEPTH', `Maximum dispatch depth (${MAX_DISPATCH_DEPTH}) exceeded for "${action}". This usually means a listener or reaction is re-dispatching in an infinite loop.`, { emitter: 'core', action }));
}
function requestTimeoutResult(action: string, timeout: number): CommandResult {
  return errResult(new BusError('VC_CORE_REQUEST_TIMEOUT', `Request "${action}" timed out after ${timeout}ms. Increase timeout or check if a respond() handler is registered.`, { emitter: 'core', action, context: { timeout } }));
}

/**
 * Singleton "successful empty" result used by `bus.emit()`. emit is fire-and-
 * forget - no value is computed, the result is constant. Reusing one frozen
 * object eliminates a per-emit `okResult(undefined)` allocation. Listeners
 * receive this as the second arg; mutation attempts will throw in strict
 * mode (the freeze is intentional, not accidental).
 */
const EMIT_RESULT: CommandResult = Object.freeze({ ok: true, value: undefined, error: undefined }) as CommandResult;

// V8 optimization: extract try/catch into separate function so callers stay optimizable
function tryCatchHandler(handler: Handler, cmd: Command): CommandResult {
  try { return okResult(handler(cmd)); }
  catch (e) { return errResult(e as Error); }
}
async function tryCatchAsyncHandler(handler: AsyncHandler, cmd: Command): Promise<CommandResult> {
  try { return okResult(await handler(cmd)); }
  catch (e) { return errResult(e as Error); }
}

/**
 * One-shot origin slot - consumed by the NEXT `stampMeta` call.
 *
 * Why a module slot is safe here when it was the original bug everywhere else:
 * the four flags `stampMeta`'s docblock indicts (`_mcpDispatching`, `receiving`,
 * `paused`, the reaction guard) all had to survive until a dispatch SETTLED,
 * which on an async bus means past a microtask - so `finally` cleared them
 * early. This slot only has to survive into `stampMeta`, which every dispatch
 * variant calls in its SYNCHRONOUS prologue while building `cmd`, before any
 * await exists. It cannot span a microtask by construction.
 *
 * It exists because `__origin`-in-the-payload can only mark payloads that hold
 * keys. A number, string, boolean or array cannot carry it, so those dispatches
 * reached handlers unattributed - an infinite cross-tab broadcast loop in
 * sync(), a double-recorded redo in chamber(), and an MCP command invisible to
 * an `origin === 'agent'` audit filter. Each site had grown its own workaround
 * (a depth counter, a one-shot identity match, a boundary refusal); this
 * replaces all three with one mechanism that works for every payload shape and
 * leaves the payload itself untouched.
 */
let _nextOrigin: string | undefined;

/**
 * One-shot causation slot - same mechanism, same synchronous-prologue safety
 * argument as `_nextOrigin` above, for the other `__`-key that cannot mark
 * every payload shape.
 *
 * `__causationId` in the payload has exactly the limitation that moved
 * `__origin` off it: a number, string, boolean or array has nowhere to put the
 * key, so a dispatch carrying one arrives with no causation and any consumer
 * counting a chain from it starts over at zero. `createReaction`'s `maxHops`
 * cap was doing precisely that - measured, an indirect cycle whose `mapPayload`
 * returns a scalar ran to `MAX_DISPATCH_DEPTH` on a sync bus and is unbounded on
 * an async one, which is the failure `ReactionOptions.allowSelfMatch` documents
 * as the reason the guard exists.
 */
let _nextCausation: string | undefined;

/**
 * Scoped origin - every dispatch made synchronously inside `_withOriginScope`
 * carries it, where `_withOrigin` marks only the next one. History's undo and
 * redo need the scope: an undo handler that dispatches two compensations, or
 * a redone handler that dispatches a child, are rollback steps and none of
 * them may be recorded. The one-shot slot stays one-shot on purpose (a nested
 * dispatch must not inherit 'sync' and lose its own broadcast); a rollback
 * window is the case where inheriting IS the point. The read sits in
 * stampMeta, so it holds on the async bus too - a recorder there runs at
 * settle, after a flag would have been cleared, which is how the history
 * plugin recorded an undo handler's compensations on the async bus and wiped
 * the redo stack. The flag's old limit remains: a dispatch an ASYNC undo
 * handler makes after an await is outside the window. Measured on the
 * dispatch hot path: tests/origin-scope-ab.test.ts.
 */
let _originScope: string | undefined;

/** Internal - `origin` on every dispatch `fn` makes synchronously; nests, restores on exit. */
export function _withOriginScope<T>(origin: string, fn: () => T): T {
  const outer = _originScope;
  _originScope = origin;
  try { return fn(); } finally { _originScope = outer; }
}

/**
 * Internal - stamp `origin` on the meta of the FIRST dispatch `fn` makes
 * synchronously. Not public API; underscored like `_stampMeta`.
 *
 * The `finally` is leak protection, not a settlement guard: `validateNaming`
 * can throw before `stampMeta` runs, and an unconsumed slot must not bleed into
 * whatever dispatches next. Awaiting the result of `fn()` is fine - the slot is
 * already consumed by then.
 */
export function _withOrigin<T>(origin: string, fn: () => T): T {
  _nextOrigin = origin;
  try {
    return fn();
  } finally {
    _nextOrigin = undefined;
  }
}

/**
 * Internal - stamp `causationId` on the meta of the FIRST dispatch `fn` makes
 * synchronously, for callers whose payload cannot carry `__causationId`.
 * Same contract and same `finally` reasoning as `_withOrigin`.
 */
export function _withCausation<T>(causationId: string | undefined, fn: () => T): T {
  _nextCausation = causationId;
  try {
    return fn();
  } finally {
    _nextCausation = undefined;
  }
}

/**
 * Stamp a command with auto-generated metadata.
 *
 * The `__`-prefixed payload keys are the established convention for
 * per-dispatch meta without a signature change: they travel **with** the
 * dispatch rather than beside it.
 *
 * `__origin` was added for a family of four bugs that all shared one shape -
 * a module-level flag set before a dispatch and cleared in `finally`
 * (`_mcpDispatching` in mcp.ts, `receiving` in sync(), `paused` in redo(),
 * and the reaction guard). On a sync bus the dispatch completes inside the
 * `try`, so the flag holds and the tests pass. On an **async** bus the
 * dispatch returns a pending promise, the plugin chain runs a microtask later,
 * and `finally` has already fired - so the flag was cleared before the thing
 * it was guarding happened. The failure modes ranged from misattributed audit
 * origins to an infinite cross-tab broadcast loop. A marker on the dispatch is
 * race-free by construction, and one fix site serves all of them.
 */
function stampMeta(payload: any): CommandMeta {
  // Read __causationId once - it is both `causationId` and `correlationId`'s fallback.
  // V8 does not CSE the repeated optional-chain read (measured ~5-9% on an isolated A/B with
  // the common no-ids payload; end-to-end it's within noise, dwarfed by uid()/Date.now()).
  // Behavior-identical; reading once also avoids a double getter invocation on exotic payloads.
  // `origin` is always present (undefined when unset) rather than conditionally
  // added - one field set, one hidden class, monomorphic dispatch preserved.
  // Read-and-clear, branchless: both slots are consumed unconditionally (a
  // store of undefined over undefined in the common case) and each `??` falls
  // back to the documented public payload key. The obvious
  // `if (_nextOrigin !== undefined)` form costs more bytes for no measurable
  // speed - and this bundle's budget is a ratchet that gets argued down before
  // it gets raised.
  //
  // The two clears are deliberately NOT folded into one chained assignment
  // (`_nextOrigin = _nextCausation = undefined`). That reads as the cheaper
  // shape and measured one byte WORSE on the tree-shake bundle - 6564 vs 6563 -
  // because brotli is not linear in source length. Measured, then reverted;
  // recorded so nobody re-derives it hoping for a saving.
  const cause = _nextCausation;
  _nextCausation = undefined; // one-shot
  const causationId = cause ?? payload?.__causationId;
  const correlationId = payload?.__correlationId ?? causationId;
  const slot = _nextOrigin;
  _nextOrigin = undefined; // one-shot
  // The scope slot reads between the one-shot and the payload key: a dispatch
  // marked one-shot inside a scope keeps its own origin.
  return { ts: _clockFn(), id: uid(), correlationId, causationId, origin: slot ?? _originScope ?? payload?.__origin };
}

/**
 * Internal - exported for `testing.ts` so the TestBus stamps the same meta the
 * real buses do. Underscored: not public API, not in the docs, may change.
 * Duplicating the `__`-key convention in the double is exactly how the double
 * drifts from the thing it doubles.
 */
export { stampMeta as _stampMeta };

/**
 * Internal - the two result factories, for modules that build a
 * `CommandResult` outside the bus (transports, composables, plugins). A
 * hand-written `{ ok: false, error }` literal has a different hidden class from
 * `errResult`'s three-field one, so every `result.ok` site that sees both goes
 * polymorphic; tests/v8-shapes.test.ts pins the shared map. Underscored: not
 * public API, not in the barrel.
 */
export { okResult as _okResult, errResult as _errResult };

function validateNaming(action: string, naming?: NamingConvention): void {
  if (!naming) return;
  if (naming.pattern.test(action)) return;
  const msg = `[vapor-chamber] Action "${action}" does not match naming pattern ${naming.pattern}. Rename the action to match or adjust the naming option in createCommandBus({ naming: { pattern } }).`;
  const mode = naming.onViolation ?? 'warn';
  if (mode === 'throw') throw new Error(msg);
  if (mode === 'warn') console.warn(msg);
}

// Pre-sliced prefix cache for wildcard patterns - avoids slice() on every match.
// Capped at 256 entries to prevent unbounded growth in long-running processes.
const _prefixCache = new Map<string, string>();
const _PREFIX_CACHE_MAX = 256;

/** True if a pattern requires wildcard matching ('*' alone or 'foo*'). */
function isWildcardPattern(pattern: string): boolean {
  return pattern === '*' || pattern.charCodeAt(pattern.length - 1) === 42 /* '*' */;
}

/**
 * WildcardEntry - a subscribed wildcard listener, with its match test already
 * reduced to data.
 *
 * `pattern` is retained verbatim because `offAll(pattern)` and `inspectBus()`
 * both report on it; `prefix` is what the dispatch path actually reads. It is
 * `pattern.slice(0, -1)`, which is correct for BOTH wildcard shapes with no
 * special case: `'cart*'` -> `'cart'`, and `'*'` -> `''`, where
 * `action.startsWith('')` is unconditionally true. So the fan-out loop is one
 * `startsWith` per listener with no branch, no `charCodeAt`, and no cache
 * lookup.
 *
 * WHY IT LIVES ON THE ENTRY rather than in `matchesPattern`'s LRU. `on()`
 * has already classified the pattern as a wildcard to decide which bucket it
 * goes in, so by the time the entry exists the parse is a known result being
 * thrown away. Storing it is the same move Vue made in 3.6.0-rc.6's `29ed4b0`
 * (`parseAdoptTarget`): hoist a per-call string scan into a descriptor computed
 * once by the factory, then compare cheap values on the hot path.
 * `matchesPattern` keeps its cache - it is public API taking arbitrary
 * caller-supplied patterns (plugin `actions:` filters, `mcp` whitelists), where
 * nothing has classified anything in advance.
 *
 * Measured, real dispatch path, interleaved A/B - see
 * `tests/wildcard-prefix-ab.test.ts`.
 */
type WildcardEntry = { pattern: string; prefix: string; listener: Listener };

/**
 * Walk listener buckets for an action. Exact-match bucket is O(1) lookup;
 * wildcard bucket is walked with one `startsWith` against each entry's
 * precomputed prefix (WildcardEntry). Both loops survive in-flight
 * unsubscribe (a listener may remove itself or peers).
 *
 * The cursor is corrected by IDENTITY, not by length. The older `if (len <
 * lenBefore) i--` shape handled self-removal but over-corrected the other
 * direction: a listener that removed a LATER peer shrank the array without
 * moving anything at or before `i`, so the decrement re-invoked the listener
 * that had just run - a duplicate side effect on every dispatch that hit that
 * shape. `bucket[i] !== listener` is the exact test for "the cursor moved",
 * and subtracting the full shrinkage handles removing several at once.
 */
function fanOutListeners(
  exact: Map<string, Listener[]>,
  wild: WildcardEntry[],
  action: string,
  cmd: Command,
  result: CommandResult,
): void {
  const ex = exact.get(action);
  if (ex !== undefined) {
    for (let i = 0; i < ex.length; i++) {
      const lenBefore = ex.length;
      const listener = ex[i];
      try { listener(cmd, result); } catch (e) { console.error('[vapor-chamber] Listener error:', e); }
      if (ex.length < lenBefore && ex[i] !== listener) i -= lenBefore - ex.length;
    }
  }
  for (let i = 0; i < wild.length; i++) {
    const entry = wild[i];
    // `entry.prefix` is `pattern.slice(0, -1)`, computed ONCE in `on()` - see
    // WildcardEntry. `'*'` slices to `''` and `''.startsWith` is always true,
    // so match-all needs no branch of its own and this loop is a single
    // `startsWith` per listener. `matchesPattern` (public API, arbitrary
    // caller-supplied patterns) still re-derives the prefix through its LRU;
    // only this loop knows the pattern was classified at subscribe time.
    if (action.startsWith(entry.prefix)) {
      const lenBefore = wild.length;
      try { entry.listener(cmd, result); } catch (e) { console.error('[vapor-chamber] Listener error:', e); }
      if (wild.length < lenBefore && wild[i] !== entry) i -= lenBefore - wild.length;
    }
  }
}

export function matchesPattern(pattern: string, action: string): boolean {
  if (pattern === '*') return true;
  if (pattern.charCodeAt(pattern.length - 1) === 42 /* '*' */) {
    let prefix = _prefixCache.get(pattern);
    if (prefix === undefined) {
      prefix = pattern.slice(0, -1);
      if (_prefixCache.size >= _PREFIX_CACHE_MAX) _prefixCache.delete(_prefixCache.keys().next().value!);
      _prefixCache.set(pattern, prefix);
    }
    return action.startsWith(prefix);
  }
  return pattern === action;
}

/**
 * Run every collected disposer in insertion order, then empty the list so a
 * second call is a no-op (idempotent teardown). Shared by the composables'
 * `dispose()` and the chamber/install + history-plugin cleanups. Cold path
 * (runs at unmount/disposal, never per dispatch) - a plain loop, no closure.
 *
 * No try/catch by design - settled, do not "harden". Every disposer collected
 * here is an internal `register`/`on`/`use`/`respond` unsub (`Map.delete` /
 * `Array.splice`); none can throw. A throw would mean corrupted internal state,
 * which should surface loudly during teardown, not be swallowed.
 */
export function disposeAll(fns: Array<() => void>): void {
  for (let i = 0; i < fns.length; i++) fns[i]();
  fns.length = 0;
}

function isAsyncFn(fn: Function): boolean {
  return (fn as any)[Symbol.toStringTag] === 'AsyncFunction';
}

/**
 * Stable string key for a (action, target) pair. Handles circular refs safely.
 * Useful for cache invalidation integration (e.g. TanStack Query).
 */
export function commandKey(action: string, target: any): string {
  // Fast path: primitives and null don't need serialization or key sorting
  if (target === null || target === undefined) return `${action}:${target}`;
  const t = typeof target;
  if (t === 'string' || t === 'number' || t === 'boolean') return `${action}:${target}`;
  // Object path: canonical, order-independent serialization. A function replacer
  // rebuilds every object with its keys in sorted order - at EVERY level - so
  // { b:2, a:1 } and { a:1, b:2 } produce the same key, while nested fields are
  // preserved in full and arrays keep their order. (The previous top-level array
  // replacer `Object.keys(target).sort()` silently DROPPED nested keys, collapsing
  // { q:{page:2} } and { q:{page:3} } to the same key - fixed here.)
  let tkey: string;
  try {
    tkey = JSON.stringify(target, (_k, v) => {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        // Prototype-free, and this one is load-bearing rather than defensive.
        // On a `{}`, `sorted['__proto__'] = value` goes through the inherited
        // setter and the key never becomes an own property, so it vanished from
        // the serialization - and an own `__proto__` key is exactly what
        // `JSON.parse` of a server response produces. Measured: targets
        // `{"__proto__":"A","id":1}` and `{"__proto__":"B","id":1}` both keyed
        // to `act:{"id":1}`. This key backs `idempotent`, `cache`, `serialize`
        // and `supersede`, so that collision collapsed distinct commands into
        // one. Rule and full evidence in ./dict.
        const sorted: Record<string, unknown> = dict();
        for (const k of Object.keys(v).sort()) sorted[k] = v[k];
        return sorted;
      }
      return v;
    });
  } catch { tkey = String(target); }
  return `${action}:${tkey}`;
}

// ---------------------------------------------------------------------------
// commandPool - circular buffer of pre-allocated Command objects (zero-GC)
// ---------------------------------------------------------------------------

/**
 * CommandPool - pre-allocates Command objects in a circular buffer to
 * eliminate garbage collection pauses during dispatch bursts. When the
 * pool is exhausted, it wraps around and reuses the oldest slot.
 *
 * **Important**: The pool is a standalone utility - `bus.dispatch()` still
 * creates its own Command internally and stamps `meta` (ts, id, correlationId).
 * Pooled commands do NOT have `meta` set. Use `pool.acquire()` for the action/target/payload,
 * then pass those values to `bus.dispatch(cmd.action, cmd.target, cmd.payload)`.
 * The bus will create its own internal command with proper metadata.
 *
 * @example
 * const pool = createCommandPool();
 * const cmd = pool.acquire('cartAdd', cart, { id: 1 });
 * bus.dispatch(cmd.action, cmd.target, cmd.payload); // bus stamps its own meta
 *
 * pool.stats(); // { size: 64, acquired: 1, cursor: 1 }
 * pool.reset(); // Reset cursor and clear all slots
 */
export interface CommandPool {
  /** Acquire a command object from the pool. Reuses slots in a circular fashion. */
  acquire(action: string, target: any, payload?: any): Command;
  /** Current pool statistics. */
  stats(): { size: number; acquired: number; cursor: number };
  /** Reset the pool - clears all slots and resets cursor. */
  reset(): void;
  /** Pool capacity. */
  readonly size: number;
}

export function createCommandPool(size: number = 64): CommandPool {
  if (size < 1) throw new RangeError('CommandPool size must be at least 1');

  // Pre-allocate monomorphic command objects - same hidden class for V8 TurboFan
  const buffer: Command[] = new Array(size);
  for (let i = 0; i < size; i++) {
    buffer[i] = { action: '', target: undefined, payload: undefined, meta: undefined };
  }

  let cursor = 0;
  let totalAcquired = 0;

  function acquire(action: string, target: any, payload?: any): Command {
    const cmd = buffer[cursor];
    cmd.action = action;
    cmd.target = target;
    cmd.payload = payload;
    cmd.meta = undefined; // pooled commands carry no meta - dispatch stamps its own
    cursor = (cursor + 1) % size;
    totalAcquired++;
    return cmd;
  }

  function stats() {
    return { size, acquired: totalAcquired, cursor };
  }

  function reset() {
    cursor = 0;
    totalAcquired = 0;
    for (let i = 0; i < size; i++) {
      buffer[i].action = '';
      buffer[i].target = undefined;
      buffer[i].payload = undefined;
      buffer[i].meta = undefined;
    }
  }

  return { acquire, stats, reset, size };
}

function wrapThrottle(handler: Handler, wait: number, timers: Set<ReturnType<typeof setTimeout>>): Handler;
function wrapThrottle(handler: AsyncHandler, wait: number, timers: Set<ReturnType<typeof setTimeout>>): AsyncHandler;
function wrapThrottle(handler: Handler | AsyncHandler, wait: number, timers: Set<ReturnType<typeof setTimeout>>): Handler | AsyncHandler {
  const lastRun = new Map<string, number>();
  return (cmd: Command): any => {
    const key = commandKey(cmd.action, cmd.target);
    const now = Date.now();
    const last = lastRun.get(key) ?? 0;
    if (now - last >= wait) {
      lastRun.set(key, now);
      const timer = setTimeout(() => { lastRun.delete(key); timers.delete(timer); }, wait);
      timers.add(timer);
      return (handler as Handler)(cmd);
    }
    const retryIn = wait - (now - last);
    // The rejected branch is the hot one by design (throttle exists for
    // scroll/mousemove-frequency sources), and V8 stack capture dominates its
    // cost. A throttle rejection is expected control flow - code/context carry
    // everything actionable - so skip the stack. No-op outside V8.
    const savedLimit = (Error as any).stackTraceLimit;
    (Error as any).stackTraceLimit = 0;
    try {
      throw new BusError('VC_CORE_THROTTLED', `Handler "${cmd.action}" throttled. Retry in ${retryIn}ms.`, { emitter: 'core', action: cmd.action, context: { retryIn, wait } });
    } finally {
      (Error as any).stackTraceLimit = savedLimit;
    }
  };
}

// ---------------------------------------------------------------------------
// Sync runner
// ---------------------------------------------------------------------------

// `next` is index-parameterized: each level's continuation captures its own
// position, so the chain does not depend on when - or how often - a plugin
// calls it.
//
// The old shared cursor (`plugins[i++]` closed over one `i`) broke on
// RE-INVOCATION: `retry()` calls `next()` once per attempt, so attempt 1
// exhausted the index and attempt 2 fell straight through to `execute()`,
// silently skipping every plugin downstream of retry - the HTTP bridge,
// logging, metrics, cache, idempotent stamping.
//
// PERF NOTE, and the reason this is not the cheaper shape: one closure per
// plugin level per dispatch costs ~13.5% on the documented hot-path row
// ("syncDispatch - 3 plugins + 1 listener", interleaved same-machine A/B:
// ~1261 -> ~1090 ops/s). A save/restore cursor (`level = idx` in a `finally`)
// measures identical to the old shared cursor and is re-entrant - but it is
// WRONG, and the suite says so: `debounce`/`throttle` call `next()` from a
// timer, long after `plugin(cmd, next)` returned and the `finally` restored
// the cursor, so the deferred call re-enters the debounce plugin itself and
// the handler never runs (`tests/plugins.test.ts` "should debounce specified
// actions", `tests/plugins-core-coverage.test.ts`). The old shared cursor
// survived debounce only by accident - its exhausted index happened to land
// on `execute()`. Deferred continuations are a first-class case here, so
// correctness takes the 13.5%.
export function buildRunner(plugins: Plugin[]) {
  return function run(cmd: Command, execute: () => CommandResult): CommandResult {
    function nextFrom(idx: number): CommandResult {
      const plugin = plugins[idx];
      if (!plugin) return execute();
      // The boundary (see pluginThrew), inline so this runner keeps its OWN
      // plugin call site - tests/plugin-throw-ab.test.ts.
      try { return plugin(cmd, () => nextFrom(idx + 1)); }
      catch (e) { return pluginThrew(e, cmd, plugin, idx); }
    }
    return nextFrom(0);
  };
}

/**
 * A plugin that throws, or returns a rejected promise, becomes a
 * `VC_PLUGIN_THREW` result - converted at the invocation boundary of EACH
 * plugin, not once at the top. So the plugin above the one that threw receives
 * it through `next()` like any other failure and its cleanup runs, and the
 * settle still fires for after-hooks, `on('*')`, the shared error observer and
 * `isLoading`. Before, the throw escaped the runner past all of them and into
 * the caller, breaking "dispatch always returns a result" for every consumer
 * built on it.
 *
 * One error passes through as itself: `onMissing: 'throw'` throws (on the
 * async bus, rejects) from `execute()` BELOW the chain by contract, so every
 * boundary it crosses hands it on unchanged rather than relabeling it.
 *
 * Not in RETRYABLE_CODES - a plugin bug throws again - and circuitBreaker does
 * not count it. DEV logs it so the conversion never hides the bug. There is
 * deliberately no "throw in dev, errResult in prod" split: tests would then
 * run a different pipeline from production.
 * Pinned by tests/plugin-throw-fixture.test.ts.
 */
function pluginThrew(e: unknown, cmd: Command, plugin: Function, index: number): CommandResult {
  if (e instanceof BusError && e.code === 'VC_CORE_NO_HANDLER') throw e;
  if (DEV) {
    console.error(`[vapor-chamber] Plugin "${plugin.name || 'anonymous'}" (#${index} in the chain, 0 = outermost) threw on "${cmd.action}"; the dispatch returns VC_PLUGIN_THREW. Fix the plugin: return next() or an errResult instead of throwing.`, e);
  }
  // The plugin's identity is `context.index`, its place in the chain (0 =
  // outermost); the DEV log above adds its name. The name is not carried in
  // production: `plugin: fn.name` measured 19 B brotli in the full IIFE, and
  // is '' for the anonymous arrows most plugins are.
  return errResult(new BusError('VC_PLUGIN_THREW', `Plugin threw on "${cmd.action}".`, { emitter: 'plugin', action: cmd.action, context: { index }, cause: e as Error }));
}

/**
 * A before-hook's throw becomes a `VC_CORE_BEFORE_CANCEL` result - the code
 * the union has declared since v1.0 and never produced: the raw thrown value
 * was returned. The message is the thrown error's own, so a hook that throws
 * `new Error('blocked')` still reads "blocked"; the original is `cause`. A
 * thrown BusError passes through as itself, so a hook that already speaks in
 * codes keeps its code. Emitter 'hook' as ERROR_CODE_REGISTRY declares;
 * severity 'error', what BusSeverity defines for a failed dispatch (the
 * registry said 'warn' while the code was never emitted); not retryable, the
 * hook would throw again. Both catch sites are cold; tests/before-cancel-ab.test.ts
 * measures the dispatch paths around them. Exported underscored for
 * testing.ts, so the TestBus cancels the way a real bus does.
 */
function beforeCancel(e: unknown, action: string): BusError {
  if (e instanceof BusError) return e;
  // The cause carries the hook's own stack and this frame's is the caller's
  // own dispatch, so the capture buys nothing: skipped, as wrapThrottle skips
  // it for the same reason - a cancel is expected control flow. Measured
  // (tests/before-cancel-ab.test.ts): with the capture a cancelled dispatch
  // cost 2.2x its former time on both buses.
  const savedLimit = (Error as any).stackTraceLimit;
  (Error as any).stackTraceLimit = 0;
  try { return new BusError('VC_CORE_BEFORE_CANCEL', e instanceof Error ? e.message : String(e), { emitter: 'hook', action, cause: e as Error }); }
  finally { (Error as any).stackTraceLimit = savedLimit; }
}
export { beforeCancel as _beforeCancel };

// ---------------------------------------------------------------------------
// Module-level sync bus operations (state threaded explicitly)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Shared helpers for both sync and async buses
// ---------------------------------------------------------------------------

/** Reusable priority comparator - avoids 3 inline arrow-function copies. */
const byPriority = (a: { priority: number }, b: { priority: number }) => b.priority - a.priority;

/**
 * Register a handler on either bus variant. Both SyncState and AsyncState
 * carry the same fields here, so one implementation covers both.
 */
function register(s: SyncState | AsyncState, action: string, handler: any, opts: RegisterOptions = {}): () => void {
  assertNotSealed(s, 'register');
  validateNaming(action, s.opts.naming);
  // DEV-gated: overwriting a handler is a wiring mistake only the developer can
  // fix, so the message is worth bytes in dev and none in prod. `DEV` folds to
  // `false` in the IIFE builds, taking the string with it (see src/dev.ts).
  if (DEV && s.handlers.has(action)) {
    console.warn(`[vapor-chamber] Handler for "${action}" already exists and is being overwritten. Call the unregister function returned by register() first, or use bus.clear() to reset.`);
  }
  let h = handler;
  if (opts.throttle && opts.throttle > 0) h = wrapThrottle(h, opts.throttle, s.throttleTimers);
  if (opts.undo) s.undoHandlers.set(action, opts.undo);
  s.handlers.set(action, h);
  // onMissing:'buffer' - replay any commands that arrived before this handler.
  if (s.deferred !== null && s.deferred.size !== 0) flushDeferred(s, action);
  return () => { s.handlers.delete(action); s.undoHandlers.delete(action); };
}

/** Clear the fields both bus variants share. Each bus then resets its own runner. */
function clearState(s: SyncState | AsyncState): void {
  s.handlers.clear();
  s.undoHandlers.clear();
  s.pluginEntries.length = 0;
  s.beforeHooks.length = 0;
  s.afterHooks.length = 0;
  s.exactListeners.clear();
  s.wildcardListeners.length = 0;
  s.responders.clear();
  s.deferred?.clear();
}

/** Build the BusInspection snapshot - identical shape for sync and async buses. */
function inspect(s: SyncState | AsyncState): BusInspection {
  return {
    actions:          Array.from(s.handlers.keys()),
    undoActions:      Array.from(s.undoHandlers.keys()),
    responderActions: Array.from(s.responders.keys()),
    pluginCount:      s.pluginEntries.length,
    pluginPriorities: s.pluginEntries.slice().sort(byPriority).map(e => e.priority),
    beforeHookCount:  s.beforeHooks.length,
    afterHookCount:   s.afterHooks.length,
    listenerPatterns: [...Array.from(s.exactListeners.keys()), ...s.wildcardListeners.map(e => e.pattern)],
    sealed:           s.sealed,
    dispatchDepth:    s.dispatchDepth,
    activeTimers:     s.throttleTimers.size,
  };
}

function syncRebuildRunner(s: SyncState): void {
  s.runner = buildRunner(s.pluginEntries.slice().sort(byPriority).map(e => e.plugin));
}

/**
 * No-handler path. `canDefer` is true for dispatch (which may buffer) and false
 * for query (which must return a value, so 'buffer' degrades to 'error').
 */
function handleMissing(s: SyncState | AsyncState, cmd: Command, canDefer: boolean): CommandResult {
  const mode = s.opts.onMissing ?? 'error';
  if (mode === 'ignore') return okResult(undefined);
  if (mode === 'buffer' && canDefer) {
    // Lazy init: the queue map is born on the first buffered command. Cheaper
    // than eager allocation (a bus that never buffers allocates nothing), and a
    // measured A/B showed gating the hot path on `deferred !== null` instead of
    // this `onMissing` check is only faster when monomorphic - it regresses in
    // mixed buffer/non-buffer apps - so the hot-path gate stays on onMissing.
    const d = s.deferred ?? (s.deferred = new Map());
    let q = d.get(cmd.action);
    if (q === undefined) { q = []; d.set(cmd.action, q); }
    const now = Date.now();
    // Lazy TTL reap: queue is FIFO, so expired entries cluster at the front.
    const ttl = s.opts.bufferTTL;
    if (ttl !== undefined && ttl > 0) {
      while (q.length > 0 && now - q[0].at > ttl) {
        const expired = q.shift()!;
        s.opts.onBufferOverflow?.(cmd.action, { target: expired.target, payload: expired.payload });
      }
    }
    // Clamped, and the push moved AHEAD of the eviction, because the old
    // drop-then-push form crashed on a degenerate bound. With `bufferLimit: 0`
    // the empty queue still satisfied `q.length >= limit`, so `q.shift()`
    // returned undefined and the overflow callback dereferenced it:
    // `TypeError: Cannot read properties of undefined (reading 'target')`, out
    // of `bus.dispatch()`. It was invisible until someone passed
    // `onBufferOverflow`, since optional-chaining a call skips evaluating its
    // arguments - so adding the observability hook was what made the bus start
    // throwing. A negative bound drained the queue and then crashed the same way.
    //
    // Evicting down to the bound AFTER the push is the same rule `cache()` and
    // `idempotent()` use, and for a bound of 1 or more it is indistinguishable
    // from before: the queue ends at `limit` entries and the oldest is the one
    // reported. At 0 it now means what it says - nothing is buffered, and the
    // arriving command is reported as dropped rather than crashing.
    // `q.length > limit` gates EVICTION, so a NaN bound made the drop test
    // permanently false and the queue grew without bound - measured at 500
    // commands buffered.
    //
    // THE ONE SITE THAT DOES NOT USE ../bounds, and it was measured rather than
    // assumed. Importing `countOption` here costs 50 B brotli in the minimal
    // Blade consumer bundle that `esm-treeshake.test.ts` gates - enough to
    // breach that ceiling on its own, because this module is the one thing
    // every consumer pulls. `| 0` is already correct for the NaN case, which is
    // the case that bites; what it does not do is preserve `Infinity`, which it
    // maps to 0 - so `bufferLimit: Infinity` buffers NOTHING rather than never
    // dropping. That is the price of the exception, stated here so it is a
    // known trade and not a discovery. Write a large finite number instead.
    //
    // A negative bound needs no clamp here, because the push happens FIRST and
    // exactly one item is pushed: the queue therefore always holds at least one
    // entry when the test runs, so `shift()` cannot return undefined whatever
    // the bound is. That is also why this is an `if` rather than a `while` -
    // one push can put the queue at most one over - and why it is cheaper than
    // the clamp-plus-loop form it replaces.
    const limit = (s.opts.bufferLimit ?? 256) | 0;
    q.push({ target: cmd.target, payload: cmd.payload, at: now });
    if (q.length > limit) {
      const dropped = q.shift()!; // push-first guarantees a non-empty queue here
      s.opts.onBufferOverflow?.(cmd.action, { target: dropped.target, payload: dropped.payload });
      if (DEV) {
        console.warn(`[vapor-chamber] onMissing:'buffer' queue for "${cmd.action}" hit bufferLimit (${limit}); dropped the oldest pending command. Register a handler, or raise bufferLimit.`);
      }
    }
    return okResult(undefined); // accepted; the real handler runs on register()
  }
  const err = new BusError(
    'VC_CORE_NO_HANDLER',
    `No handler registered for "${cmd.action}". Call bus.register("${cmd.action}", handler) first.` +
      // DEV only, and only with a plugin installed: a transport forwards just
      // the actions its `actions` filter matches, and any other falls through
      // next() to here, where "register a handler" is the wrong fix. The
      // production string is unchanged - this folds away with DEV.
      (DEV && s.pluginEntries.length !== 0
        ? " Or a transport plugin's `actions` filter did not match this action."
        : ''),
    { emitter: 'core', action: cmd.action },
  );
  if (mode === 'throw') throw err;
  if (typeof mode === 'function') {
    try { return mode(cmd); }
    catch (e) { return errResult(e as Error); }
  }
  return errResult(err);
}

/**
 * `handleMissing` behind an async frame, for the async bus's `execute`. That
 * closure returns `tryCatchAsyncHandler`'s promise directly instead of being
 * `async` itself (an `async` body that returns a promise adds a frame, a
 * promise and two resolve ticks per dispatch); this keeps `onMissing: 'throw'`
 * a rejection rather than a synchronous throw into the plugin chain.
 */
async function asyncMissing(s: AsyncState, cmd: Command, canDefer: boolean): Promise<CommandResult> {
  return handleMissing(s, cmd, canDefer);
}

/**
 * Replay commands buffered under `onMissing:'buffer'` for `action`, in FIFO
 * order, now that a handler exists. Re-dispatches through the full pipeline
 * (plugins, hooks, listeners). Sync buses run synchronously; async buses
 * fire-and-forget. Called from register() right after the handler is set.
 */
function flushDeferred(s: SyncState | AsyncState, action: string): void {
  /* v8 ignore next -- defensive: the only caller guards `deferred !== null` first */
  if (s.deferred === null) return;
  const q = s.deferred.get(action);
  if (q === undefined || q.length === 0) return;
  s.deferred.delete(action);
  const isAsync = 'pendingRequests' in s;
  const ttl = s.opts.bufferTTL;
  const now = ttl !== undefined && ttl > 0 ? Date.now() : 0;
  for (let i = 0; i < q.length; i++) {
    const { target, payload, at } = q[i];
    if (now !== 0 && now - at > ttl!) {
      s.opts.onBufferOverflow?.(action, { target, payload });
      continue; // expired while waiting - don't replay stale commands
    }
    if (isAsync) void asyncDispatch(s as AsyncState, action, target, payload);
    else syncDispatch(s as SyncState, action, target, payload);
  }
}

function syncRunHooks(s: SyncState, cmd: Command, result: CommandResult): void {
  // V8 opt: index-based loops with length snapshot - avoids .slice() allocation
  const ah = s.afterHooks;
  for (let i = 0, len = ah.length; i < len; i++) {
    try { ah[i](cmd, result); } catch (e) { console.error('[vapor-chamber] Hook error:', e); }
  }
  fanOutListeners(s.exactListeners, s.wildcardListeners, cmd.action, cmd, result);
}

/**
 * The runner, for dispatch: a throw that escapes it is SETTLED first - the
 * after-hooks and listeners see it as an errResult - and then re-thrown. A
 * caller that chose `onMissing: 'throw'` still gets its throw, and every
 * observer that saw the start (a before-hook, `isLoading`) also sees the end;
 * before, that key stayed true. Only onMissing's NO_HANDLER can escape the
 * runner now (a plugin's throw is already a result, see pluginThrew). A
 * function of its own, like tryCatchHandler, so `_syncDispatchInner` stays
 * free of try - see syncQuery's note on why dispatch splits.
 * Pinned by tests/command-loading-fixture.test.ts and tests/plugin-throw-fixture.test.ts.
 */
function syncRunSettling(s: SyncState, cmd: Command, execute: () => CommandResult): CommandResult {
  try { return s.runner(cmd, execute); }
  catch (e) { syncRunHooks(s, cmd, errResult(e as Error)); throw e; }
}

function syncDispatch(s: SyncState, action: string, target: any, payload?: any, executeOverride?: () => CommandResult): CommandResult {
  if (s.dispatchDepth >= MAX_DISPATCH_DEPTH) {
    return maxDepthResult(action);
  }
  s.dispatchDepth++;
  try { return _syncDispatchInner(s, action, target, payload, executeOverride); }
  finally { s.dispatchDepth--; }
}

function _syncDispatchInner(s: SyncState, action: string, target: any, payload?: any, executeOverride?: () => CommandResult): CommandResult {
  if (s.opts.naming !== undefined) validateNaming(action, s.opts.naming);
  const cmd: Command = { action, target, payload, meta: stampMeta(payload) };

  // Bare-bus fast path. When the bus has no plugins / hooks / listeners
  // and there's no executeOverride (request/respond path), skip the runner
  // indirection and the post-dispatch hook + listener walk. Direct
  // handler call. The five length/size reads are O(1) property accesses.
  // (A cached `isBare` boolean was tested and showed a 25% regression vs
  // these direct reads - V8's tight ICs on Map.size / Array.length already
  // optimize the inline check; adding a state field changed the hidden
  // class for no benefit. See CHANGELOG performance section.)
  if (
    executeOverride === undefined &&
    s.pluginEntries.length === 0 &&
    s.beforeHooks.length === 0 &&
    s.afterHooks.length === 0 &&
    s.exactListeners.size === 0 &&
    s.wildcardListeners.length === 0
  ) {
    const handler = s.handlers.get(action);
    if (handler === undefined) return handleMissing(s, cmd, true);
    return tryCatchHandler(handler, cmd);
  }

  // onMissing:'buffer' - when there's no handler yet, queue WITHOUT running the
  // pipeline (plugins/hooks/listeners must fire on replay, not now). The
  // bare-path above already buffers correctly (nothing fires there). Skipped
  // for the request/respond path (executeOverride) and non-buffer buses.
  if (executeOverride === undefined && s.opts.onMissing === 'buffer' && !s.handlers.has(action)) {
    return handleMissing(s, cmd, true);
  }

  // V8 opt: index-based loop, no .slice()
  const bh = s.beforeHooks;
  for (let i = 0, len = bh.length; i < len; i++) {
    try { bh[i](cmd); }
    catch (e) {
      const result = errResult(beforeCancel(e, action));
      syncRunHooks(s, cmd, result);
      return result;
    }
  }
  const execute = executeOverride ?? ((): CommandResult => {
    const handler = s.handlers.get(action);
    if (!handler) return handleMissing(s, cmd, true);
    return tryCatchHandler(handler, cmd);
  });
  // Only an `onMissing: 'throw'` bus can have a throw escape the runner, so
  // only that bus pays syncRunSettling's frame; every other bus keeps the
  // bare call it had (speed over size - the check costs bytes, not time).
  const result = s.opts.onMissing === 'throw' ? syncRunSettling(s, cmd, execute) : s.runner(cmd, execute);
  devWarnThenableResult(result, action);
  syncRunHooks(s, cmd, result);
  return result;
}

// Dev-only footgun guard: an ASYNC plugin (retry, createHttpBridge, ...) on a
// SYNC bus makes the runner return the plugin's Promise as the CommandResult -
// `result.ok` is undefined and every dispatch silently "fails". Warn once per
// action in dev.
//
// Keeping the check off the per-dispatch path still matters: `process.env`
// reads go through a slow C++ interceptor, and an inline read measured ~150 ns
// here (3 plugins + 1 listener bench dropped 1,240 -> 350 ops/s). `DEV` is a
// module-level const for that reason, and now also so the build can fold it -
// see src/dev.ts. The comment that used to sit here explained that a BARE
// `process.env.NODE_ENV` literal was load-bearing for define-replacement,
// which is no longer how this works: the ESM build emits that expression from
// the `__VC_DEV__` define, and the IIFE builds fold it to `false` outright,
// which is what finally drops the warning STRINGS from production rather than
// just the branch.
//
// The once-per-action set is allocated on first use INSIDE the DEV branch, so
// a production build - where DEV folds to false - neither allocates it at
// module load nor keeps it. Vue 3.6.0-rc.8 (commit 24) moved its own dev-only
// fallthrough bookkeeping behind __DEV__ the same way.
let _thenableWarned: Set<string> | undefined;
function devWarnThenableResult(result: CommandResult, action: string): void {
  if (DEV) {
    if (result && typeof (result as unknown as PromiseLike<unknown>).then === 'function' && !(_thenableWarned ||= new Set()).has(action)) {
      _thenableWarned.add(action);
      console.warn(
        `[vapor-chamber] dispatch("${action}") on a SYNC bus returned a Promise - an async plugin ` +
        `(retry, createHttpBridge, ...) is installed on a bus created with createCommandBus(). ` +
        `Use createAsyncCommandBus() instead; result.ok is undefined on this dispatch.`,
      );
    }
  }
}

/**
 * Read-only query - skips beforeHooks, runs handler + plugins, fires afterHooks.
 *
 * One function, not a wrapper around an `_inner`. `dispatch` splits because the
 * outer half owns the depth guard's `try/finally` and V8 keeps the inner half
 * optimizable without it; `query` and `emit` have no guard to hoist, so their
 * wrappers forwarded their arguments unchanged and did nothing else.
 */
function syncQuery(s: SyncState, action: string, target: any, payload?: any): CommandResult {
  if (s.opts.naming !== undefined) validateNaming(action, s.opts.naming);
  const cmd: Command = { action, target, payload, meta: stampMeta(payload) };
  // Bare-bus fast path - mirrors the one in _syncDispatchInner. Queries skip
  // beforeHooks by design so the condition omits that check.
  if (
    s.pluginEntries.length === 0 &&
    s.afterHooks.length === 0 &&
    s.exactListeners.size === 0 &&
    s.wildcardListeners.length === 0
  ) {
    const handler = s.handlers.get(action);
    if (handler === undefined) return handleMissing(s, cmd, false);
    return tryCatchHandler(handler, cmd);
  }
  // Skip beforeHooks - queries don't trigger mutation gates (auth, loading spinners, etc.)
  const execute = (): CommandResult => {
    const handler = s.handlers.get(action);
    if (!handler) return handleMissing(s, cmd, false);
    return tryCatchHandler(handler, cmd);
  };
  const result = s.runner(cmd, execute);
  devWarnThenableResult(result, action);
  syncRunHooks(s, cmd, result);
  return result;
}

/** Fire a domain event - notifies on() listeners, no handler required, no result. */
function syncEmit(s: SyncState, event: string, data?: any): void {
  // Fast path: no listeners -> return without allocating anything. Real apps
  // emit many events with no subscribers (lifecycle, debug, conditional
  // listeners) - this branch turns those into a hash lookup + length check.
  if (!s.exactListeners.has(event) && s.wildcardListeners.length === 0) return;

  // emit is fire-and-forget - meta (id/correlationId/causationId) is unused
  // by the typical listener, so skip stampMeta to avoid the uid() call and
  // 4-field object allocation. Listeners that DO need meta on an emit can
  // call dispatch instead. The Command type already has `meta?` as optional.
  const cmd: Command = { action: event, target: data };
  fanOutListeners(s.exactListeners, s.wildcardListeners, event, cmd, EMIT_RESULT);
}

/**
 * `BatchOptions` documents `transactional` as "mutually exclusive with
 * `continueOnError`", but nothing enforced it: code order silently let
 * transactional win, so a caller who set both got all-or-nothing semantics
 * while reading their own options as best-effort. Loud in dev, per the
 * house convention.
 */
function warnBatchOptionConflict(opts: BatchOptions): void {
  if (DEV && opts.transactional && opts.continueOnError) {
    console.warn(
      '[vapor-chamber] dispatchBatch({ transactional: true, continueOnError: true }) - these are ' +
        'mutually exclusive. `transactional` wins: the batch stops at the first failure and rolls back. ' +
        'Drop one of the two.',
    );
  }
}

function syncDispatchBatch(s: SyncState, commands: BatchCommand[], opts: BatchOptions = {}): BatchResult {
  warnBatchOptionConflict(opts);
  const results: CommandResult[] = [];
  let firstError: Error | undefined;
  let failCount = 0;
  for (let ci = 0; ci < commands.length; ci++) {
    const { action, target, payload } = commands[ci];
    const result = syncDispatch(s, action, target, payload);
    results.push(result);
    if (!result.ok) {
      failCount++;
      if (opts.transactional) {
        // Rollback: run undo handlers for all previously succeeded commands in reverse order
        const rollbacks = syncRollback(s, commands, results, ci);
        return { ok: false, results, error: result.error, successCount: ci, failCount: 1, rollbacks };
      }
      if (!opts.continueOnError) return { ok: false, results, error: result.error, successCount: results.length - failCount, failCount };
      if (!firstError) firstError = result.error;
    }
  }
  const successCount = results.length - failCount;
  return firstError ? { ok: false, results, error: firstError, successCount, failCount } : { ok: true, results, successCount, failCount };
}

/** Run undo handlers for commands 0..failedAt-1 that succeeded, in reverse order. */
function syncRollback(s: SyncState, commands: BatchCommand[], results: CommandResult[], failedAt: number): CommandResult[] {
  const rollbacks: CommandResult[] = [];
  for (let j = failedAt - 1; j >= 0; j--) {
    /* v8 ignore next -- defensive: batch halts at first failure, so every j < failedAt is ok */
    if (!results[j].ok) continue;
    const undo = s.undoHandlers.get(commands[j].action);
    if (!undo) continue;
    const cmd: Command = { action: commands[j].action, target: commands[j].target, payload: commands[j].payload, meta: stampMeta(commands[j].payload) };
    try { rollbacks.push(okResult(undo(cmd))); }
    catch (e) { rollbacks.push(errResult(e as Error)); }
  }
  return rollbacks;
}


function syncUse(s: SyncState, plugin: Plugin, opts: PluginOptions = {}): () => void {
  assertNotSealed(s, 'use');
  // DEV-gated for the same reason as the register() overwrite warning: a
  // build-time wiring mistake, not a runtime condition. Gating `DEV` first also
  // skips the isAsyncFn() probe entirely in production.
  if (DEV && isAsyncFn(plugin)) {
    console.warn('[vapor-chamber] Async plugin installed on sync bus - use createAsyncCommandBus() instead.');
  }
  const entry = { plugin, priority: opts.priority ?? 0 };
  s.pluginEntries.push(entry);
  syncRebuildRunner(s);
  return () => { const i = s.pluginEntries.indexOf(entry); if (i !== -1) { s.pluginEntries.splice(i, 1); syncRebuildRunner(s); } };
}

// ---------------------------------------------------------------------------
// Shared listener and hook helpers - used by both sync and async buses.
// Both SyncState and AsyncState carry exactListeners/wildcardListeners with
// identical types, so a single implementation covers both.
// ---------------------------------------------------------------------------

type ListenerBucket = {
  exactListeners: Map<string, Listener[]>;
  wildcardListeners: WildcardEntry[];
};

// Self-polyfill: same `??=` idiom TS's own downlevel `using` helper applies,
// so whichever side runs first, both agree on the same well-known symbol -
// works whether the runtime has native Explicit Resource Management or not.
const _SYM_DISPOSE: symbol = ((Symbol as any).dispose ??= Symbol());

/**
 * Finish an on()/once() unsubscribe fn: bind it to `signal` (self-detaching,
 * fires at most once - the abort listener doubles as the manual-off path, so
 * there is only one removeEventListener site) and tag it with Symbol.dispose
 * so `using off = bus.on(...)` works. An already-aborted signal unsubscribes
 * synchronously before returning - same observable effect as never
 * subscribing, matches DOM `addEventListener`, no separate pre-check needed
 * in `on()`. Cold path - runs once per subscription, never touches dispatch.
 */
function finalizeOff(off: () => void, signal?: AbortSignal): () => void {
  if (signal) {
    const raw = off;
    off = () => { signal.removeEventListener('abort', off); raw(); };
    if (signal.aborted) off();
    else signal.addEventListener('abort', off);
  }
  (off as any)[_SYM_DISPOSE] = off;
  return off;
}

function on(s: ListenerBucket, pattern: string, listener: Listener, opts?: ListenerOptions): () => void {
  const signal = opts?.signal;
  if (isWildcardPattern(pattern)) {
    // Parse once, here, where the pattern has just been classified - see
    // WildcardEntry. Cold path: runs per subscription, never per dispatch.
    const entry: WildcardEntry = { pattern, prefix: pattern.slice(0, -1), listener };
    s.wildcardListeners.push(entry);
    return finalizeOff(() => { const i = s.wildcardListeners.indexOf(entry); if (i !== -1) s.wildcardListeners.splice(i, 1); }, signal);
  }
  let bucket = s.exactListeners.get(pattern);
  if (bucket === undefined) { bucket = []; s.exactListeners.set(pattern, bucket); }
  bucket.push(listener);
  return finalizeOff(() => {
    const b = s.exactListeners.get(pattern);
    if (b === undefined) return;
    const i = b.indexOf(listener);
    if (i !== -1) b.splice(i, 1);
    if (b.length === 0) s.exactListeners.delete(pattern);
  }, signal);
}

/**
 * once() unsubscribes itself *before* calling the listener - matches
 * DOM addEventListener({ once: true }) semantics.
 */
function once(s: ListenerBucket, pattern: string, listener: Listener, opts?: ListenerOptions): () => void {
  const unsub = on(s, pattern, (cmd, result) => { unsub(); listener(cmd, result); }, opts);
  return unsub;
}

function offAll(s: ListenerBucket, pattern?: string): void {
  if (pattern === undefined) {
    s.exactListeners.clear();
    s.wildcardListeners.length = 0;
    return;
  }
  if (isWildcardPattern(pattern)) {
    for (let i = s.wildcardListeners.length - 1; i >= 0; i--) {
      if (s.wildcardListeners[i].pattern === pattern) s.wildcardListeners.splice(i, 1);
    }
  } else {
    s.exactListeners.delete(pattern);
  }
}

function addHook<H>(s: { sealed: boolean }, hooks: H[], hook: H, method: string): () => void {
  assertNotSealed(s, method);
  hooks.push(hook);
  return () => { const i = hooks.indexOf(hook); if (i !== -1) hooks.splice(i, 1); };
}

function syncRequest(s: SyncState, action: string, target: any, payload?: any, reqOpts: { timeout?: number; signal?: AbortSignal } = {}): Promise<CommandResult> {
  const timeout = reqOpts.timeout ?? 5000;
  const signal = reqOpts.signal;
  const responder = s.responders.get(action);
  // Pre-flight abort, as on the async bus. The signal was in this function's
  // type and ignored by its body until v1.20.0.
  if (signal && signal.aborted) return Promise.resolve(abortedResult(action, signal));
  if (!responder) return Promise.resolve(syncDispatch(s, action, target, payload));

  // Route through the plugin chain with responder as the execute function
  const cmd: Command = { action, target, payload, meta: stampMeta(payload) };
  const execute = (): CommandResult => {
    try { return okResult(responder(cmd)); }
    catch (e) { return errResult(e as Error); }
  };

  // No try/catch: a throwing plugin is a VC_PLUGIN_THREW result now (see
  // pluginThrew), and `execute` is the responder, never onMissing.
  const pluginResult = s.runner(cmd, execute);

  syncRunHooks(s, cmd, pluginResult);

  // Unwrap async responder value if needed
  const maybeAsync = pluginResult.value;
  // Only a pending value can time out or be cancelled, so only it takes the
  // timer and the cancel below; every other result settles as it is. Until
  // v1.20.0 every request armed the timer first, inside a Promise executor,
  // and cleared it on the way out - the sync-responder row of
  // tests/request-dispose-ab.test.ts measures the difference.
  if (!pluginResult.ok || !maybeAsync || typeof maybeAsync.then !== 'function') return Promise.resolve(pluginResult);

  // `cmd` keeps the four fields every sync command has: the caller's signal
  // settles THIS promise and never reaches the responder (see Command.signal
  // and the shape note in docs/performance.md). One closure serves both
  // dispose(), which runs it (see SyncState.waiting), and the caller's abort:
  // abortedResult reads a reason only off an aborted signal, so from
  // dispose() it is the plain VC_CORE_ABORTED either way.
  const pending = (s.waiting ||= new Set());
  return new Promise((resolve) => {
    const done = (r: CommandResult): void => {
      clearTimeout(timeoutId);
      pending.delete(cancel);
      if (signal) signal.removeEventListener('abort', cancel);
      resolve(r);
    };
    const cancel = (): void => done(abortedResult(action, signal));
    const timeoutId = setTimeout(() => done(requestTimeoutResult(action, timeout)), timeout);
    pending.add(cancel);
    if (signal) signal.addEventListener('abort', cancel);
    maybeAsync.then((v: any) => done(okResult(v)), (e: Error) => done(errResult(e)));
  });
}

function syncRespond(s: SyncState, action: string, handler: (cmd: Command) => any | Promise<any>): () => void {
  assertNotSealed(s, 'respond');
  validateNaming(action, s.opts.naming);
  s.responders.set(action, handler);
  return () => s.responders.delete(action);
}

function syncClear(s: SyncState): void {
  clearState(s);
  s.runner = buildRunner([]);
}

function syncDispose(s: SyncState): void {
  // Plugin dispose() first, before clear() drops the entries: debounce and
  // throttle cancel their timers, retry ends its backoff sleeps. Cold path.
  for (let i = s.pluginEntries.length - 1; i >= 0; i--) s.pluginEntries[i].plugin.dispose?.();
  syncClear(s);
  for (const timer of s.throttleTimers) clearTimeout(timer);
  s.throttleTimers.clear();
  // Each cancel settles its request, which removes itself (see syncRequest).
  if (s.waiting) for (const cancel of s.waiting) cancel();
}

// ---------------------------------------------------------------------------
// createCommandBus
// ---------------------------------------------------------------------------

/**
 * Create a synchronous command bus.
 *
 * @example
 * // Basic usage
 * const bus = createCommandBus();
 * bus.register('cart/add', (cmd) => addToCart(cmd.target, cmd.payload));
 * const result = bus.dispatch('cart/add', { id: 1 }, { qty: 2 });
 * if (result.ok) console.log('Added:', result.value);
 *
 * @example
 * // Type-safe with CommandMap
 * type App = {
 *   'cart/add': { target: { id: number }; payload: { qty: number }; result: void };
 * };
 * const bus = createCommandBus<App>();
 * bus.dispatch('cart/add', { id: 1 }, { qty: 2 }); // fully typed
 *
 * @example
 * // With plugins, hooks, and listeners
 * const bus = createCommandBus();
 * bus.use(logger());          // plugin wraps every dispatch
 * bus.onBefore((cmd) => { }); // runs before handler, throw to cancel
 * bus.onAfter((cmd, res) => { }); // runs after handler
 * bus.on('cart/*', (cmd, res) => { }); // wildcard listener
 */
export function createCommandBus<M extends CommandMap = CommandMap>(options: CommandBusOptions = {}): CommandBus<M> {
  const s: SyncState = {
    opts: options,
    handlers: new Map(), undoHandlers: new Map(),
    pluginEntries: [], beforeHooks: [], afterHooks: [],
    exactListeners: new Map(), wildcardListeners: [],
    responders: new Map(),
    runner: buildRunner([]),
    dispatchDepth: 0,
    sealed: false,
    throttleTimers: new Set(),
    // Lazily allocated on the first buffered command (handleMissing), not here -
    // a buffer-mode bus whose handlers always beat its dispatches allocates nothing.
    deferred: null,
    waiting: null,
  };
  const bus: CommandBus<M> = {
    // Sync bus accepts the options arg for type compatibility with BaseBus,
    // but ignores `signal` - sync dispatches are atomic and not cancelable.
    dispatch:          (a, t, p, _o)   => syncDispatch(s, a as string, t, p),
    query:             (a, t, p)       => syncQuery(s, a as string, t, p),
    emit:              (e, d)          => syncEmit(s, e, d),
    dispatchBatch:     (cmds, o)       => syncDispatchBatch(s, cmds, o),
    register:          (a, h, o)       => register(s, a as string, h as Handler, o),
    use:               (p, o)          => syncUse(s, p, o),
    onBefore:          (h)             => addHook(s, s.beforeHooks, h, 'onBefore'),
    onAfter:           (h)             => addHook(s, s.afterHooks, h, 'onAfter'),
    on:                (pat, l, o)      => on(s, pat, l, o),
    once:              (pat, l, o)      => once(s, pat, l, o),
    offAll:            (pat)           => offAll(s, pat),
    request:           (a, t, p, o)   => syncRequest(s, a as string, t, p, o),
    respond:           (a, h)          => syncRespond(s, a, h),
    hasHandler:        (a)             => s.handlers.has(a),
    registeredActions: ()              => Array.from(s.handlers.keys()),
    getUndoHandler:    (a)             => s.undoHandlers.get(a),
    clear:             ()              => { assertNotSealed(s, 'clear'); syncClear(s); },
    dispose:           ()              => syncDispose(s),
    seal:              ()              => { s.sealed = true; },
    isSealed:          ()              => s.sealed,
  };
  // Symbol keys for tree-shakeable introspection - not on the public interface
  (bus as any)[_UNSEAL] = () => { s.sealed = false; };
  (bus as any)[_INSPECT] = () => inspect(s);
  return bus;
}

// ---------------------------------------------------------------------------
// Async runner
// ---------------------------------------------------------------------------

// Same shape and same reasoning as `buildRunner` above - and here a
// save/restore cursor would be unsound for a second reason on top of deferred
// continuations: `plugin(cmd, next)` returns a PENDING PROMISE, so a `finally`
// fires while the chain below is still running. That is exactly the
// flag-across-await bug this release replaced with `__origin` elsewhere.
//
// The async case is also the one that bites hardest: `retry()` +
// `createHttpBridge` is the canonical pairing, and with a shared cursor
// attempt 2 skipped the bridge entirely, reporting a local outcome the server
// never saw. The async path is dominated by the awaits around it, so the
// per-level closure does not register here.
function buildAsyncRunner(plugins: AsyncPlugin[]) {
  return function run(cmd: Command, execute: () => Promise<CommandResult>): Promise<CommandResult> {
    // What the most recent level returned. The async boundary (see
    // pluginThrew) has two ways to fail: a synchronous throw from the plugin's
    // body, and a rejection of the promise it returns, caught on THIS level's
    // promise so the plugin above sees a resolved errResult from `next()`.
    // Except when the plugin returned exactly `last` - the value its `next()`
    // produced, a pass-through. That value comes converted from the level
    // below (or is execute's, which rejects only with onMissing's NO_HANDLER,
    // which pluginThrew hands on unchanged anyway), so wrapping it again
    // changes nothing but costs a promise and a microtask per level - the
    // declinedWrapEvery arm of tests/plugin-throw-ab.test.ts measures it.
    let last: unknown;
    function nextFrom(idx: number): CommandResult | Promise<CommandResult> {
      const plugin = plugins[idx];
      if (!plugin) return (last = execute());
      let r: CommandResult | Promise<CommandResult>;
      try { r = plugin(cmd, () => nextFrom(idx + 1)); }
      catch (e) { return pluginThrew(e, cmd, plugin, idx); }
      return (last = r !== last && r != null && typeof (r as PromiseLike<CommandResult>).then === 'function'
        ? (r as Promise<CommandResult>).then(undefined, (e: unknown) => pluginThrew(e, cmd, plugin, idx))
        : r);
    }
    return Promise.resolve(nextFrom(0));
  };
}

// ---------------------------------------------------------------------------
// Module-level async bus operations
// ---------------------------------------------------------------------------

function asyncRebuildRunner(s: AsyncState): void {
  s.runner = buildAsyncRunner(s.pluginEntries.slice().sort(byPriority).map(e => e.plugin));
}

// Returns void (not a promise) when there are no after-hooks, so callers can
// skip the await entirely - an async frame + microtask hop per dispatch
// otherwise, even on a bus with zero hooks. Callers: `const h = asyncRunHooks(...);
// if (h) await h;`
function asyncRunHooks(s: AsyncState, cmd: Command, result: CommandResult): void | Promise<void> {
  if (s.afterHooks.length === 0) {
    fanOutListeners(s.exactListeners, s.wildcardListeners, cmd.action, cmd, result);
    return;
  }
  return asyncRunAfterHooks(s, cmd, result);
}

async function asyncRunAfterHooks(s: AsyncState, cmd: Command, result: CommandResult): Promise<void> {
  // V8 opt: index-based loops, no .slice(). Sync hooks (loggers, guards) are
  // the common case - the thenable check saves a microtask hop per hook.
  const ah = s.afterHooks;
  for (let i = 0, len = ah.length; i < len; i++) {
    try {
      const r = ah[i](cmd, result) as unknown;
      if (r && typeof (r as PromiseLike<void>).then === 'function') await r;
    } catch (e) { console.error('[vapor-chamber] Hook error:', e); }
  }
  fanOutListeners(s.exactListeners, s.wildcardListeners, cmd.action, cmd, result);
}

async function asyncDispatch(s: AsyncState, action: string, target: any, payload?: any, executeOverride?: () => Promise<CommandResult>, signal?: AbortSignal): Promise<CommandResult> {
  if (s.dispatchDepth >= MAX_DISPATCH_DEPTH) {
    return maxDepthResult(action);
  }
  s.dispatchDepth++;
  try { return await _asyncDispatchInner(s, action, target, payload, executeOverride, signal); }
  finally { s.dispatchDepth--; }
}

/**
 * Build a stable AbortError result. Prefers a user-provided explicit reason
 * (e.g. `ac.abort(new MyError('cancelled'))`) over the lib's BusError, but
 * falls back to BusError for the default `ac.abort()` case so consumers can
 * switch on `error.code === 'VC_CORE_ABORTED'`.
 *
 * After-hooks still fire from the caller, so observability is intact.
 *
 * `signal` is optional since v1.20.0: dispose() settles a waiting request() with
 * none, and gets the BusError.
 * @internal - also used by transports.ts for mid-flight signal handling.
 */
export function abortedResult(action: string, signal?: AbortSignal): CommandResult {
  const reason = signal && (signal as any).reason;
  // Default DOMException (name: 'AbortError') is what `ac.abort()` produces
  // with no arg; substitute our BusError so the code field is queryable.
  const isDefaultAbort = reason && reason.name === 'AbortError' && reason.constructor !== BusError;
  if (reason instanceof Error && !isDefaultAbort) return errResult(reason);
  return errResult(new BusError('VC_CORE_ABORTED', `Dispatch "${action}" was aborted.`, { emitter: 'core', action }));
}

async function _asyncDispatchInner(s: AsyncState, action: string, target: any, payload?: any, executeOverride?: () => Promise<CommandResult>, signal?: AbortSignal): Promise<CommandResult> {
  if (s.opts.naming !== undefined) validateNaming(action, s.opts.naming);
  const cmd: Command = { action, target, payload, meta: stampMeta(payload), signal };

  // Pre-flight abort: if the signal is already tripped, skip the handler entirely.
  // After-hooks still run so loggers / metrics see the aborted command.
  if (signal?.aborted) {
    const result = abortedResult(action, signal);
    const h = asyncRunHooks(s, cmd, result);
    if (h) await h;
    return result;
  }

  // Note: a bare-bus fast path was tested for async dispatch and showed no
  // measurable win (3,586 -> 3,360 ops/sec across 3 runs - within noise, may
  // be a slight regression). The async path's await + Promise machinery is
  // a larger fraction of the per-call cost than the runner indirection, so
  // skipping the runner doesn't move the needle. Sync dispatch DID win
  // (+18%) so the same fast path is kept in `_syncDispatchInner`.

  // onMissing:'buffer' - queue WITHOUT running the pipeline when no handler yet
  // (plugins/hooks/listeners fire on replay, not now). Skipped for request/respond.
  if (executeOverride === undefined && s.opts.onMissing === 'buffer' && !s.handlers.has(action)) {
    return handleMissing(s, cmd, true);
  }

  // V8 opt: index-based loop, no .slice(). Sync before-hooks (guards, loggers)
  // are the common case - the thenable check skips a microtask hop per hook.
  const bh = s.beforeHooks;
  for (let i = 0, len = bh.length; i < len; i++) {
    try {
      const r = bh[i](cmd) as unknown;
      if (r && typeof (r as PromiseLike<void>).then === 'function') await r;
    }
    catch (e) {
      const result = errResult(beforeCancel(e, action));
      const h = asyncRunHooks(s, cmd, result);
      if (h) await h;
      return result;
    }
  }
  const execute = executeOverride ?? ((): Promise<CommandResult> => {
    const handler = s.handlers.get(action);
    return handler ? tryCatchAsyncHandler(handler, cmd) : asyncMissing(s, cmd, true);
  });
  // Settle, then re-throw - the async side of syncRunSettling. This function
  // is already async with a try in the before-hook loop above, so it gains
  // no frame and no promise for it.
  let result: CommandResult;
  try { result = await s.runner(cmd, execute); }
  catch (e) { const h = asyncRunHooks(s, cmd, errResult(e as Error)); if (h) await h; throw e; }
  const h = asyncRunHooks(s, cmd, result);
  if (h) await h;
  return result;
}

/**
 * Async read-only query - skips beforeHooks, runs handler + plugins, fires
 * afterHooks.
 *
 * One function, not a wrapper. This one was not merely free indirection: the
 * wrapper was itself `async` and its whole body was `return await inner(...)`,
 * so every query allocated a second promise and resumed a second async frame -
 * one extra microtask turn per query, on top of the awaits it actually needs.
 * `dispatch` keeps its split because the outer half owns the depth guard's
 * `try/finally`; a query has no guard to hoist.
 */
async function asyncQuery(s: AsyncState, action: string, target: any, payload?: any): Promise<CommandResult> {
  if (s.opts.naming !== undefined) validateNaming(action, s.opts.naming);
  const cmd: Command = { action, target, payload, meta: stampMeta(payload) };
  const execute = (): Promise<CommandResult> => {
    const handler = s.handlers.get(action);
    return handler ? tryCatchAsyncHandler(handler, cmd) : asyncMissing(s, cmd, false);
  };
  const result = await s.runner(cmd, execute);
  const h = asyncRunHooks(s, cmd, result);
  if (h) await h;
  return result;
}

/** Async emit - notifies on() listeners, no handler required, no result. */
function asyncEmit(s: AsyncState, event: string, data?: any): void {
  // Same fast path + minimal-allocation strategy as syncEmit. See that
  // function's comment block for the full reasoning.
  if (!s.exactListeners.has(event) && s.wildcardListeners.length === 0) return;
  const cmd: Command = { action: event, target: data };
  fanOutListeners(s.exactListeners, s.wildcardListeners, event, cmd, EMIT_RESULT);
}

async function asyncDispatchBatch(s: AsyncState, commands: BatchCommand[], opts: BatchOptions = {}): Promise<BatchResult> {
  warnBatchOptionConflict(opts);
  const signal = opts.signal;
  const results: CommandResult[] = [];
  let firstError: Error | undefined;
  let failCount = 0;

  // Pre-flight abort - return without dispatching anything.
  if (signal?.aborted) {
    const abortErr = abortedResult('batch', signal).error!;
    return { ok: false, results: [], error: abortErr, successCount: 0, failCount: 0 };
  }

  for (let ci = 0; ci < commands.length; ci++) {
    // Mid-flight abort - stop dispatching further commands. Already-completed
    // results are kept for inspection; abortError is the result error.
    if (signal?.aborted) {
      const abortErr = abortedResult('batch', signal).error!;
      const successCount = results.length - failCount;
      if (opts.transactional && successCount > 0) {
        const rollbacks = await asyncRollback(s, commands, results, results.length);
        return { ok: false, results, error: abortErr, successCount: 0, failCount, rollbacks };
      }
      return { ok: false, results, error: abortErr, successCount, failCount };
    }

    const { action, target, payload } = commands[ci];
    // Per-command signal flows through dispatch so individual handlers can observe abort.
    const result = await asyncDispatch(s, action, target, payload, undefined, signal);
    results.push(result);
    if (!result.ok) {
      failCount++;
      if (opts.transactional) {
        const rollbacks = await asyncRollback(s, commands, results, ci);
        return { ok: false, results, error: result.error, successCount: ci, failCount: 1, rollbacks };
      }
      if (!opts.continueOnError) return { ok: false, results, error: result.error, successCount: results.length - failCount, failCount };
      if (!firstError) firstError = result.error;
    }
  }
  const successCount = results.length - failCount;
  return firstError ? { ok: false, results, error: firstError, successCount, failCount } : { ok: true, results, successCount, failCount };
}

/** Async rollback: run undo handlers for commands 0..failedAt-1 that succeeded, in reverse order. */
async function asyncRollback(s: AsyncState, commands: BatchCommand[], results: CommandResult[], failedAt: number): Promise<CommandResult[]> {
  const rollbacks: CommandResult[] = [];
  for (let j = failedAt - 1; j >= 0; j--) {
    /* v8 ignore next -- defensive: batch halts at first failure, so every j < failedAt is ok */
    if (!results[j].ok) continue;
    const undo = s.undoHandlers.get(commands[j].action);
    if (!undo) continue;
    const cmd: Command = { action: commands[j].action, target: commands[j].target, payload: commands[j].payload, meta: stampMeta(commands[j].payload) };
    try {
      const r = undo(cmd);
      rollbacks.push(okResult(r && typeof r.then === 'function' ? await r : r));
    } catch (e) { rollbacks.push(errResult(e as Error)); }
  }
  return rollbacks;
}

function asyncUse(s: AsyncState, plugin: AsyncPlugin, opts: PluginOptions = {}): () => void {
  assertNotSealed(s, 'use');
  const entry = { plugin, priority: opts.priority ?? 0 };
  s.pluginEntries.push(entry);
  asyncRebuildRunner(s);
  return () => { const i = s.pluginEntries.indexOf(entry); if (i !== -1) { s.pluginEntries.splice(i, 1); asyncRebuildRunner(s); } };
}


async function asyncRequest(s: AsyncState, action: string, target: any, payload?: any, reqOpts: { timeout?: number; signal?: AbortSignal } = {}): Promise<CommandResult> {
  const timeout = reqOpts.timeout ?? 5000;
  const signal = reqOpts.signal;
  const responder = s.responders.get(action);

  // Pre-flight abort - return immediately, don't dedup or dispatch.
  if (signal?.aborted) return abortedResult(action, signal);

  // Dedup key - the canonical commandKey: order-independent and nested-faithful,
  // so the same logical request collapses regardless of key order while distinct
  // nested targets stay separate (no false-dedup). Shared with debounce/throttle/cache.
  const dedupKey = commandKey(action, target);

  // If an identical request is already in-flight, piggyback on it
  const inflight = s.pendingRequests.get(dedupKey);
  if (inflight) return inflight;

  // Route through the plugin chain with responder as the execute function.
  // The signal also flows to cmd.signal so the responder can observe abort.
  const executeOverride = responder ? async (): Promise<CommandResult> => {
    try { return okResult(await responder({ action, target, payload, meta: stampMeta(payload), signal } as Command)); }
    catch (e) { return errResult(e as Error); }
  } : undefined;

  const dispatchPromise = asyncDispatch(s, action, target, payload, executeOverride, signal);

  const pending = (s.waiting ||= new Set());
  let timeoutId: ReturnType<typeof setTimeout>;
  let cancel!: () => void;
  const timeoutPromise = new Promise<CommandResult>((resolve) => {
    timeoutId = setTimeout(
      () => resolve(requestTimeoutResult(action, timeout)),
      timeout
    );
    // What dispose() runs (see AsyncState.waiting): it settles the race through
    // the promise the timer already owns, so it adds no promise and no listener.
    pending.add(cancel = () => resolve(abortedResult(action)));
  });

  // Mid-flight abort - race against dispatchPromise and timeoutPromise so the
  // caller can cancel without waiting for the responder.
  let abortHandler: (() => void) | null = null;
  const abortPromise = signal
    ? new Promise<CommandResult>((resolve) => {
        abortHandler = () => resolve(abortedResult(action, signal));
        signal.addEventListener('abort', abortHandler);
      })
    : null;

  const competitors: Promise<CommandResult>[] = [
    dispatchPromise.then((r) => { clearTimeout(timeoutId!); return r; }),
    timeoutPromise,
  ];
  if (abortPromise) competitors.push(abortPromise);

  const racePromise = Promise.race(competitors).finally(() => {
    s.pendingRequests.delete(dedupKey);
    pending.delete(cancel);
    if (abortHandler && signal) signal.removeEventListener('abort', abortHandler);
    clearTimeout(timeoutId!);
  });

  s.pendingRequests.set(dedupKey, racePromise);
  return racePromise;
}

function asyncRespond(s: AsyncState, action: string, handler: (cmd: Command) => any | Promise<any>): () => void {
  assertNotSealed(s, 'respond');
  validateNaming(action, s.opts.naming);
  s.responders.set(action, handler);
  return () => s.responders.delete(action);
}

function asyncClear(s: AsyncState): void {
  clearState(s);
  s.pendingRequests.clear();
  s.runner = buildAsyncRunner([]);
}

function asyncDispose(s: AsyncState): void {
  // Plugin dispose() first, before clear() drops the entries: debounce and
  // throttle cancel their timers, retry ends its backoff sleeps. Cold path.
  for (let i = s.pluginEntries.length - 1; i >= 0; i--) s.pluginEntries[i].plugin.dispose?.();
  asyncClear(s);
  for (const timer of s.throttleTimers) clearTimeout(timer);
  s.throttleTimers.clear();
  // Each cancel settles its request's race, whose finally removes it (see asyncRequest).
  if (s.waiting) for (const cancel of s.waiting) cancel();
}

// ---------------------------------------------------------------------------
// createAsyncCommandBus
// ---------------------------------------------------------------------------

/**
 * Create an asynchronous command bus. Handlers return Promises.
 *
 * @example
 * const bus = createAsyncCommandBus();
 * bus.register('user/fetch', async (cmd) => {
 *   const user = await fetch(`/api/users/${cmd.target.id}`).then(r => r.json());
 *   return user;
 * });
 * const result = await bus.dispatch('user/fetch', { id: 42 });
 * if (result.ok) console.log(result.value); // { name: 'Alice', ... }
 */
export function createAsyncCommandBus<M extends CommandMap = CommandMap>(options: CommandBusOptions = {}): AsyncCommandBus<M> {
  const s: AsyncState = {
    opts: options,
    handlers: new Map(), undoHandlers: new Map(),
    pluginEntries: [], beforeHooks: [], afterHooks: [],
    exactListeners: new Map(), wildcardListeners: [],
    responders: new Map(),
    pendingRequests: new Map(),
    runner: buildAsyncRunner([]),
    dispatchDepth: 0,
    sealed: false,
    throttleTimers: new Set(),
    // Lazily allocated on the first buffered command (handleMissing), not here -
    // a buffer-mode bus whose handlers always beat its dispatches allocates nothing.
    deferred: null,
    waiting: null,
  };
  const bus: AsyncCommandBus<M> = {
    dispatch:          (a, t, p, o)  => asyncDispatch(s, a as string, t, p, undefined, o?.signal),
    query:             (a, t, p)     => asyncQuery(s, a as string, t, p),
    emit:              (e, d)        => asyncEmit(s, e, d),
    dispatchBatch:     (cmds, o)     => asyncDispatchBatch(s, cmds, o),
    register:          (a, h, o)     => register(s, a as string, h as AsyncHandler, o),
    use:               (p, o)        => asyncUse(s, p, o),
    onBefore:          (h)           => addHook(s, s.beforeHooks, h, 'onBefore'),
    onAfter:           (h)           => addHook(s, s.afterHooks, h, 'onAfter'),
    on:                (pat, l, o)    => on(s, pat, l, o),
    once:              (pat, l, o)    => once(s, pat, l, o),
    offAll:            (pat)         => offAll(s, pat),
    request:           (a, t, p, o)  => asyncRequest(s, a as string, t, p, o),
    respond:           (a, h)        => asyncRespond(s, a, h),
    hasHandler:        (a)           => s.handlers.has(a),
    registeredActions: ()            => Array.from(s.handlers.keys()),
    getUndoHandler:    (a)           => s.undoHandlers.get(a),
    clear:             ()            => { assertNotSealed(s, 'clear'); asyncClear(s); },
    dispose:           ()            => asyncDispose(s),
    seal:              ()            => { s.sealed = true; },
    isSealed:          ()            => s.sealed,
  };
  // Symbol keys for tree-shakeable introspection - not on the public interface
  (bus as any)[_UNSEAL] = () => { s.sealed = false; };
  (bus as any)[_INSPECT] = () => inspect(s);
  return bus;
}

// ---------------------------------------------------------------------------
// unsealBus - dev/HMR only, tree-shakeable in production
// ---------------------------------------------------------------------------

/**
 * Unseal a sealed bus. **Dev/HMR only** - if your production code never imports
 * `unsealBus`, it gets tree-shaken out entirely, making `seal()` irreversible.
 *
 * @example
 * // vite-hmr.ts
 * import { unsealBus } from 'vapor-chamber';
 * if (import.meta.hot) {
 *   unsealBus(bus);
 *   bus.clear();
 *   // re-register handlers...
 *   bus.seal();
 * }
 */
export function unsealBus(bus: BaseBus): void {
  const fn = (bus as any)[_UNSEAL];
  if (typeof fn === 'function') fn();
}

// ---------------------------------------------------------------------------
// inspectBus - dev/debug only, tree-shakeable in production
// ---------------------------------------------------------------------------

/**
 * Complete snapshot of a bus's internal topology.
 * Returned by `inspectBus()` for debugging, DevTools, and ops diagnostics.
 *
 * @example
 * import { inspectBus } from 'vapor-chamber';
 * const info = inspectBus(bus);
 * console.log(info.actions);        // ['cartAdd', 'cartRemove']
 * console.log(info.undoActions);     // ['cartAdd'] - only these can rollback
 * console.log(info.pluginCount);     // 3
 * console.log(info.sealed);          // true
 */
export type BusInspection = {
  /** All registered action names. */
  actions: string[];
  /** Actions that have undo handlers registered. */
  undoActions: string[];
  /** Actions that have respond() handlers registered. */
  responderActions: string[];
  /** Number of installed plugins. */
  pluginCount: number;
  /** Plugin priorities in execution order (highest first). */
  pluginPriorities: number[];
  /** Number of beforeHooks. */
  beforeHookCount: number;
  /** Number of afterHooks. */
  afterHookCount: number;
  /** Pattern listeners: each entry is the pattern string. */
  listenerPatterns: string[];
  /** Whether the bus is sealed. */
  sealed: boolean;
  /** Current nested dispatch depth (0 when idle). */
  dispatchDepth: number;
  /** Number of active throttle timers on this bus instance. */
  activeTimers: number;
};

/**
 * Inspect a bus's full topology. **Dev/debug only** - if your production code
 * never imports `inspectBus`, it gets tree-shaken out entirely.
 *
 * Returns a plain snapshot object - safe to serialize, log, or send to DevTools.
 *
 * @example
 * import { inspectBus } from 'vapor-chamber';
 * const info = inspectBus(bus);
 * console.table(info);
 *
 * // Check if all checkout actions have undo handlers
 * const missing = info.actions.filter(a => !info.undoActions.includes(a));
 * if (missing.length) console.warn('Missing undo for:', missing);
 */
export function inspectBus(bus: BaseBus): BusInspection {
  const fn = (bus as any)[_INSPECT];
  if (typeof fn === 'function') return fn();
  // Fallback for TestBus or unknown implementations
  return {
    actions: bus.registeredActions(),
    undoActions: [],
    responderActions: [],
    pluginCount: 0,
    pluginPriorities: [],
    beforeHookCount: 0,
    afterHookCount: 0,
    listenerPatterns: [],
    sealed: bus.isSealed(),
    dispatchDepth: 0,
    activeTimers: 0,
  };
}
