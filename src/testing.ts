/**
 * vapor-chamber - Testing utilities
 *
 * createTestBus() creates a command bus that records all dispatched commands
 * without executing real handlers. Useful for unit-testing components that
 * use useCommand() without wiring up the full application logic.
 *
 * @example
 * const bus = createTestBus();
 * setCommandBus(bus);
 *
 * // Dispatch something under test
 * bus.dispatch('cartAdd', cart, { id: 1 });
 *
 * // Assert
 * expect(bus.wasDispatched('cartAdd')).toBe(true);
 * expect(bus.getDispatched('cartAdd')[0].cmd.payload).toEqual({ id: 1 });
 *
 * // Snapshot: get a serializable copy of recorded dispatches
 * const snap = bus.snapshot();
 *
 * // Time-travel: replay dispatches up to (and including) index N
 * const state = bus.travelTo(2);
 */

import type {
  AsyncPlugin, Command, CommandResult, Handler, Plugin, Hook, BeforeHook,
  PluginOptions, BatchCommand, BatchResult, CommandBus,
  Listener, RegisterOptions, BusInspection,
} from './command-bus';

// The double stands in for the bus, so its failures are core's: a test must
// read the same code it will meet in production.
const testFail = _failures('core');
import { buildRunner, matchesPattern, abortedResult, _failures, _beforeCancel, _errResult, _okResult, _stampMeta, _UNSEAL, _tryCatchHandler } from './command-bus';
import { isThenable } from './settled';
import { _isLibraryAction, _isLibraryRegister } from './library-names';

export interface RecordedDispatch {
  cmd: Command;
  result: CommandResult;
}

export interface TestBus extends CommandBus<any> {
  /** All dispatched commands in order */
  readonly recorded: RecordedDispatch[];
  /** True if any command with this action was dispatched */
  wasDispatched(action: string): boolean;
  /** All recorded dispatches for a given action */
  getDispatched(action: string): RecordedDispatch[];
  /** Clear the recorded list and listeners */
  clear(): void;
  /** Read-only dispatch - skips beforeHooks, runs handler + plugins, fires afterHooks. */
  query(action: string, target: any, payload?: any): CommandResult;
  /** Fire a domain event - notifies on() listeners, no handler required, no result. */
  emit(event: string, data?: any): void;
  /** Returns all registered action names. */
  registeredActions(): string[];
  /**
   * Snapshot - returns a deep-cloned, serializable copy of the recorded list.
   * Safe to compare with `toEqual` in any test framework.
   */
  snapshot(): RecordedDispatch[];
  /**
   * travelTo - returns the ordered list of commands from dispatch index 0
   * through `index` (inclusive). Useful for asserting the sequence of events
   * that led to a particular state.
   *
   * @param index 0-based index into recorded[]. Clamped to valid range.
   */
  travelTo(index: number): Command[];
  /**
   * travelToAction - returns all commands dispatched up to and including
   * the last occurrence of `action`. Useful for "what happened before this action".
   */
  travelToAction(action: string): Command[];
  /** Full topology snapshot - actions, plugins, hooks, listeners, seal state. */
  inspect(): BusInspection;
}

/**
 * Creates a test bus that stubs all handlers (returning `{ ok: true }`) unless
 * you register your own via `bus.register()`. All dispatches are recorded.
 */
