/**
 * vapor-chamber - Testing utilities
 *
 * createTestBus() creates a command bus that records all dispatched commands
 * without executing real handlers. Useful for unit-testing components that
 * use useCommand() without wiring up the full application logic.
 *
 * v0.4.3: Added snapshot assertions and time-travel through dispatch history.
 * v0.3.0: Added on(), request(), respond(), getUndoHandler() stubs.
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
  Listener, RegisterOptions, CommandMeta, BusInspection,
} from './command-bus';
import { buildRunner, matchesPattern, BusError } from './command-bus';

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
  /** Read-only dispatch — skips beforeHooks, runs handler + plugins, fires afterHooks. */
  query(action: string, target: any, payload?: any): CommandResult;
  /** Fire a domain event — notifies on() listeners, no handler required, no result. */
  emit(event: string, data?: any): void;
  /** Returns all registered action names. */
  registeredActions(): string[];
  /**
   * Snapshot — returns a deep-cloned, serializable copy of the recorded list.
   * Safe to compare with `toEqual` in any test framework.
   */
  snapshot(): RecordedDispatch[];
  /**
   * travelTo — returns the ordered list of commands from dispatch index 0
   * through `index` (inclusive). Useful for asserting the sequence of events
   * that led to a particular state.
   *
   * @param index 0-based index into recorded[]. Clamped to valid range.
   */
  travelTo(index: number): Command[];
  /**
   * travelToAction — returns all commands dispatched up to and including
   * the last occurrence of `action`. Useful for "what happened before this action".
   */
  travelToAction(action: string): Command[];
  /** Full topology snapshot — actions, plugins, hooks, listeners, seal state. */
  inspect(): BusInspection;
}

/**
 * Creates a test bus that stubs all handlers (returning `{ ok: true }`) unless
 * you register your own via `bus.register()`. All dispatches are recorded.
 */
export function createTestBus(opts: { passthroughHandlers?: boolean } = {}): TestBus {
  const handlers = new Map<string, Handler>();
  const undoHandlers = new Map<string, Handler>();
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
    // once() splices itself out mid-iteration — adjust index when array shrinks
    const pl = patternListeners;
    for (let i = 0; i < pl.length; i++) {
      const entry = pl[i];
      if (matchesPattern(entry.pattern, cmd.action)) {
        const lenBefore = pl.length;
        try { entry.listener(cmd, result); } catch (e) {
          console.error('[vapor-chamber/test] Listener error:', e);
        }
        if (pl.length < lenBefore) i--;
      }
    }
  }

  function dispatch(action: string, target: any, payload?: any): CommandResult {
    if (dispatchDepth >= MAX_DISPATCH_DEPTH) {
      return { ok: false, error: new BusError('VC_CORE_MAX_DEPTH', `Maximum dispatch depth (${MAX_DISPATCH_DEPTH}) exceeded for "${action}".`, { emitter: 'test', action }) };
    }
    dispatchDepth++;
    try { return _dispatchInner(action, target, payload); }
    finally { dispatchDepth--; }
  }

  function _dispatchInner(action: string, target: any, payload?: any): CommandResult {
    const cmd: Command = { action, target, payload };

    // Run beforeHooks — throw cancels dispatch
    const bh = beforeHooks;
    for (let i = 0, len = bh.length; i < len; i++) {
      try { bh[i](cmd); }
      catch (e) {
        const result: CommandResult = { ok: false, error: e as Error };
        recorded.push({ cmd, result });
        runAfterHooksAndListeners(cmd, result);
        return result;
      }
    }

    const handler = handlers.get(action);

    const execute = (): CommandResult => {
      if (handler && opts.passthroughHandlers) {
        try {
          return { ok: true, value: handler(cmd) };
        } catch (e) {
          return { ok: false, error: e as Error };
        }
      }
      return { ok: true, value: undefined };
    };

    const result = runner(cmd, execute);
    recorded.push({ cmd, result });
    runAfterHooksAndListeners(cmd, result);
    return result;
  }

  function query(action: string, target: any, payload?: any): CommandResult {
    const cmd: Command = { action, target, payload };
    // Skip beforeHooks — reads don't trigger mutation gates
    const handler = handlers.get(action);
    const execute = (): CommandResult => {
      if (handler && opts.passthroughHandlers) {
        try { return { ok: true, value: handler(cmd) }; }
        catch (e) { return { ok: false, error: e as Error }; }
      }
      return { ok: true, value: undefined };
    };
    const result = runner(cmd, execute);
    recorded.push({ cmd, result });
    runAfterHooksAndListeners(cmd, result);
    return result;
  }

  function emit(event: string, data?: any): void {
    const cmd: Command = { action: event, target: data };
    const result: CommandResult = { ok: true, value: undefined };
    const pl = patternListeners;
    for (let i = 0; i < pl.length; i++) {
      const entry = pl[i];
      if (matchesPattern(entry.pattern, event)) {
        const lenBefore = pl.length;
        try { entry.listener(cmd, result); } catch (e) {
          console.error('[vapor-chamber/test] Listener error:', e);
        }
        if (pl.length < lenBefore) i--;
      }
    }
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

  function request(action: string, target: any): Promise<CommandResult> {
    return Promise.resolve(dispatch(action, target));
  }

  function respond(_action: string, _handler: (cmd: Command) => any): () => void {
    return () => {};
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
    clear: () => { recorded.splice(0); patternListeners.length = 0; beforeHooks.length = 0; sealed = false; },
    dispose: () => { recorded.splice(0); patternListeners.length = 0; beforeHooks.length = 0; afterHooks.length = 0; handlers.clear(); undoHandlers.clear(); plugins.length = 0; sealed = false; },
    seal: () => { sealed = true; },
    isSealed: () => sealed,
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
