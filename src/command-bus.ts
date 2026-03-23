/**
 * vapor-chamber - Command Bus for Vue Vapor
 * ~2KB gzipped (core + plugins + composables) — DevTools loaded dynamically
 */

// ---------------------------------------------------------------------------
// Structured error codes — machine-readable, LLM-friendly, i18n-ready
// ---------------------------------------------------------------------------

/**
 * Severity level for bus diagnostics.
 * - `'error'`: dispatch failed, result.ok === false
 * - `'warn'`: recoverable issue, dispatch may succeed (e.g. naming violation)
 * - `'info'`: informational (e.g. handler overwrite, circuit breaker state change)
 */
export type BusSeverity = 'error' | 'warn' | 'info';

/**
 * Emitter tag — which subsystem produced the diagnostic.
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
 * Naming: `VC_{EMITTER}_{DESCRIPTION}` — VC = vapor-chamber prefix.
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
  // Plugins
  | 'VC_PLUGIN_CIRCUIT_OPEN'      // Circuit breaker is open
  | 'VC_PLUGIN_RATE_LIMITED'      // Rate limit exceeded
  | 'VC_PLUGIN_CACHE_MISS'        // Cache miss (info-level, not an error)
  // Workflow
  | 'VC_WORKFLOW_STEP_FAILED'     // A workflow step failed, compensating
  | 'VC_WORKFLOW_COMPENSATE_FAILED' // Compensation step also failed
  // Hooks/Listeners
  | 'VC_HOOK_ERROR'               // afterHook threw (logged, not fatal)
  | 'VC_LISTENER_ERROR'           // on() listener threw (logged, not fatal)
  // Generic
  | 'VC_UNKNOWN';                 // Unclassified error

/**
 * BusError — structured error with machine-readable code, severity, and emitter.
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
  readonly code: BusErrorCode;
  /** Severity: error, warn, or info. */
  readonly severity: BusSeverity;
  /** Which subsystem produced this error. */
  readonly emitter: BusEmitter;
  /** The action name involved (if applicable). */
  readonly action?: string;
  /** Additional context (e.g. retryIn for throttle, threshold for circuit breaker). */
  readonly context?: Record<string, unknown>;

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
    this.name = 'BusError';
    this.code = code;
    this.severity = opts.severity ?? 'error';
    this.emitter = opts.emitter ?? 'core';
    this.action = opts.action;
    this.context = opts.context;
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Automatic metadata stamped on every command. */
export type CommandMeta = {
  /** Monotonic timestamp (Date.now()) at dispatch time. */
  ts: number;
  /** Unique command ID (crypto.randomUUID or fallback). */
  id: string;
  /** ID of the command that caused this one (set manually via payload.__causationId). */
  causationId?: string;
  /** Correlation ID for tracing a chain of commands (propagates from parent). */
  correlationId?: string;
};

export type Command<A extends string = string, T = any, P = any> = {
  action: A;
  target: T;
  payload?: P;
  /** Auto-stamped metadata — timestamp, unique id, correlation/causation tracing.
   *  Always present on commands from dispatch/query/emit. Optional on manually constructed commands. */
  meta?: CommandMeta;
};

export type CommandResult<V = any> = {
  ok: boolean;
  value?: V;
  error?: Error;
};

export type Handler<T = any, P = any, R = any> = (cmd: Command<string, T, P>) => R;
export type AsyncHandler<T = any, P = any, R = any> = (cmd: Command<string, T, P>) => Promise<R>;
export type Plugin = (cmd: Command, next: () => CommandResult) => CommandResult;
export type AsyncPlugin = (cmd: Command, next: () => CommandResult | Promise<CommandResult>) => CommandResult | Promise<CommandResult>;
export type Hook = (cmd: Command, result: CommandResult) => void;
export type AsyncHook = (cmd: Command, result: CommandResult) => void | Promise<void>;
/** Fires before the handler runs. Throw to cancel the dispatch (returns `{ ok: false }`). */
export type BeforeHook = (cmd: Command) => void;
/** Fires before the handler runs on an async bus. Throw or reject to cancel. */
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
 * Dead letter mode — what to do when a command has no registered handler.
 * - `'error'` (default): returns `{ ok: false, error }`
 * - `'throw'`: throws the error
 * - `'ignore'`: returns `{ ok: true, value: undefined }`
 * - function: called with the command, return value used as result
 */
export type DeadLetterMode = 'error' | 'throw' | 'ignore' | ((cmd: Command) => CommandResult);

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
};

/** Listener callback for on() subscriptions (wildcard-capable) */
export type Listener = (cmd: Command, result: CommandResult) => void;

/**
 * Typed command map — define action names, target, payload, and result shapes.
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
type TargetOf<M extends CommandMap, A extends keyof M> = M[A] extends { target: infer T } ? T : any;
/** Extract the payload type for action A from a CommandMap. */
type PayloadOf<M extends CommandMap, A extends keyof M> = M[A] extends { payload: infer P } ? P : any;
/** Extract the result type for action A from a CommandMap. */
type ResultOf<M extends CommandMap, A extends keyof M> = M[A] extends { result: infer R } ? R : any;

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

/**
 * Structural base interface for both sync and async buses.
 * Use this as the parameter type in utilities (createChamber, createWorkflow, etc.)
 * to avoid `as any` casts when working with either bus variant.
 */
