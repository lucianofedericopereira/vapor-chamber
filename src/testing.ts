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
 * bus.dispatch('cart:add', cart, { id: 1 });
 *
 * // Assert
 * expect(bus.wasDispatched('cart:add')).toBe(true);
 * expect(bus.getDispatched('cart:add')[0].cmd.payload).toEqual({ id: 1 });
 */

import type { Command, CommandResult, Handler, Plugin, Hook, PluginOptions, BatchCommand, BatchResult, CommandBus } from './command-bus';

export interface RecordedDispatch {
  cmd: Command;
  result: CommandResult;
}

export interface TestBus extends CommandBus {
  /** All dispatched commands in order */
  readonly recorded: RecordedDispatch[];
  /** True if any command with this action was dispatched */
  wasDispatched(action: string): boolean;
  /** All recorded dispatches for a given action */
  getDispatched(action: string): RecordedDispatch[];
  /** Clear the recorded list */
  clear(): void;
}

/**
 * Creates a test bus that stubs all handlers (returning `{ ok: true }`) unless
 * you register your own via `bus.register()`. All dispatches are recorded.
 *
 * Pass `{ passthroughHandlers: true }` to execute real handlers while still
 * recording every dispatch.
 */
export function createTestBus(opts: { passthroughHandlers?: boolean } = {}): TestBus {
  const handlers = new Map<string, Handler>();
  const plugins: Array<{ plugin: Plugin; priority: number }> = [];
  const afterHooks: Hook[] = [];
  const recorded: RecordedDispatch[] = [];

  function buildRunner(sortedPlugins: Plugin[]) {
    return function run(cmd: Command, execute: () => CommandResult): CommandResult {
      let i = 0;
      function next(): CommandResult {
        const plugin = sortedPlugins[i++];
        return plugin ? plugin(cmd, next) : execute();
      }
      return next();
    };
  }

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
      // Stub: return ok:true if no real handler registered, run it if one is
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

    for (const hook of afterHooks) {
      try { hook(cmd, result); } catch (e) {
        console.error('[vapor-chamber/test] Hook error:', e);
      }
    }

    return result;
  }

  function dispatchBatch(commands: BatchCommand[]): BatchResult {
    const results: CommandResult[] = [];
    for (const { action, target, payload } of commands) {
      const result = dispatch(action, target, payload);
      results.push(result);
      if (!result.ok) return { ok: false, results, error: result.error };
    }
    return { ok: true, results };
  }

  function register(action: string, handler: Handler): () => void {
    handlers.set(action, handler);
    return () => handlers.delete(action);
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

  function onAfter(hook: Hook): () => void {
    afterHooks.push(hook);
    return () => {
      const i = afterHooks.indexOf(hook);
      if (i !== -1) afterHooks.splice(i, 1);
    };
  }

  return {
    dispatch,
    dispatchBatch,
    register,
    use,
    onAfter,
    recorded,
    wasDispatched: (action) => recorded.some(r => r.cmd.action === action),
    getDispatched: (action) => recorded.filter(r => r.cmd.action === action),
    clear: () => recorded.splice(0),
  };
}
