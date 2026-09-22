/**
 * vapor-chamber - Testing utilities
 *
 * createTestBus() creates a command bus that records all dispatched commands
 * without executing real handlers. Useful for unit-testing components that
 * use useCommand() without wiring up the full application logic.
 *
 * v0.4.3: Added snapshot assertions and time-travel through dispatch history.
 * v0.3.0: Added on(), request(), respond(), getUndoHandler() stubs.
 * (request() and respond() are real since v1.20.0 - see request() below.)
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
  Command, CommandResult, Handler, Plugin, Hook, BeforeHook,
  PluginOptions, BatchCommand, BatchResult, CommandBus,
  Listener, RegisterOptions, BusInspection,
} from './command-bus';
import { buildRunner, matchesPattern, abortedResult, BusError, _beforeCancel, _errResult, _okResult, _stampMeta, _UNSEAL, _tryCatchHandler } from './command-bus';
import { isThenable } from './settled';

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
  const responders = new Map<string, (cmd: Command) => any>();
  const plugins: Array<{ plugin: Plugin; priority: number }> = [];
  const beforeHooks: BeforeHook[] = [];
  const afterHooks: Hook[] = [];
  const patternListeners: Array<{ pattern: string; listener: Listener }> = [];
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
   * Listener fan-out with the cursor corrected by IDENTITY, matching
   * `fanOutListeners` in command-bus.ts - see the reasoning there.
   *
   * This used the older `if (len < lenBefore) i--` shape, which handles a
   * listener removing ITSELF but over-corrects the other way: removing a LATER
   * peer shrinks the array without moving anything at or before `i`, so the
   * decrement re-invoked the listener that had just run. Measured on a
   * TestBus with three `'*'` listeners where the first removes the third:
   * ['A', 'A', 'B'] instead of ['A', 'B'].
   *
   * That the real buses were already fixed and this one was not is the whole
   * problem with it living here: a test asserting "called once" fails against
   * behaviour the production bus does not have, and one merely counting calls
   * records a phantom and passes.
   */
  function fanOut(cmd: Command, result: CommandResult, matchAgainst: string): void {
    const pl = patternListeners;
    for (let i = 0; i < pl.length; i++) {
      const entry = pl[i];
      if (matchesPattern(entry.pattern, matchAgainst)) {
        const lenBefore = pl.length;
        try { entry.listener(cmd, result); } catch (e) {
          console.error('[vapor-chamber/test] Listener error:', e);
        }
        if (pl.length < lenBefore && pl[i] !== entry) i -= lenBefore - pl.length;
      }
    }
  }

  function dispatch(action: string, target: any, payload?: any): CommandResult {
    if (dispatchDepth >= MAX_DISPATCH_DEPTH) {
      return _errResult(new BusError('VC_CORE_MAX_DEPTH', `Maximum dispatch depth (${MAX_DISPATCH_DEPTH}) exceeded for "${action}".`, { emitter: 'test', action }));
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
        // The same VC_CORE_BEFORE_CANCEL result a real bus builds (v1.20.0).
        const result: CommandResult = _errResult(_beforeCancel(e, action));
        recorded.push({ cmd, result });
        runAfterHooksAndListeners(cmd, result);
        return result;
      }
    }

    const handler = handlers.get(action);

    // `_tryCatchHandler` is the bus's OWN wrapper, not a copy of it. This
    // closure used to spell the same try/catch out, which is how the harness
    // ends up answering differently from the thing it doubles - the shape of
    // a result here already drifted once for exactly that reason, and before
    // that the missing `meta` and the listener fan-out cursor did too.
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
    if (sealed) throw new BusError('VC_CORE_SEALED', `Cannot call register() on a sealed bus.`, { emitter: 'test' });
    handlers.set(action, handler);
    if (regOpts.undo) {
      undoHandlers.set(action, regOpts.undo);
    }
    return () => {
      handlers.delete(action);
      undoHandlers.delete(action);
    };
  }

  function use(plugin: Plugin, options: PluginOptions = {}): () => void {
    if (sealed) throw new BusError('VC_CORE_SEALED', `Cannot call use() on a sealed bus.`, { emitter: 'test' });
    const entry = { plugin, priority: options.priority ?? 0 };
    plugins.push(entry);
    rebuildRunner();
    return () => {
      const i = plugins.indexOf(entry);
      if (i !== -1) { plugins.splice(i, 1); rebuildRunner(); }
    };
  }

  function onBefore(hook: BeforeHook): () => void {
    if (sealed) throw new BusError('VC_CORE_SEALED', `Cannot call onBefore() on a sealed bus.`, { emitter: 'test' });
    beforeHooks.push(hook);
    return () => { const i = beforeHooks.indexOf(hook); if (i !== -1) beforeHooks.splice(i, 1); };
  }

  function onAfter(hook: Hook): () => void {
    if (sealed) throw new BusError('VC_CORE_SEALED', `Cannot call onAfter() on a sealed bus.`, { emitter: 'test' });
    afterHooks.push(hook);
    return () => {
      const i = afterHooks.indexOf(hook);
      if (i !== -1) afterHooks.splice(i, 1);
    };
  }

  function on(pattern: string, listener: Listener): () => void {
    const entry = { pattern, listener };
    patternListeners.push(entry);
    return () => { const i = patternListeners.indexOf(entry); if (i !== -1) patternListeners.splice(i, 1); };
  }

  function once(pattern: string, listener: Listener): () => void {
    const unsub = on(pattern, (cmd, result) => { unsub(); listener(cmd, result); });
    return unsub;
  }

  function offAll(pattern?: string): void {
    if (pattern === undefined) { patternListeners.length = 0; return; }
    for (let i = patternListeners.length - 1; i >= 0; i--) {
      if (patternListeners[i].pattern === pattern) patternListeners.splice(i, 1);
    }
  }

  /**
   * request() and respond() were stubs until v1.20.0: respond() dropped the
   * handler and request() resolved dispatch(), so a consumer's request path
   * could not be tested against this double. Now, as on a real bus: a
   * responder answers through the plugin chain and the after-hooks, its value
   * is awaited when it is a thenable, an already-aborted signal settles
   * VC_CORE_ABORTED before the responder runs, and no responder falls back to
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
    if (sealed) throw new BusError('VC_CORE_SEALED', `Cannot call respond() on a sealed bus.`, { emitter: 'test' });
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
    recorded,
    wasDispatched: (action: string) => recorded.some(r => r.cmd.action === action),
    getDispatched: (action: string) => recorded.filter(r => r.cmd.action === action),
    // A sealed bus refuses clear() and dispose() leaves it sealed, as on the
    // real buses; unsealBus() reopens it through the same symbol. Both used to
    // reset `sealed`, so a test could pass here and throw VC_CORE_SEALED
    // against the real bus.
    clear: () => {
      if (sealed) throw new BusError('VC_CORE_SEALED', `Cannot call clear() on a sealed bus.`, { emitter: 'test' });
      recorded.splice(0); patternListeners.length = 0; beforeHooks.length = 0;
    },
    dispose: () => {
      // Plugin dispose() first, as a real bus's dispose() does (v1.20.0).
      for (let i = plugins.length - 1; i >= 0; i--) plugins[i].plugin.dispose?.();
      recorded.splice(0); patternListeners.length = 0; beforeHooks.length = 0; afterHooks.length = 0; handlers.clear(); undoHandlers.clear(); responders.clear(); plugins.length = 0;
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