export interface BaseBus {
  dispatch(action: string, target: any, payload?: any): any;
  /** Read-only dispatch — skips beforeHooks, runs handler + plugins, fires afterHooks. No mutation intent. */
  query(action: string, target: any, payload?: any): any;
  /** Fire a domain event — notifies on() listeners, no handler required, no result returned. */
  emit(event: string, data?: any): void;
  register(action: string, handler: any, options?: RegisterOptions): () => void;
  use(plugin: any, options?: PluginOptions): () => void;
  /** Subscribe before dispatch. Throw to cancel (returns `{ ok: false }`). */
  onBefore(hook: any): () => void;
  onAfter(hook: any): () => void;
  on(pattern: string, listener: Listener): () => void;
  once(pattern: string, listener: Listener): () => void;
  /** Remove all `on()` listeners matching the given pattern, or all listeners if omitted. */
  offAll(pattern?: string): void;
  hasHandler(action: string): boolean;
  /** Returns all registered action names. Useful for introspection and DevTools. */
  registeredActions(): string[];
  clear(): void;
  /** Full teardown — calls clear() and cancels all pending timers/requests. Use in SSR or component-scoped buses. */
  dispose(): void;
  /**
   * Seal the bus — prevents further register(), use(), onBefore(), onAfter(), respond() calls.
   * Dispatch, query, emit, on(), once() still work — seal protects the handler/plugin topology,
   * not the observation layer. Listeners via on()/once() can still subscribe after seal.
   * Call after app initialization to lock down the graph in production. Throws BusError
   * with code 'VC_CORE_SEALED' on any mutation attempt. Cleared by clear() for HMR compat.
   */
  seal(): void;
  /** Returns true if the bus has been sealed. */
  isSealed(): boolean;
}

export interface CommandBus<M extends CommandMap = CommandMap> extends BaseBus {
  dispatch<A extends keyof M & string>(action: A, target: TargetOf<M, A>, payload?: PayloadOf<M, A>): CommandResult<ResultOf<M, A>>;
  /** Read-only dispatch — skips beforeHooks (no mutation gating), runs handler + plugins, fires afterHooks. */
  query<A extends keyof M & string>(action: A, target: TargetOf<M, A>, payload?: PayloadOf<M, A>): CommandResult<ResultOf<M, A>>;
  /** Fire a domain event — notifies on() listeners, no handler required, no result. */
  emit(event: string, data?: any): void;
  dispatchBatch(commands: BatchCommand[], options?: BatchOptions): BatchResult;
  register<A extends keyof M & string>(action: A, handler: (cmd: Command<A, TargetOf<M, A>, PayloadOf<M, A>>) => ResultOf<M, A>, options?: RegisterOptions): () => void;
  use(plugin: Plugin, options?: PluginOptions): () => void;
  /** Subscribe before dispatch. Throw to cancel — dispatch returns `{ ok: false }`. */
  onBefore(hook: BeforeHook): () => void;
  onAfter(hook: Hook): () => void;
  on(pattern: string, listener: Listener): () => void;
  /** Subscribe to the first matching command only; auto-unsubscribes after it fires. */
  once(pattern: string, listener: Listener): () => void;
  offAll(pattern?: string): void;
  request<A extends keyof M & string>(action: A, target: TargetOf<M, A>, payload?: PayloadOf<M, A>, options?: { timeout?: number }): Promise<CommandResult<ResultOf<M, A>>>;
  respond(action: string, handler: (cmd: Command) => any | Promise<any>): () => void;
  /** Returns true if a handler is registered for the given action. */
  hasHandler(action: string): boolean;
  /** Returns all registered action names. */
  registeredActions(): string[];
  /**
   * @internal Used by the history plugin to retrieve an undo handler registered alongside
   * a command handler. Do not call this from application code — it will be moved to a
   * plugin-private channel in a future release.
   */
  getUndoHandler(action: string): Handler | undefined;
  /** Remove all handlers, plugins, hooks, and listeners. Useful for testing and HMR. */
  clear(): void;
  /** Freeze configuration — rejects register/use/clear after sealing. */
  seal(): void;
  /** Returns true if the bus is sealed. */
  isSealed(): boolean;
  /** Clean teardown — clears state, cancels timers, marks bus as disposed. */
  dispose(): void;
}

