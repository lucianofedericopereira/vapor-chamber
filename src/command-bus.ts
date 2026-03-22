/**
 * vapor-chamber - Command Bus for Vue Vapor
 * ~2KB gzipped (core + plugins + composables) — DevTools loaded dynamically
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Command<A extends string = string, T = any, P = any> = {
  action: A;
  target: T;
  payload?: P;
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
export type BatchOptions = { continueOnError?: boolean };

/** Result of a batch dispatch */
export type BatchResult = {
  ok: boolean;
  results: CommandResult[];
  error?: Error;
  /** Number of commands that completed successfully */
  successCount: number;
  /** Number of commands that failed */
  failCount: number;
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

// Internal helper types for extracting typed shapes
type _T<M extends CommandMap, A extends keyof M> = M[A] extends { target: infer T } ? T : any;
type _P<M extends CommandMap, A extends keyof M> = M[A] extends { payload: infer P } ? P : any;
type _R<M extends CommandMap, A extends keyof M> = M[A] extends { result: infer R } ? R : any;

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
  clear(): void;
}

export interface CommandBus<M extends CommandMap = CommandMap> extends BaseBus {
  dispatch<A extends keyof M & string>(action: A, target: _T<M, A>, payload?: _P<M, A>): CommandResult<_R<M, A>>;
  dispatchBatch(commands: BatchCommand[], options?: BatchOptions): BatchResult;
  register<A extends keyof M & string>(action: A, handler: (cmd: Command<A, _T<M, A>, _P<M, A>>) => _R<M, A>, options?: RegisterOptions): () => void;
  use(plugin: Plugin, options?: PluginOptions): () => void;
  /** Subscribe before dispatch. Throw to cancel — dispatch returns `{ ok: false }`. */
  onBefore(hook: BeforeHook): () => void;
  onAfter(hook: Hook): () => void;
  on(pattern: string, listener: Listener): () => void;
  /** Subscribe to the first matching command only; auto-unsubscribes after it fires. */
  once(pattern: string, listener: Listener): () => void;
  offAll(pattern?: string): void;
  request<A extends keyof M & string>(action: A, target: _T<M, A>, payload?: _P<M, A>, options?: { timeout?: number }): Promise<CommandResult<_R<M, A>>>;
  respond(action: string, handler: (cmd: Command) => any | Promise<any>): () => void;
  /** Returns true if a handler is registered for the given action. */
  hasHandler(action: string): boolean;
  /**
   * @internal Used by the history plugin to retrieve an undo handler registered alongside
   * a command handler. Do not call this from application code — it will be moved to a
   * plugin-private channel in a future release.
   */
  getUndoHandler(action: string): Handler | undefined;
  /** Remove all handlers, plugins, hooks, and listeners. Useful for testing and HMR. */
  clear(): void;
}

export interface AsyncCommandBus<M extends CommandMap = CommandMap> extends BaseBus {
  dispatch<A extends keyof M & string>(action: A, target: _T<M, A>, payload?: _P<M, A>): Promise<CommandResult<_R<M, A>>>;
  dispatchBatch(commands: BatchCommand[], options?: BatchOptions): Promise<BatchResult>;
  register<A extends keyof M & string>(action: A, handler: (cmd: Command<A, _T<M, A>, _P<M, A>>) => Promise<_R<M, A>>, options?: RegisterOptions): () => void;
  use(plugin: AsyncPlugin, options?: PluginOptions): () => void;
  /** Subscribe before dispatch. Throw or reject to cancel — dispatch returns `{ ok: false }`. */
  onBefore(hook: AsyncBeforeHook): () => void;
  onAfter(hook: AsyncHook): () => void;
  on(pattern: string, listener: Listener): () => void;
  /** Subscribe to the first matching command only; auto-unsubscribes after it fires. */
  once(pattern: string, listener: Listener): () => void;
  offAll(pattern?: string): void;
  request<A extends keyof M & string>(action: A, target: _T<M, A>, payload?: _P<M, A>, options?: { timeout?: number }): Promise<CommandResult<_R<M, A>>>;
  respond(action: string, handler: (cmd: Command) => any | Promise<any>): () => void;
  /** Returns true if a handler is registered for the given action. */
  hasHandler(action: string): boolean;
  /**
   * @internal Used by the history plugin to retrieve an undo handler registered alongside
   * a command handler. Do not call this from application code — it will be moved to a
   * plugin-private channel in a future release.
   */
  getUndoHandler(action: string): Handler | undefined;
  /** Remove all handlers, plugins, hooks, and listeners. Useful for testing and HMR. */
  clear(): void;
}

