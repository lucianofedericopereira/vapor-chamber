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
  Command, CommandResult, Handler, Plugin, Hook,
  PluginOptions, BatchCommand, BatchResult, CommandBus,
  Listener, RegisterOptions,
} from './command-bus';
import { buildRunner, matchesPattern } from './command-bus';

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
  /** Clear the recorded list */
  clear(): void;
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
}

/**
 * Creates a test bus that stubs all handlers (returning `{ ok: true }`) unless
 * you register your own via `bus.register()`. All dispatches are recorded.
 */
export function createTestBus(opts: { passthroughHandlers?: boolean } = {}): TestBus {
  const handlers = new Map<string, Handler>();
  const undoHandlers = new Map<string, Handler>();
  const plugins: Array<{ plugin: Plugin; priority: number }> = [];
  const afterHooks: Hook[] = [];
  const patternListeners: Array<{ pattern: string; listener: Listener }> = [];
  const recorded: RecordedDispatch[] = [];

  let runner = buildRunner([]);

  function rebuildRunner() {
    const sorted = plugins.slice().sort((a, b) => b.priority - a.priority).map(e => e.plugin);
    runner = buildRunner(sorted);
  }

  function dispatch(action: string, target: any, payload?: any): CommandResult {
    const cmd: Command = { action, target, payload };
    const handler = handlers.get(action);

    const execute = (): CommandResult => {
      if (opts.passthroughHandlers && handler) {
        try {
          return { ok: true, value: handler(cmd) };
        } catch (e) {
          return { ok: false, error: e as Error };
        }
      }
      if (handler) {
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

    for (const hook of afterHooks.slice()) {
      try { hook(cmd, result); } catch (e) {
        console.error('[vapor-chamber/test] Hook error:', e);
      }
    }
    for (const { pattern, listener } of patternListeners.slice()) {
      if (matchesPattern(pattern, cmd.action)) {
        try { listener(cmd, result); } catch (e) {
          console.error('[vapor-chamber/test] Listener error:', e);
        }
      }
    }

    return result;
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
    const entry = { plugin, priority: options.priority ?? 0 };
    plugins.push(entry);
    rebuildRunner();
    return () => {
      const i = plugins.indexOf(entry);
      if (i !== -1) { plugins.splice(i, 1); rebuildRunner(); }
    };
  }

  function onBefore(_hook: any): () => void {
    return () => {};
  }

  function onAfter(hook: Hook): () => void {
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
    getUndoHandler,
    recorded,
    wasDispatched: (action: string) => recorded.some(r => r.cmd.action === action),
    getDispatched: (action: string) => recorded.filter(r => r.cmd.action === action),
    clear: () => { recorded.splice(0); patternListeners.length = 0; },
    snapshot,
    travelTo,
    travelToAction,
  } as unknown as TestBus;
}