export interface AsyncCommandBus<M extends CommandMap = CommandMap> extends BaseBus {
  dispatch<A extends keyof M & string>(action: A, target: TargetOf<M, A>, payload?: PayloadOf<M, A>): Promise<CommandResult<ResultOf<M, A>>>;
  /** Read-only dispatch — skips beforeHooks (no mutation gating), runs handler + plugins, fires afterHooks. */
  query<A extends keyof M & string>(action: A, target: TargetOf<M, A>, payload?: PayloadOf<M, A>): Promise<CommandResult<ResultOf<M, A>>>;
  /** Fire a domain event — notifies on() listeners, no handler required, no result. */
  emit(event: string, data?: any): void;
  dispatchBatch(commands: BatchCommand[], options?: BatchOptions): Promise<BatchResult>;
  register<A extends keyof M & string>(action: A, handler: (cmd: Command<A, TargetOf<M, A>, PayloadOf<M, A>>) => Promise<ResultOf<M, A>>, options?: RegisterOptions): () => void;
  use(plugin: AsyncPlugin, options?: PluginOptions): () => void;
  /** Subscribe before dispatch. Throw or reject to cancel — dispatch returns `{ ok: false }`. */
  onBefore(hook: AsyncBeforeHook): () => void;
  onAfter(hook: AsyncHook): () => void;
  on(pattern: string, listener: Listener): () => void;
  /** Subscribe to the first matching command only; auto-unsubscribes after it fires. */
  once(pattern: string, listener: Listener): () => void;
  offAll(pattern?: string): void;
  request<A extends keyof M & string>(action: A, target: TargetOf<M, A>, payload?: PayloadOf<M, A>, options?: { timeout?: number }): Promise<CommandResult<ResultOf<M, A>>>;
  respond(action: string, handler: (cmd: Command) => any | Promise<any>): () => void;
  /** Returns true if a handler is registered for the given action. */
  hasHandler(action: string): boolean;
  /** Returns all registered action names. */
  registeredActions(): string[];
  /**
   * @internal Used by the history plugin to retrieve an undo handler registered alongside
   * a command handler. Do not call this from application code — it will be moved to a
   * plugin-private channel in a future release.
   */
  getUndoHandler(action: string): Handler | undefined;
  /** Remove all handlers, plugins, hooks, and listeners. Useful for testing and HMR. */
  clear(): void;
  /** Freeze configuration — rejects register/use/clear after sealing. */
  seal(): void;
  /** Returns true if the bus is sealed. */
  isSealed(): boolean;
  /** Clean teardown — clears state, cancels timers, marks bus as disposed. */
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Internal state types
// ---------------------------------------------------------------------------

/** Max nested dispatch depth — prevents infinite loops from reactions/listeners re-dispatching. */
const MAX_DISPATCH_DEPTH = 16;

/** @internal Symbol used by unsealBus() — not on the public interface. */
const _UNSEAL = Symbol('vapor-chamber:unseal');

/** @internal Symbol used by inspectBus() — not on the public interface. */
const _INSPECT = Symbol('vapor-chamber:inspect');

/** Guard: throw if the bus is sealed. */
function assertNotSealed(sealed: boolean, method: string): void {
  if (sealed) throw new BusError('VC_CORE_SEALED', `Cannot call ${method}() on a sealed bus. The bus was sealed with bus.seal() to prevent runtime mutations.`, { emitter: 'core' });
}

type SyncState = {
  readonly opts: CommandBusOptions;
  handlers: Map<string, Handler>;
  undoHandlers: Map<string, Handler>;
  pluginEntries: Array<{ plugin: Plugin; priority: number }>;
  beforeHooks: BeforeHook[];
  afterHooks: Hook[];
  patternListeners: Array<{ pattern: string; listener: Listener }>;
  responders: Map<string, (cmd: Command) => any | Promise<any>>;
  runner: (cmd: Command, execute: () => CommandResult) => CommandResult;
  /** Current nested dispatch depth — guards against infinite recursion. */
  dispatchDepth: number;
  /** When true, register/use/onBefore/onAfter/respond throw. */
  sealed: boolean;
  /** Per-instance throttle timers — dispose() cancels only this bus's timers. */
  throttleTimers: Set<ReturnType<typeof setTimeout>>;
};

type AsyncState = {
  readonly opts: CommandBusOptions;
  handlers: Map<string, AsyncHandler>;
  undoHandlers: Map<string, Handler>;
  pluginEntries: Array<{ plugin: AsyncPlugin; priority: number }>;
  beforeHooks: AsyncBeforeHook[];
  afterHooks: AsyncHook[];
  patternListeners: Array<{ pattern: string; listener: Listener }>;
  responders: Map<string, (cmd: Command) => any | Promise<any>>;
  runner: (cmd: Command, execute: () => Promise<CommandResult>) => Promise<CommandResult>;
  /** Per-instance dedup map for in-flight async requests — avoids module-level singleton leak in SSR. */
  pendingRequests: Map<string, Promise<CommandResult>>;
  /** Current nested dispatch depth — guards against infinite recursion. */
  dispatchDepth: number;
  /** When true, register/use/onBefore/onAfter/respond throw. */
  sealed: boolean;
  /** Per-instance throttle timers — dispose() cancels only this bus's timers. */
  throttleTimers: Set<ReturnType<typeof setTimeout>>;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Lightweight unique ID — crypto.randomUUID() with fast counter fallback. */
const _hasRandomUUID = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function';
let _uidCounter = 0;
function uid(): string {
  if (_hasRandomUUID) return crypto.randomUUID();
  // Fast fallback: timestamp + counter + random suffix (no regex replace)
  return (Date.now().toString(36) + '-' + (++_uidCounter).toString(36) + '-' + ((Math.random() * 0xffffffff) >>> 0).toString(36));
}

// V8 optimization: monomorphic result factories — always same hidden class
function okResult(value: any): CommandResult { return { ok: true, value, error: undefined }; }
function errResult(error: Error): CommandResult { return { ok: false, value: undefined, error }; }

// V8 optimization: extract try/catch into separate function so callers stay optimizable
function tryCatchHandler(handler: Handler, cmd: Command): CommandResult {
  try { return okResult(handler(cmd)); }
  catch (e) { return errResult(e as Error); }
}
async function tryCatchAsyncHandler(handler: AsyncHandler, cmd: Command): Promise<CommandResult> {
  try { return okResult(await handler(cmd)); }
  catch (e) { return errResult(e as Error); }
}

/** Stamp a command with auto-generated metadata. */
function stampMeta(cmd: { action: string; target: any; payload?: any }): CommandMeta {
  const p = cmd.payload;
  const correlationId = p?.__correlationId ?? p?.__causationId ?? undefined;
  const causationId = p?.__causationId ?? undefined;
  return { ts: Date.now(), id: uid(), correlationId, causationId };
}

function validateNaming(action: string, naming?: NamingConvention): void {
  if (!naming) return;
  if (naming.pattern.test(action)) return;
  const msg = `[vapor-chamber] Action "${action}" does not match naming pattern ${naming.pattern}. Rename the action to match or adjust the naming option in createCommandBus({ naming: { pattern } }).`;
  const mode = naming.onViolation ?? 'warn';
  if (mode === 'throw') throw new Error(msg);
  if (mode === 'warn') console.warn(msg);
}

// Pre-sliced prefix cache for wildcard patterns — avoids slice() on every match.
// Capped at 256 entries to prevent unbounded growth in long-running processes.
const _prefixCache = new Map<string, string>();
const _PREFIX_CACHE_MAX = 256;

export function matchesPattern(pattern: string, action: string): boolean {
  if (pattern === '*') return true;
  if (pattern.charCodeAt(pattern.length - 1) === 42 /* '*' */) {
    let prefix = _prefixCache.get(pattern);
    if (prefix === undefined) {
      prefix = pattern.slice(0, -1);
      if (_prefixCache.size >= _PREFIX_CACHE_MAX) _prefixCache.clear();
      _prefixCache.set(pattern, prefix);
    }
    return action.startsWith(prefix);
  }
  return pattern === action;
}

function isAsyncFn(fn: Function): boolean {
  return (fn as any)[Symbol.toStringTag] === 'AsyncFunction';
}

/**
 * Stable string key for a (action, target) pair. Handles circular refs safely.
 * Useful for cache invalidation integration (e.g. TanStack Query).
 */
export function commandKey(action: string, target: any): string {
  // Fast path: primitives and null don't need JSON.stringify or key sorting
  if (target === null || target === undefined) return `${action}:${target}`;
  const t = typeof target;
  if (t === 'string' || t === 'number' || t === 'boolean') return `${action}:${target}`;
  // Object path: sort keys for stable serialization — { b:2, a:1 } and { a:1, b:2 } produce the same key
  let tkey: string;
  try {
    tkey = JSON.stringify(target, Object.keys(target).sort());
  } catch { tkey = String(target); }
  return `${action}:${tkey}`;
}

// ---------------------------------------------------------------------------
// commandPool — circular buffer of pre-allocated Command objects (zero-GC)
// ---------------------------------------------------------------------------

/**
 * CommandPool — pre-allocates Command objects in a circular buffer to
 * eliminate garbage collection pauses during dispatch bursts. When the
 * pool is exhausted, it wraps around and reuses the oldest slot.
 *
 * **Important**: The pool is a standalone utility — `bus.dispatch()` still
 * creates its own Command internally and stamps `meta` (ts, id, correlationId).
 * Pooled commands do NOT have `meta` set. Use `pool.acquire()` for the action/target/payload,
 * then pass those values to `bus.dispatch(cmd.action, cmd.target, cmd.payload)`.
 * The bus will create its own internal command with proper metadata.
 *
 * Thread-safety note: single-threaded JS means no locking required.
 *
 * @example
 * const pool = createCommandPool(64);
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
  /** Reset the pool — clears all slots and resets cursor. */
  reset(): void;
  /** Pool capacity. */
  readonly size: number;
}

export function createCommandPool(size: number = 64): CommandPool {
  if (size < 1) throw new RangeError('CommandPool size must be at least 1');

  // Pre-allocate monomorphic command objects — same hidden class for V8 TurboFan
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
    cmd.meta = undefined; // reset meta — dispatch will stamp it
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
    throw new BusError('VC_CORE_THROTTLED', `Handler "${cmd.action}" throttled. Retry in ${retryIn}ms.`, { emitter: 'core', action: cmd.action, context: { retryIn, wait } });
  };
}