export function createTestBus(opts: { passthroughHandlers?: boolean } = {}): TestBus {
  const handlers = new Map<string, Handler>();
  const undoHandlers = new Map<string, Handler>();
  const undoChecks = new Map<string, (cmd: Command) => boolean>();
  const responders = new Map<string, (cmd: Command) => any>();
  const plugins: Array<{ plugin: Plugin; priority: number }> = [];
  const beforeHooks: BeforeHook[] = [];
  const afterHooks: Hook[] = [];
  // Replaced, never spliced, so a fan-out walking it keeps its array (see fanOut).
  let patternListeners: Array<{ pattern: string; listener: Listener; off: boolean }> = [];
  const recorded: RecordedDispatch[] = [];
  let sealed = false;
  let dispatchDepth = 0;
  const MAX_DISPATCH_DEPTH = 16;

  let runner = buildRunner([]);

  function rebuildRunner() {
    const sorted = plugins.slice().sort((a, b) => b.priority - a.priority).map(e => e.plugin);
    runner = buildRunner(sorted);
  }

  function runAfterHooksAndListeners(cmd: Command, result: CommandResult): void {
    // V8-aligned: index-based loop with length snapshot for hooks (no self-removal)
    const ah = afterHooks;
    for (let i = 0, len = ah.length; i < len; i++) {
      try { ah[i](cmd, result); } catch (e) {
        console.error('[vapor-chamber/test] Hook error:', e);
      }
    }
    fanOut(cmd, result, cmd.action);
  }

  /**
   * Listener fan-out by the rule `fanOutListeners` in command-bus.ts states:
   * the listeners that existed when it started; one removed during it is
   * marked off and skipped, one added during it is past `n`.
   *
   * It must match the real buses exactly. It once kept an older cursor
   * correction after they were fixed: a test asserting "called once" failed
   * against behaviour the production bus does not have, and one merely
   * counting calls recorded a phantom and passed.
   */
  function fanOut(cmd: Command, result: CommandResult, matchAgainst: string): void {
    const pl = patternListeners;
    for (let i = 0, n = pl.length; i < n; i++) {
      const entry = pl[i];
      if (!entry.off && matchesPattern(entry.pattern, matchAgainst)) {
        try { entry.listener(cmd, result); } catch (e) {
          console.error('[vapor-chamber/test] Listener error:', e);
        }
      }
    }
  }

  function dispatch(action: string, target: any, payload?: any): CommandResult {
    if (dispatchDepth >= MAX_DISPATCH_DEPTH) {
      return _errResult(testFail('exceeded:depth', `Maximum dispatch depth (${MAX_DISPATCH_DEPTH}) exceeded for "${action}".`, { action, context: { depth: MAX_DISPATCH_DEPTH } }));
    }
    dispatchDepth++;
    try { return _dispatchInner(action, target, payload); }
    finally { dispatchDepth--; }
  }

  function _dispatchInner(action: string, target: any, payload?: any): CommandResult {
    // Stamped exactly like the real buses. Without meta, every meta consumer
    // takes its defensive no-op branch under test and NOTHING FAILS - the
    // `idempotent` plugin never stamps a key, the outbox never sets its replay
    // key, the HTTP bridge never forwards `Idempotency-Key`. A test wiring
    // those plugins to a TestBus exercised the degraded path and passed,
    // verifying nothing about the behaviour it named.
    const cmd: Command = { action, target, payload, meta: _stampMeta(payload) };

    // Run beforeHooks - throw cancels dispatch
    const bh = beforeHooks;
    for (let i = 0, len = bh.length; i < len; i++) {
      try { bh[i](cmd); }
      catch (e) {
        // The same core:refused:hook result a real bus builds.
        const result: CommandResult = _errResult(_beforeCancel(e, action));
        recorded.push({ cmd, result });
        runAfterHooksAndListeners(cmd, result);
        return result;
      }
    }

    const handler = handlers.get(action);

    // `_tryCatchHandler` is the bus's OWN wrapper, not a copy of it: a copy is
    // how a double ends up answering differently from the thing it doubles.
    const execute = (): CommandResult =>
      handler && opts.passthroughHandlers ? _tryCatchHandler(handler, cmd) : _okResult(undefined);

    const result = runner(cmd, execute);
    recorded.push({ cmd, result });
    runAfterHooksAndListeners(cmd, result);
    return result;
  }

  function query(action: string, target: any, payload?: any): CommandResult {
    const cmd: Command = { action, target, payload, meta: _stampMeta(payload) };
    // Skip beforeHooks - reads don't trigger mutation gates
    const handler = handlers.get(action);
    const execute = (): CommandResult =>
      handler && opts.passthroughHandlers ? _tryCatchHandler(handler, cmd) : _okResult(undefined);
    const result = runner(cmd, execute);
    recorded.push({ cmd, result });
    runAfterHooksAndListeners(cmd, result);
    return result;
  }

  function emit(event: string, data?: any): void {
    const cmd: Command = { action: event, target: data };
    const result: CommandResult = _okResult(undefined);
    // Same fan-out, same cursor rule - this carried its own copy of the
    // length-based bug and had to be fixed twice before it was one function.
    fanOut(cmd, result, event);
  }

  function dispatchBatch(commands: BatchCommand[]): BatchResult {
    const results: CommandResult[] = [];
    let failCount = 0;
    for (const { action, target, payload } of commands) {
      const result = dispatch(action, target, payload);
      results.push(result);
      if (!result.ok) {
        failCount++;
        return { ok: false, results, error: result.error, successCount: results.length - failCount, failCount };
      }
    }
    return { ok: true, results, successCount: results.length, failCount: 0 };
  }

  function register(action: string, handler: Handler, regOpts: RegisterOptions = {}): () => void {
    if (sealed) throw testFail('refused:bus', `Cannot call register() on a sealed bus.`);
    // As the real bus: a `$` name is the library's, and an undo is `<action>$undo`.
    if (_isLibraryAction(action) && !_isLibraryRegister()) throw testFail('invalid:name', `Action "${action}": a name with "$" is the library's.`, { context: { action } });
    handlers.set(action, handler);
    const undoKey = action + '$undo';
    const undoH = regOpts.undo && ((c: Command) => (regOpts.undo as Handler)(c.target));
    if (undoH) {
      undoHandlers.set(action, regOpts.undo as Handler);
      handlers.set(undoKey, undoH);
    }
    if (regOpts.canUndo) undoChecks.set(action, regOpts.canUndo);
    // Only what THIS call registered, as the real bus does
    // (tests/register-ownership.test.ts): a test double must not diverge.
    const { undo, canUndo } = regOpts;
    return () => {
      if (handlers.get(action) === handler) handlers.delete(action);
      if (undo && undoHandlers.get(action) === undo) undoHandlers.delete(action);
      if (undoH && handlers.get(undoKey) === undoH) handlers.delete(undoKey);
      if (canUndo && undoChecks.get(action) === canUndo) undoChecks.delete(action);
    };
  }

  function use(plugin: Plugin, options: PluginOptions = {}): () => void {
    if (sealed) throw testFail('refused:bus', `Cannot call use() on a sealed bus.`);
    const entry = { plugin, priority: options.priority ?? 0 };
    plugins.push(entry);
    rebuildRunner();
    return () => {
      const i = plugins.indexOf(entry);
      if (i !== -1) { plugins.splice(i, 1); rebuildRunner(); }
    };
  }

  function onBefore(hook: BeforeHook): () => void {
    if (sealed) throw testFail('refused:bus', `Cannot call onBefore() on a sealed bus.`);
    beforeHooks.push(hook);
    return () => { const i = beforeHooks.indexOf(hook); if (i !== -1) beforeHooks.splice(i, 1); };
  }

  function onAfter(hook: Hook): () => void {
    if (sealed) throw testFail('refused:bus', `Cannot call onAfter() on a sealed bus.`);
    afterHooks.push(hook);
    return () => {
      const i = afterHooks.indexOf(hook);
      if (i !== -1) afterHooks.splice(i, 1);
    };
  }

  function on(pattern: string, listener: Listener): () => void {
    const entry = { pattern, listener, off: false };
    patternListeners.push(entry);
    return () => {
      if (entry.off) return;
      entry.off = true;
      patternListeners = patternListeners.filter((e) => e !== entry);
    };
  }

  function once(pattern: string, listener: Listener): () => void {
    const unsub = on(pattern, (cmd, result) => { unsub(); listener(cmd, result); });
    return unsub;
  }

  function offAll(pattern?: string): void {
    for (const e of patternListeners) if (pattern === undefined || e.pattern === pattern) e.off = true;
    patternListeners = patternListeners.filter((e) => !e.off);
  }

  /**
   * As on a real bus: a responder answers through the plugin chain and the after-hooks, its value
   * is awaited when it is a thenable, an already-aborted signal settles
   * core:aborted:dispatch before the responder runs, and no responder falls back to
   * dispatch(). Not mirrored: the timeout and dispose() settling a waiting
   * request - a double records, it does not wait.
   */
  function request(action: string, target: any, payload?: any, opts: { timeout?: number; signal?: AbortSignal } = {}): Promise<CommandResult> {
    if (opts.signal?.aborted) return Promise.resolve(abortedResult(action, opts.signal));
    const responder = responders.get(action);
    if (!responder) return Promise.resolve(dispatch(action, target, payload));
    const cmd: Command = { action, target, payload, meta: _stampMeta(payload) };
    const result = runner(cmd, () => {
      try { return _okResult(responder(cmd)); }
      catch (e) { return _errResult(e as Error); }
    });
    recorded.push({ cmd, result });
    runAfterHooksAndListeners(cmd, result);
    const v = result.value;
    // `isThenable` narrows to PromiseLike, which is the honest type for a
    // handler's return value - a user handler may return any thenable, not
    // only a real Promise. `respond()` is declared to return a Promise, so the
    // thenable is adopted through one here rather than handed straight back.
    if (result.ok && isThenable(v)) return Promise.resolve(v).then(_okResult, _errResult);
    return Promise.resolve(result);
  }

  function respond(action: string, handler: (cmd: Command) => any): () => void {
    if (sealed) throw testFail('refused:bus', `Cannot call respond() on a sealed bus.`);
    responders.set(action, handler);
    return () => { responders.delete(action); };
  }

  function getUndoHandler(action: string): Handler | undefined {
    return undoHandlers.get(action);
  }

  function snapshot(): RecordedDispatch[] {
    return JSON.parse(JSON.stringify(recorded)) as RecordedDispatch[];
  }

  function travelTo(index: number): Command[] {
    const clamped = Math.max(0, Math.min(index, recorded.length - 1));
    return recorded.slice(0, clamped + 1).map(r => r.cmd);
  }

  function travelToAction(action: string): Command[] {
    let lastIdx = -1;
    for (let i = 0; i < recorded.length; i++) {
      if (recorded[i].cmd.action === action) lastIdx = i;
    }
    if (lastIdx === -1) return [];
    return recorded.slice(0, lastIdx + 1).map(r => r.cmd);
  }

  return {
    dispatch,
    query,
    emit,
    dispatchBatch,
    register,
    use,
    onBefore,
    onAfter,
    on,
    once,
    offAll,
    request,
    respond,
    hasHandler: (action: string) => handlers.has(action),
    registeredActions: () => Array.from(handlers.keys()),
    getUndoHandler,
    getUndoCheck: (action: string) => undoChecks.get(action),
    recorded,
    wasDispatched: (action: string) => recorded.some(r => r.cmd.action === action),
    getDispatched: (action: string) => recorded.filter(r => r.cmd.action === action),
    // A sealed bus refuses clear() and dispose() leaves it sealed, as on the
    // real buses; unsealBus() reopens it through the same symbol. A double
    // that reset `sealed` would pass a test the real bus fails.
    clear: () => {
      if (sealed) throw testFail('refused:bus', `Cannot call clear() on a sealed bus.`);
      recorded.splice(0); offAll(); beforeHooks.length = 0;
    },
    dispose: () => {
      // Plugin dispose() first, as a real bus's dispose() does.
      for (let i = plugins.length - 1; i >= 0; i--) plugins[i].plugin.dispose?.();
      recorded.splice(0); offAll(); beforeHooks.length = 0; afterHooks.length = 0; handlers.clear(); undoHandlers.clear(); undoChecks.clear(); responders.clear(); plugins.length = 0;
    },
    seal: () => { sealed = true; },
    isSealed: () => sealed,
    [_UNSEAL]: () => { sealed = false; },
    inspect: (): BusInspection => ({
      actions: Array.from(handlers.keys()),
      undoActions: Array.from(undoHandlers.keys()),
      responderActions: [],
      pluginCount: plugins.length,
      pluginPriorities: plugins.slice().sort((a, b) => b.priority - a.priority).map(e => e.priority),
      beforeHookCount: beforeHooks.length,
      afterHookCount: afterHooks.length,
      listenerPatterns: patternListeners.map(e => e.pattern),
      sealed,
      dispatchDepth,
      activeTimers: 0,
    }),
    snapshot,
    travelTo,
    travelToAction,
  } as unknown as TestBus;
}

/**
 * A plugin called on its own, outside a bus, wired the way `bus.use()` wires
 * it: with its own `fail`, so its refusals carry its declared `id` (or
 * `'plugin'`) as their owner, exactly as they will on a bus. Here beside
 * `createTestBus` rather than in `vapor-chamber/vitest`, whose pure entry
 * imports nothing from the library at runtime.
 *
 * @example
 * const call = wired(rateLimit({ max: 1, windowMs: 1000 }));
 * call(cmd, next);
 * expect(call(cmd, next)).toFailWith('rateLimit:limited:action');
 */
export function wired<P extends Plugin | AsyncPlugin>(plugin: P): (cmd: Command, next: () => CommandResult | Promise<CommandResult>) => ReturnType<P> {
  const fail = _failures(plugin.id ?? 'plugin');
  return (cmd, next) => (plugin as AsyncPlugin)(cmd, next, fail) as ReturnType<P>;
}