// ---------------------------------------------------------------------------
// Internal state types
// ---------------------------------------------------------------------------

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
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validateNaming(action: string, naming?: NamingConvention): void {
  if (!naming) return;
  if (naming.pattern.test(action)) return;
  const msg = `[vapor-chamber] Action "${action}" does not match pattern ${naming.pattern}`;
  const mode = naming.onViolation ?? 'warn';
  if (mode === 'throw') throw new Error(msg);
  if (mode === 'warn') console.warn(msg);
}

export function matchesPattern(pattern: string, action: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('*')) return action.startsWith(pattern.slice(0, -1));
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
  let tkey: string;
  try { tkey = JSON.stringify(target); } catch { tkey = String(target); }
  return `${action}:${tkey}`;
}

function wrapThrottle(handler: Handler, wait: number): Handler;
function wrapThrottle(handler: AsyncHandler, wait: number): AsyncHandler;
function wrapThrottle(handler: Handler | AsyncHandler, wait: number): Handler | AsyncHandler {
  const lastRun = new Map<string, number>();
  return (cmd: Command): any => {
    const key = commandKey(cmd.action, cmd.target);
    const now = Date.now();
    const last = lastRun.get(key) ?? 0;
    if (now - last >= wait) {
      lastRun.set(key, now);
      setTimeout(() => lastRun.delete(key), wait);
      return (handler as Handler)(cmd);
    }
    throw Object.assign(new Error('throttled'), { retryIn: wait - (now - last) });
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
  if (mode === 'ignore') return { ok: true, value: undefined };
  if (mode === 'throw') throw new Error(`No handler: ${cmd.action}`);
  if (typeof mode === 'function') {
    try { return mode(cmd); }
    catch (e) { return { ok: false, error: e as Error }; }
  }
  return { ok: false, error: new Error(`No handler: ${cmd.action}`) };
}

function syncRunHooks(s: SyncState, cmd: Command, result: CommandResult): void {
  for (const hook of s.afterHooks.slice()) { try { hook(cmd, result); } catch (e) { console.error('[vapor-chamber] Hook error:', e); } }
  for (const { pattern, listener } of s.patternListeners.slice()) { if (matchesPattern(pattern, cmd.action)) { try { listener(cmd, result); } catch (e) { console.error('[vapor-chamber] Listener error:', e); } } }
}

function syncDispatch(s: SyncState, action: string, target: any, payload?: any, executeOverride?: () => CommandResult): CommandResult {
  validateNaming(action, s.opts.naming);
  const cmd: Command = { action, target, payload };
  for (const hook of s.beforeHooks.slice()) {
    try { hook(cmd); }
    catch (e) {
      const result: CommandResult = { ok: false, error: e as Error };
      syncRunHooks(s, cmd, result);
      return result;
    }
  }
  const execute = executeOverride ?? ((): CommandResult => {
    const handler = s.handlers.get(action);
    if (!handler) return handleMissing(s.opts, cmd);
    try { return { ok: true, value: handler(cmd) }; }
    catch (e) { return { ok: false, error: e as Error }; }
  });
  const result = s.runner(cmd, execute);
  syncRunHooks(s, cmd, result);
  return result;
}

function syncDispatchBatch(s: SyncState, commands: BatchCommand[], opts: BatchOptions = {}): BatchResult {
  const results: CommandResult[] = [];
  let firstError: Error | undefined;
  let failCount = 0;
  for (const { action, target, payload } of commands) {
    const result = syncDispatch(s, action, target, payload);
    results.push(result);
    if (!result.ok) {
      failCount++;
      if (!opts.continueOnError) return { ok: false, results, error: result.error, successCount: results.length - failCount, failCount };
      if (!firstError) firstError = result.error;
    }
  }
  const successCount = results.length - failCount;
  return firstError ? { ok: false, results, error: firstError, successCount, failCount } : { ok: true, results, successCount, failCount };
}

function syncRegister(s: SyncState, action: string, handler: Handler, opts: RegisterOptions = {}): () => void {
  validateNaming(action, s.opts.naming);
  if (s.handlers.has(action)) {
    console.warn(`[vapor-chamber] Handler for "${action}" is being overwritten. Call unregister first to suppress this warning.`);
  }
  let h = handler;
  if (opts.throttle && opts.throttle > 0) h = wrapThrottle(h, opts.throttle);
  if (opts.undo) s.undoHandlers.set(action, opts.undo);
  s.handlers.set(action, h);
  return () => { s.handlers.delete(action); s.undoHandlers.delete(action); };
}

function syncUse(s: SyncState, plugin: Plugin, opts: PluginOptions = {}): () => void {
  if (isAsyncFn(plugin)) {
    console.warn('[vapor-chamber] Async plugin installed on sync bus — use createAsyncCommandBus() instead.');
  }
  const entry = { plugin, priority: opts.priority ?? 0 };
  s.pluginEntries.push(entry);
  syncRebuildRunner(s);
  return () => { const i = s.pluginEntries.indexOf(entry); if (i !== -1) { s.pluginEntries.splice(i, 1); syncRebuildRunner(s); } };
}

function syncOnAfter(s: SyncState, hook: Hook): () => void {
  s.afterHooks.push(hook);
  return () => { const i = s.afterHooks.indexOf(hook); if (i !== -1) s.afterHooks.splice(i, 1); };
}

function syncOn(s: SyncState, pattern: string, listener: Listener): () => void {
  const entry = { pattern, listener };
  s.patternListeners.push(entry);
  return () => { const i = s.patternListeners.indexOf(entry); if (i !== -1) s.patternListeners.splice(i, 1); };
}

function syncOnce(s: SyncState, pattern: string, listener: Listener): () => void {
  const unsub = syncOn(s, pattern, (cmd, result) => { unsub(); listener(cmd, result); });
  return unsub;
}

function syncOnBefore(s: SyncState, hook: BeforeHook): () => void {
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
      () => resolve({ ok: false, error: new Error(`Request "${action}" timed out after ${timeout}ms`) }),
      timeout
    );

    // Route through the plugin chain with responder as the execute function
    const cmd: Command = { action, target, payload };
    const execute = (): CommandResult => {
      try { return { ok: true, value: responder(cmd) }; }
      catch (e) { return { ok: false, error: e as Error }; }
    };

    let pluginResult: CommandResult;
    try { pluginResult = s.runner(cmd, execute); }
    catch (e) { clearTimeout(timeoutId); resolve({ ok: false, error: e as Error }); return; }

    syncRunHooks(s, cmd, pluginResult);

    if (!pluginResult.ok) { clearTimeout(timeoutId); resolve(pluginResult); return; }

    // Unwrap async responder value if needed
    const maybeAsync = pluginResult.value;
    if (maybeAsync && typeof maybeAsync.then === 'function') {
      maybeAsync
        .then((v: any) => { clearTimeout(timeoutId); resolve({ ok: true, value: v }); })
        .catch((e: Error) => { clearTimeout(timeoutId); resolve({ ok: false, error: e }); });
    } else {
      clearTimeout(timeoutId);
      resolve(pluginResult);
    }
  });
}