// ---------------------------------------------------------------------------
// Sync runner
// ---------------------------------------------------------------------------

export function buildRunner(plugins: Plugin[]) {
  return function run(cmd: Command, execute: () => CommandResult): CommandResult {
    let i = 0;
    function next(): CommandResult {
      const plugin = plugins[i++];
      return plugin ? plugin(cmd, next) : execute();
    }
    return next();
  };
}

// ---------------------------------------------------------------------------
// Module-level sync bus operations (state threaded explicitly)
// ---------------------------------------------------------------------------

function syncRebuildRunner(s: SyncState): void {
  const sorted = s.pluginEntries.slice().sort((a, b) => b.priority - a.priority).map(e => e.plugin);
  s.runner = buildRunner(sorted);
}

function handleMissing(opts: CommandBusOptions, cmd: Command): CommandResult {
  const mode = opts.onMissing ?? 'error';
  if (mode === 'ignore') return okResult(undefined);
  const err = new BusError(
    'VC_CORE_NO_HANDLER',
    `No handler registered for "${cmd.action}". Call bus.register("${cmd.action}", handler) first.`,
    { emitter: 'core', action: cmd.action },
  );
  if (mode === 'throw') throw err;
  if (typeof mode === 'function') {
    try { return mode(cmd); }
    catch (e) { return errResult(e as Error); }
  }
  return errResult(err);
}

function syncRunHooks(s: SyncState, cmd: Command, result: CommandResult): void {
  // V8 opt: index-based loops with length snapshot — avoids .slice() allocation
  const ah = s.afterHooks;
  for (let i = 0, len = ah.length; i < len; i++) {
    try { ah[i](cmd, result); } catch (e) { console.error('[vapor-chamber] Hook error:', e); }
  }
  const pl = s.patternListeners;
  const action = cmd.action;
  // once() splices itself out mid-iteration — adjust index when array shrinks
  for (let i = 0; i < pl.length; i++) {
    const entry = pl[i];
    if (matchesPattern(entry.pattern, action)) {
      const lenBefore = pl.length;
      try { entry.listener(cmd, result); } catch (e) { console.error('[vapor-chamber] Listener error:', e); }
      if (pl.length < lenBefore) i--;  // entry was spliced out, recheck this index
    }
  }
}

function syncDispatch(s: SyncState, action: string, target: any, payload?: any, executeOverride?: () => CommandResult): CommandResult {
  if (s.dispatchDepth >= MAX_DISPATCH_DEPTH) {
    return errResult(new BusError('VC_CORE_MAX_DEPTH', `Maximum dispatch depth (${MAX_DISPATCH_DEPTH}) exceeded for "${action}". This usually means a listener or reaction is re-dispatching in an infinite loop.`, { emitter: 'core', action }));
  }
  s.dispatchDepth++;
  try { return _syncDispatchInner(s, action, target, payload, executeOverride); }
  finally { s.dispatchDepth--; }
}

function _syncDispatchInner(s: SyncState, action: string, target: any, payload?: any, executeOverride?: () => CommandResult): CommandResult {
  validateNaming(action, s.opts.naming);
  const cmd: Command = { action, target, payload, meta: stampMeta({ action, target, payload }) };
  // V8 opt: index-based loop, no .slice()
  const bh = s.beforeHooks;
  for (let i = 0, len = bh.length; i < len; i++) {
    try { bh[i](cmd); }
    catch (e) {
      const result = errResult(e as Error);
      syncRunHooks(s, cmd, result);
      return result;
    }
  }
  const execute = executeOverride ?? ((): CommandResult => {
    const handler = s.handlers.get(action);
    if (!handler) return handleMissing(s.opts, cmd);
    return tryCatchHandler(handler, cmd);
  });
  const result = s.runner(cmd, execute);
  syncRunHooks(s, cmd, result);
  return result;
}

/** Read-only query — skips beforeHooks, runs handler + plugins, fires afterHooks. */
function syncQuery(s: SyncState, action: string, target: any, payload?: any): CommandResult {
  validateNaming(action, s.opts.naming);
  const cmd: Command = { action, target, payload, meta: stampMeta({ action, target, payload }) };
  // Skip beforeHooks — queries don't trigger mutation gates (auth, loading spinners, etc.)
  const execute = (): CommandResult => {
    const handler = s.handlers.get(action);
    if (!handler) return handleMissing(s.opts, cmd);
    return tryCatchHandler(handler, cmd);
  };
  const result = s.runner(cmd, execute);
  syncRunHooks(s, cmd, result);
  return result;
}

/** Fire a domain event — notifies on() listeners, no handler required, no result. */
function syncEmit(s: SyncState, event: string, data?: any): void {
  const cmd: Command = { action: event, target: data, meta: stampMeta({ action: event, target: data }) };
  const result = okResult(undefined);
  const pl = s.patternListeners;
  for (let i = 0; i < pl.length; i++) {
    const entry = pl[i];
    if (matchesPattern(entry.pattern, event)) {
      const lenBefore = pl.length;
      try { entry.listener(cmd, result); } catch (e) { console.error('[vapor-chamber] Listener error:', e); }
      if (pl.length < lenBefore) i--;
    }
  }
}

function syncDispatchBatch(s: SyncState, commands: BatchCommand[], opts: BatchOptions = {}): BatchResult {
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
    if (!results[j].ok) continue; // skip already-failed commands
    const undo = s.undoHandlers.get(commands[j].action);
    if (!undo) continue; // no undo registered — skip
    const cmd: Command = { action: commands[j].action, target: commands[j].target, payload: commands[j].payload, meta: stampMeta(commands[j]) };
    try { rollbacks.push(okResult(undo(cmd))); }
    catch (e) { rollbacks.push(errResult(e as Error)); }
  }
  return rollbacks;
}

function syncRegister(s: SyncState, action: string, handler: Handler, opts: RegisterOptions = {}): () => void {
  assertNotSealed(s.sealed, 'register');
  validateNaming(action, s.opts.naming);
  if (s.handlers.has(action)) {
    console.warn(`[vapor-chamber] Handler for "${action}" already exists and is being overwritten. Call the unregister function returned by register() first, or use bus.clear() to reset.`);
  }
  let h = handler;
  if (opts.throttle && opts.throttle > 0) h = wrapThrottle(h, opts.throttle, s.throttleTimers);
  if (opts.undo) s.undoHandlers.set(action, opts.undo);
  s.handlers.set(action, h);
  return () => { s.handlers.delete(action); s.undoHandlers.delete(action); };
}

function syncUse(s: SyncState, plugin: Plugin, opts: PluginOptions = {}): () => void {
  assertNotSealed(s.sealed, 'use');
  if (isAsyncFn(plugin)) {
    console.warn('[vapor-chamber] Async plugin installed on sync bus — use createAsyncCommandBus() instead.');
  }
  const entry = { plugin, priority: opts.priority ?? 0 };
  s.pluginEntries.push(entry);
  syncRebuildRunner(s);
  return () => { const i = s.pluginEntries.indexOf(entry); if (i !== -1) { s.pluginEntries.splice(i, 1); syncRebuildRunner(s); } };
}

function syncOnAfter(s: SyncState, hook: Hook): () => void {
  assertNotSealed(s.sealed, 'onAfter');
  s.afterHooks.push(hook);
  return () => { const i = s.afterHooks.indexOf(hook); if (i !== -1) s.afterHooks.splice(i, 1); };
}

function syncOn(s: SyncState, pattern: string, listener: Listener): () => void {
  const entry = { pattern, listener };
  s.patternListeners.push(entry);
  return () => { const i = s.patternListeners.indexOf(entry); if (i !== -1) s.patternListeners.splice(i, 1); };
}

/**
 * once() unsubscribes itself *before* calling the listener. This means:
 * - If the listener throws, the subscription is still removed (no re-fire on retry).
 * - The listener cannot observe itself in the patternListeners array.
 * This is intentional — it matches DOM addEventListener({ once: true }) semantics.
 */
function syncOnce(s: SyncState, pattern: string, listener: Listener): () => void {
  const unsub = syncOn(s, pattern, (cmd, result) => { unsub(); listener(cmd, result); });
  return unsub;
}

function syncOnBefore(s: SyncState, hook: BeforeHook): () => void {
  assertNotSealed(s.sealed, 'onBefore');
  s.beforeHooks.push(hook);
  return () => { const i = s.beforeHooks.indexOf(hook); if (i !== -1) s.beforeHooks.splice(i, 1); };
}

function syncOffAll(s: SyncState, pattern?: string): void {
  if (pattern === undefined) { s.patternListeners.length = 0; return; }
  for (let i = s.patternListeners.length - 1; i >= 0; i--) {
    if (s.patternListeners[i].pattern === pattern) s.patternListeners.splice(i, 1);
  }
}

function syncRequest(s: SyncState, action: string, target: any, payload?: any, reqOpts: { timeout?: number } = {}): Promise<CommandResult> {
  const timeout = reqOpts.timeout ?? 5000;
  const responder = s.responders.get(action);
  if (!responder) return Promise.resolve(syncDispatch(s, action, target, payload));

  return new Promise((resolve) => {
    const timeoutId = setTimeout(
      () => resolve(errResult(new BusError('VC_CORE_REQUEST_TIMEOUT', `Request "${action}" timed out after ${timeout}ms. Increase timeout or check if a respond() handler is registered.`, { emitter: 'core', action, context: { timeout } }))),
      timeout
    );

    // Route through the plugin chain with responder as the execute function
    const cmd: Command = { action, target, payload, meta: stampMeta({ action, target, payload }) };
    const execute = (): CommandResult => {
      try { return okResult(responder(cmd)); }
      catch (e) { return errResult(e as Error); }
    };

    let pluginResult: CommandResult;
    try { pluginResult = s.runner(cmd, execute); }
    catch (e) { clearTimeout(timeoutId); resolve(errResult(e as Error)); return; }

    syncRunHooks(s, cmd, pluginResult);

    if (!pluginResult.ok) { clearTimeout(timeoutId); resolve(pluginResult); return; }

    // Unwrap async responder value if needed
    const maybeAsync = pluginResult.value;
    if (maybeAsync && typeof maybeAsync.then === 'function') {
      maybeAsync
        .then((v: any) => { clearTimeout(timeoutId); resolve(okResult(v)); })
        .catch((e: Error) => { clearTimeout(timeoutId); resolve(errResult(e)); });
    } else {
      clearTimeout(timeoutId);
      resolve(pluginResult);
    }
  });
}