function syncRespond(s: SyncState, action: string, handler: (cmd: Command) => any | Promise<any>): () => void {
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

// ---------------------------------------------------------------------------
// createCommandBus
// ---------------------------------------------------------------------------

export function createCommandBus<M extends CommandMap = CommandMap>(options: CommandBusOptions = {}): CommandBus<M> {
  const s: SyncState = {
    opts: options,
    handlers: new Map(), undoHandlers: new Map(),
    pluginEntries: [], beforeHooks: [], afterHooks: [], patternListeners: [],
    responders: new Map(),
    runner: buildRunner([]),
  };
  return {
    dispatch:        (a, t, p)       => syncDispatch(s, a as string, t, p),
    dispatchBatch:   (cmds, o)       => syncDispatchBatch(s, cmds, o),
    register:        (a, h, o)       => syncRegister(s, a as string, h as Handler, o),
    use:             (p, o)          => syncUse(s, p, o),
    onBefore:        (h)             => syncOnBefore(s, h),
    onAfter:         (h)             => syncOnAfter(s, h),
    on:              (pat, l)        => syncOn(s, pat, l),
    once:            (pat, l)        => syncOnce(s, pat, l),
    offAll:          (pat)           => syncOffAll(s, pat),
    request:         (a, t, p, o)   => syncRequest(s, a as string, t, p, o),
    respond:         (a, h)          => syncRespond(s, a, h),
    hasHandler:      (a)             => s.handlers.has(a),
    getUndoHandler:  (a)             => s.undoHandlers.get(a),
    clear:           ()              => syncClear(s),
  };
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
  for (const hook of s.afterHooks.slice()) { try { await hook(cmd, result); } catch (e) { console.error('[vapor-chamber] Hook error:', e); } }
  for (const { pattern, listener } of s.patternListeners.slice()) { if (matchesPattern(pattern, cmd.action)) { try { listener(cmd, result); } catch (e) { console.error('[vapor-chamber] Listener error:', e); } } }
}

async function asyncDispatch(s: AsyncState, action: string, target: any, payload?: any, executeOverride?: () => Promise<CommandResult>): Promise<CommandResult> {
  validateNaming(action, s.opts.naming);
  const cmd: Command = { action, target, payload };
  for (const hook of s.beforeHooks.slice()) {
    try { await hook(cmd); }
    catch (e) {
      const result: CommandResult = { ok: false, error: e as Error };
      await asyncRunHooks(s, cmd, result);
      return result;
    }
  }
  const execute = executeOverride ?? (async (): Promise<CommandResult> => {
    const handler = s.handlers.get(action);
    if (!handler) return handleMissing(s.opts, cmd);
    try { return { ok: true, value: await handler(cmd) }; }
    catch (e) { return { ok: false, error: e as Error }; }
  });
  const result = await s.runner(cmd, execute);
  await asyncRunHooks(s, cmd, result);
  return result;
}

async function asyncDispatchBatch(s: AsyncState, commands: BatchCommand[], opts: BatchOptions = {}): Promise<BatchResult> {
  const results: CommandResult[] = [];
  let firstError: Error | undefined;
  let failCount = 0;
  for (const { action, target, payload } of commands) {
    const result = await asyncDispatch(s, action, target, payload);
    results.push(result);
    if (!result.ok) {
      failCount++;
      if (!opts.continueOnError) return { ok: false, results, error: result.error, successCount: results.length - failCount, failCount };
      if (!firstError) firstError = result.error;
    }
  }
  const successCount = results.length - failCount;
  return firstError ? { ok: false, results, error: firstError, successCount, failCount } : { ok: true, results, successCount, failCount };
}

function asyncRegister(s: AsyncState, action: string, handler: AsyncHandler, opts: RegisterOptions = {}): () => void {
  validateNaming(action, s.opts.naming);
  if (s.handlers.has(action)) {
    console.warn(`[vapor-chamber] Handler for "${action}" is being overwritten. Call unregister first to suppress this warning.`);
  }
  let h = handler;
  if (opts.throttle && opts.throttle > 0) h = wrapThrottle(h, opts.throttle);
  if (opts.undo) s.undoHandlers.set(action, opts.undo);
  s.handlers.set(action, h);
  return () => { s.handlers.delete(action); s.undoHandlers.delete(action); };
}

function asyncUse(s: AsyncState, plugin: AsyncPlugin, opts: PluginOptions = {}): () => void {
  const entry = { plugin, priority: opts.priority ?? 0 };
  s.pluginEntries.push(entry);
  asyncRebuildRunner(s);
  return () => { const i = s.pluginEntries.indexOf(entry); if (i !== -1) { s.pluginEntries.splice(i, 1); asyncRebuildRunner(s); } };
}

function asyncOnAfter(s: AsyncState, hook: AsyncHook): () => void {
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

  // Route through the plugin chain with responder as the execute function
  const executeOverride = responder ? async (): Promise<CommandResult> => {
    try { return { ok: true, value: await responder({ action, target, payload } as Command) }; }
    catch (e) { return { ok: false, error: e as Error }; }
  } : undefined;

  const dispatchPromise = asyncDispatch(s, action, target, payload, executeOverride);

  let timeoutId: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<CommandResult>((resolve) => {
    timeoutId = setTimeout(
      () => resolve({ ok: false, error: new Error(`Request "${action}" timed out after ${timeout}ms`) }),
      timeout
    );
  });

  return Promise.race([
    dispatchPromise.then((r) => { clearTimeout(timeoutId!); return r; }),
    timeoutPromise,
  ]);
}

function asyncRespond(s: AsyncState, action: string, handler: (cmd: Command) => any | Promise<any>): () => void {
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
  s.runner = buildAsyncRunner([]);
}

// ---------------------------------------------------------------------------
// createAsyncCommandBus
// ---------------------------------------------------------------------------

export function createAsyncCommandBus<M extends CommandMap = CommandMap>(options: CommandBusOptions = {}): AsyncCommandBus<M> {
  const s: AsyncState = {
    opts: options,
    handlers: new Map(), undoHandlers: new Map(),
    pluginEntries: [], beforeHooks: [], afterHooks: [], patternListeners: [],
    responders: new Map(),
    runner: buildAsyncRunner([]),
  };
  return {
    dispatch:       (a, t, p)     => asyncDispatch(s, a as string, t, p),
    dispatchBatch:  (cmds, o)     => asyncDispatchBatch(s, cmds, o),
    register:       (a, h, o)     => asyncRegister(s, a as string, h as AsyncHandler, o),
    use:            (p, o)        => asyncUse(s, p, o),
    onBefore:       (h)           => asyncOnBefore(s, h),
    onAfter:        (h)           => asyncOnAfter(s, h),
    on:             (pat, l)      => asyncOn(s, pat, l),
    once:           (pat, l)      => asyncOnce(s, pat, l),
    offAll:         (pat)         => asyncOffAll(s, pat),
    request:        (a, t, p, o)  => asyncRequest(s, a as string, t, p, o),
    respond:        (a, h)        => asyncRespond(s, a, h),
    hasHandler:     (a)           => s.handlers.has(a),
    getUndoHandler: (a)           => s.undoHandlers.get(a),
    clear:          ()            => asyncClear(s),
  };
}