function syncRespond(s: SyncState, action: string, handler: (cmd: Command) => any | Promise<any>): () => void {
  assertNotSealed(s.sealed, 'respond');
  validateNaming(action, s.opts.naming);
  s.responders.set(action, handler);
  return () => s.responders.delete(action);
}

function syncClear(s: SyncState): void {
  s.handlers.clear();
  s.undoHandlers.clear();
  s.pluginEntries.length = 0;
  s.beforeHooks.length = 0;
  s.afterHooks.length = 0;
  s.patternListeners.length = 0;
  s.responders.clear();
  s.runner = buildRunner([]);
}

function syncDispose(s: SyncState): void {
  syncClear(s);
  for (const timer of s.throttleTimers) clearTimeout(timer);
  s.throttleTimers.clear();
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
    pluginEntries: [], beforeHooks: [], afterHooks: [], patternListeners: [],
    responders: new Map(),
    runner: buildRunner([]),
    dispatchDepth: 0,
    sealed: false,
    throttleTimers: new Set(),
  };
  const bus: CommandBus<M> = {
    dispatch:          (a, t, p)       => syncDispatch(s, a as string, t, p),
    query:             (a, t, p)       => syncQuery(s, a as string, t, p),
    emit:              (e, d)          => syncEmit(s, e, d),
    dispatchBatch:     (cmds, o)       => syncDispatchBatch(s, cmds, o),
    register:          (a, h, o)       => syncRegister(s, a as string, h as Handler, o),
    use:               (p, o)          => syncUse(s, p, o),
    onBefore:          (h)             => syncOnBefore(s, h),
    onAfter:           (h)             => syncOnAfter(s, h),
    on:                (pat, l)        => syncOn(s, pat, l),
    once:              (pat, l)        => syncOnce(s, pat, l),
    offAll:            (pat)           => syncOffAll(s, pat),
    request:           (a, t, p, o)   => syncRequest(s, a as string, t, p, o),
    respond:           (a, h)          => syncRespond(s, a, h),
    hasHandler:        (a)             => s.handlers.has(a),
    registeredActions: ()              => Array.from(s.handlers.keys()),
    getUndoHandler:    (a)             => s.undoHandlers.get(a),
    clear:             ()              => syncClear(s),
    dispose:           ()              => syncDispose(s),
    seal:              ()              => { s.sealed = true; },
    isSealed:          ()              => s.sealed,
  };
  // Symbol keys for tree-shakeable introspection — not on the public interface
  (bus as any)[_UNSEAL] = () => { s.sealed = false; };
  (bus as any)[_INSPECT] = (): BusInspection => ({
      actions: Array.from(s.handlers.keys()),
      undoActions: Array.from(s.undoHandlers.keys()),
      responderActions: Array.from(s.responders.keys()),
      pluginCount: s.pluginEntries.length,
      pluginPriorities: s.pluginEntries.slice().sort((a, b) => b.priority - a.priority).map(e => e.priority),
      beforeHookCount: s.beforeHooks.length,
      afterHookCount: s.afterHooks.length,
      listenerPatterns: s.patternListeners.map(e => e.pattern),
      sealed: s.sealed,
      dispatchDepth: s.dispatchDepth,
      activeTimers: s.throttleTimers.size,
  });
  return bus;
}

// ---------------------------------------------------------------------------
// Async runner
// ---------------------------------------------------------------------------

function buildAsyncRunner(plugins: AsyncPlugin[]) {
  return function run(cmd: Command, execute: () => Promise<CommandResult>): Promise<CommandResult> {
    let i = 0;
    function next(): CommandResult | Promise<CommandResult> {
      const plugin = plugins[i++];
      return plugin ? plugin(cmd, next) : execute();
    }
    return Promise.resolve(next());
  };
}

// ---------------------------------------------------------------------------
// Module-level async bus operations
// ---------------------------------------------------------------------------

function asyncRebuildRunner(s: AsyncState): void {
  const sorted = s.pluginEntries.slice().sort((a, b) => b.priority - a.priority).map(e => e.plugin);
  s.runner = buildAsyncRunner(sorted);
}

async function asyncRunHooks(s: AsyncState, cmd: Command, result: CommandResult): Promise<void> {
  // V8 opt: index-based loops, no .slice()
  const ah = s.afterHooks;
  for (let i = 0, len = ah.length; i < len; i++) {
    try { await ah[i](cmd, result); } catch (e) { console.error('[vapor-chamber] Hook error:', e); }
  }
  const pl = s.patternListeners;
  const action = cmd.action;
  for (let i = 0; i < pl.length; i++) {
    const entry = pl[i];
    if (matchesPattern(entry.pattern, action)) {
      const lenBefore = pl.length;
      try { entry.listener(cmd, result); } catch (e) { console.error('[vapor-chamber] Listener error:', e); }
      if (pl.length < lenBefore) i--;
    }
  }
}

async function asyncDispatch(s: AsyncState, action: string, target: any, payload?: any, executeOverride?: () => Promise<CommandResult>): Promise<CommandResult> {
  if (s.dispatchDepth >= MAX_DISPATCH_DEPTH) {
    return errResult(new BusError('VC_CORE_MAX_DEPTH', `Maximum dispatch depth (${MAX_DISPATCH_DEPTH}) exceeded for "${action}". This usually means a listener or reaction is re-dispatching in an infinite loop.`, { emitter: 'core', action }));
  }
  s.dispatchDepth++;
  try { return await _asyncDispatchInner(s, action, target, payload, executeOverride); }
  finally { s.dispatchDepth--; }
}

async function _asyncDispatchInner(s: AsyncState, action: string, target: any, payload?: any, executeOverride?: () => Promise<CommandResult>): Promise<CommandResult> {
  validateNaming(action, s.opts.naming);
  const cmd: Command = { action, target, payload, meta: stampMeta({ action, target, payload }) };
  // V8 opt: index-based loop, no .slice()
  const bh = s.beforeHooks;
  for (let i = 0, len = bh.length; i < len; i++) {
    try { await bh[i](cmd); }
    catch (e) {
      const result = errResult(e as Error);
      await asyncRunHooks(s, cmd, result);
      return result;
    }
  }
  const execute = executeOverride ?? (async (): Promise<CommandResult> => {
    const handler = s.handlers.get(action);
    if (!handler) return handleMissing(s.opts, cmd);
    return tryCatchAsyncHandler(handler, cmd);
  });
  const result = await s.runner(cmd, execute);
  await asyncRunHooks(s, cmd, result);
  return result;
}

/** Async read-only query — skips beforeHooks, runs handler + plugins, fires afterHooks. */
async function asyncQuery(s: AsyncState, action: string, target: any, payload?: any): Promise<CommandResult> {
  validateNaming(action, s.opts.naming);
  const cmd: Command = { action, target, payload, meta: stampMeta({ action, target, payload }) };
  const execute = async (): Promise<CommandResult> => {
    const handler = s.handlers.get(action);
    if (!handler) return handleMissing(s.opts, cmd);
    return tryCatchAsyncHandler(handler, cmd);
  };
  const result = await s.runner(cmd, execute);
  await asyncRunHooks(s, cmd, result);
  return result;
}

/** Async emit — notifies on() listeners, no handler required, no result. */
function asyncEmit(s: AsyncState, event: string, data?: any): void {
  const cmd: Command = { action: event, target: data, meta: stampMeta({ action: event, target: data }) };
  const result = okResult(undefined);
  const pl = s.patternListeners;
  for (let i = 0; i < pl.length; i++) {
    const entry = pl[i];
    if (matchesPattern(entry.pattern, event)) {
      const lenBefore = pl.length;
      try { entry.listener(cmd, result); } catch (e) { console.error('[vapor-chamber] Listener error:', e); }
      if (pl.length < lenBefore) i--;
    }
  }
}

async function asyncDispatchBatch(s: AsyncState, commands: BatchCommand[], opts: BatchOptions = {}): Promise<BatchResult> {
  const results: CommandResult[] = [];
  let firstError: Error | undefined;
  let failCount = 0;
  for (let ci = 0; ci < commands.length; ci++) {
    const { action, target, payload } = commands[ci];
    const result = await asyncDispatch(s, action, target, payload);
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
    if (!results[j].ok) continue;
    const undo = s.undoHandlers.get(commands[j].action);
    if (!undo) continue;
    const cmd: Command = { action: commands[j].action, target: commands[j].target, payload: commands[j].payload, meta: stampMeta(commands[j]) };
    try {
      const r = undo(cmd);
      rollbacks.push(okResult(r && typeof r.then === 'function' ? await r : r));
    } catch (e) { rollbacks.push(errResult(e as Error)); }
  }
  return rollbacks;
}

function asyncRegister(s: AsyncState, action: string, handler: AsyncHandler, opts: RegisterOptions = {}): () => void {
  assertNotSealed(s.sealed, 'register');
  validateNaming(action, s.opts.naming);
  if (s.handlers.has(action)) {
    console.warn(`[vapor-chamber] Handler for "${action}" already exists and is being overwritten. Call the unregister function returned by register() first, or use bus.clear() to reset.`);
  }
  let h = handler;
  if (opts.throttle && opts.throttle > 0) h = wrapThrottle(h, opts.throttle, s.throttleTimers);
  if (opts.undo) s.undoHandlers.set(action, opts.undo);
  s.handlers.set(action, h);
  return () => { s.handlers.delete(action); s.undoHandlers.delete(action); };
}

function asyncUse(s: AsyncState, plugin: AsyncPlugin, opts: PluginOptions = {}): () => void {
  assertNotSealed(s.sealed, 'use');
  const entry = { plugin, priority: opts.priority ?? 0 };
  s.pluginEntries.push(entry);
  asyncRebuildRunner(s);
  return () => { const i = s.pluginEntries.indexOf(entry); if (i !== -1) { s.pluginEntries.splice(i, 1); asyncRebuildRunner(s); } };
}

function asyncOnAfter(s: AsyncState, hook: AsyncHook): () => void {
  assertNotSealed(s.sealed, 'onAfter');
  s.afterHooks.push(hook);
  return () => { const i = s.afterHooks.indexOf(hook); if (i !== -1) s.afterHooks.splice(i, 1); };
}

function asyncOn(s: AsyncState, pattern: string, listener: Listener): () => void {
  const entry = { pattern, listener };
  s.patternListeners.push(entry);
  return () => { const i = s.patternListeners.indexOf(entry); if (i !== -1) s.patternListeners.splice(i, 1); };
}

function asyncOnce(s: AsyncState, pattern: string, listener: Listener): () => void {
  const unsub = asyncOn(s, pattern, (cmd, result) => { unsub(); listener(cmd, result); });
  return unsub;
}

function asyncOnBefore(s: AsyncState, hook: AsyncBeforeHook): () => void {
  assertNotSealed(s.sealed, 'onBefore');
  s.beforeHooks.push(hook);
  return () => { const i = s.beforeHooks.indexOf(hook); if (i !== -1) s.beforeHooks.splice(i, 1); };
}

function asyncOffAll(s: AsyncState, pattern?: string): void {
  if (pattern === undefined) { s.patternListeners.length = 0; return; }
  for (let i = s.patternListeners.length - 1; i >= 0; i--) {
    if (s.patternListeners[i].pattern === pattern) s.patternListeners.splice(i, 1);
  }
}

async function asyncRequest(s: AsyncState, action: string, target: any, payload?: any, reqOpts: { timeout?: number } = {}): Promise<CommandResult> {
  const timeout = reqOpts.timeout ?? 5000;
  const responder = s.responders.get(action);

  // Dedup key: action + serialized target (same action+target = same request)
  let dedupKey: string;
  try { dedupKey = `${action}:${JSON.stringify(target)}`; } catch { dedupKey = `${action}:${String(target)}`; }

  // If an identical request is already in-flight, piggyback on it
  const inflight = s.pendingRequests.get(dedupKey);
  if (inflight) return inflight;

  // Route through the plugin chain with responder as the execute function
  const executeOverride = responder ? async (): Promise<CommandResult> => {
    try { return okResult(await responder({ action, target, payload, meta: stampMeta({ action, target, payload }) } as Command)); }
    catch (e) { return errResult(e as Error); }
  } : undefined;

  const dispatchPromise = asyncDispatch(s, action, target, payload, executeOverride);

  let timeoutId: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<CommandResult>((resolve) => {
    timeoutId = setTimeout(
      () => resolve(errResult(new BusError('VC_CORE_REQUEST_TIMEOUT', `Request "${action}" timed out after ${timeout}ms. Increase timeout or check if a respond() handler is registered.`, { emitter: 'core', action, context: { timeout } }))),
      timeout
    );
  });

  const racePromise = Promise.race([
    dispatchPromise.then((r) => { clearTimeout(timeoutId!); return r; }),
    timeoutPromise,
  ]).finally(() => {
    s.pendingRequests.delete(dedupKey);
  });

  s.pendingRequests.set(dedupKey, racePromise);
  return racePromise;
}

function asyncRespond(s: AsyncState, action: string, handler: (cmd: Command) => any | Promise<any>): () => void {
  assertNotSealed(s.sealed, 'respond');
  validateNaming(action, s.opts.naming);
  s.responders.set(action, handler);
  return () => s.responders.delete(action);
}

function asyncClear(s: AsyncState): void {
  s.handlers.clear();
  s.undoHandlers.clear();
  s.pluginEntries.length = 0;
  s.beforeHooks.length = 0;
  s.afterHooks.length = 0;
  s.patternListeners.length = 0;
  s.responders.clear();
  s.pendingRequests.clear();
  s.runner = buildAsyncRunner([]);
}

function asyncDispose(s: AsyncState): void {
  asyncClear(s);
  for (const timer of s.throttleTimers) clearTimeout(timer);
  s.throttleTimers.clear();
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
    pluginEntries: [], beforeHooks: [], afterHooks: [], patternListeners: [],
    responders: new Map(),
    pendingRequests: new Map(),
    runner: buildAsyncRunner([]),
    dispatchDepth: 0,
    sealed: false,
    throttleTimers: new Set(),
  };
  const bus: AsyncCommandBus<M> = {
    dispatch:          (a, t, p)     => asyncDispatch(s, a as string, t, p),
    query:             (a, t, p)     => asyncQuery(s, a as string, t, p),
    emit:              (e, d)        => asyncEmit(s, e, d),
    dispatchBatch:     (cmds, o)     => asyncDispatchBatch(s, cmds, o),
    register:          (a, h, o)     => asyncRegister(s, a as string, h as AsyncHandler, o),
    use:               (p, o)        => asyncUse(s, p, o),
    onBefore:          (h)           => asyncOnBefore(s, h),
    onAfter:           (h)           => asyncOnAfter(s, h),
    on:                (pat, l)      => asyncOn(s, pat, l),
    once:              (pat, l)      => asyncOnce(s, pat, l),
    offAll:            (pat)         => asyncOffAll(s, pat),
    request:           (a, t, p, o)  => asyncRequest(s, a as string, t, p, o),
    respond:           (a, h)        => asyncRespond(s, a, h),
    hasHandler:        (a)           => s.handlers.has(a),
    registeredActions: ()            => Array.from(s.handlers.keys()),
    getUndoHandler:    (a)           => s.undoHandlers.get(a),
    clear:             ()            => asyncClear(s),
    dispose:           ()            => asyncDispose(s),
    seal:              ()            => { s.sealed = true; },
    isSealed:          ()            => s.sealed,
  };
  // Symbol keys for tree-shakeable introspection — not on the public interface
  (bus as any)[_UNSEAL] = () => { s.sealed = false; };
  (bus as any)[_INSPECT] = (): BusInspection => ({
    actions: Array.from(s.handlers.keys()),
    undoActions: Array.from(s.undoHandlers.keys()),
    responderActions: Array.from(s.responders.keys()),
    pluginCount: s.pluginEntries.length,
    pluginPriorities: s.pluginEntries.slice().sort((a, b) => b.priority - a.priority).map(e => e.priority),
    beforeHookCount: s.beforeHooks.length,
    afterHookCount: s.afterHooks.length,
    listenerPatterns: s.patternListeners.map(e => e.pattern),
    sealed: s.sealed,
    dispatchDepth: s.dispatchDepth,
    activeTimers: s.throttleTimers.size,
  });
  return bus;
}

// ---------------------------------------------------------------------------
// unsealBus — dev/HMR only, tree-shakeable in production
// ---------------------------------------------------------------------------

/**
 * Unseal a sealed bus. **Dev/HMR only** — if your production code never imports
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
// inspectBus — dev/debug only, tree-shakeable in production
// ---------------------------------------------------------------------------

/**
 * Complete snapshot of a bus's internal topology.
 * Returned by `inspectBus()` for debugging, DevTools, and ops diagnostics.
 *
 * @example
 * import { inspectBus } from 'vapor-chamber';
 * const info = inspectBus(bus);
 * console.log(info.actions);        // ['cartAdd', 'cartRemove']
 * console.log(info.undoActions);     // ['cartAdd'] — only these can rollback
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
 * Inspect a bus's full topology. **Dev/debug only** — if your production code
 * never imports `inspectBus`, it gets tree-shaken out entirely.
 *
 * Returns a plain snapshot object — safe to serialize, log, or send to DevTools.
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
