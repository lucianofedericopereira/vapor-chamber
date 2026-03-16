/**
 * vapor-chamber - Command Bus for Vue Vapor
 * ~2KB gzipped (core + plugins + composables) — DevTools loaded dynamically
 */

export type Command = {
  action: string;
  target: any;
  payload?: any;
};

export type CommandResult = {
  ok: boolean;
  value?: any;
  error?: Error;
};

export type Handler = (cmd: Command) => any;
export type AsyncHandler = (cmd: Command) => Promise<any>;
export type Plugin = (cmd: Command, next: () => CommandResult) => CommandResult;
export type AsyncPlugin = (cmd: Command, next: () => CommandResult | Promise<CommandResult>) => CommandResult | Promise<CommandResult>;
export type Hook = (cmd: Command, result: CommandResult) => void;
export type AsyncHook = (cmd: Command, result: CommandResult) => void | Promise<void>;

/** Options for plugin registration. Higher priority runs first (outermost). Default: 0. */
export type PluginOptions = { priority?: number };

/** Batch dispatch input */
export type BatchCommand = { action: string; target: any; payload?: any };

/** Result of a batch dispatch */
export type BatchResult = { ok: boolean; results: CommandResult[]; error?: Error };

/**
 * Dead letter mode — what to do when a command has no registered handler.
 * - `'error'` (default): returns `{ ok: false, error }`
 * - `'throw'`: throws the error
 * - `'ignore'`: returns `{ ok: true, value: undefined }`
 * - function: called with the command, return value used as result
 */
export type DeadLetterMode = 'error' | 'throw' | 'ignore' | ((cmd: Command) => CommandResult);

export type CommandBusOptions = {
  onMissing?: DeadLetterMode;
};

export interface CommandBus {
  dispatch: (action: string, target: any, payload?: any) => CommandResult;
  dispatchBatch: (commands: BatchCommand[]) => BatchResult;
  register: (action: string, handler: Handler) => () => void;
  use: (plugin: Plugin, options?: PluginOptions) => () => void;
  onAfter: (hook: Hook) => () => void;
}

export interface AsyncCommandBus {
  dispatch: (action: string, target: any, payload?: any) => Promise<CommandResult>;
  dispatchBatch: (commands: BatchCommand[]) => Promise<BatchResult>;
  register: (action: string, handler: AsyncHandler) => () => void;
  use: (plugin: AsyncPlugin, options?: PluginOptions) => () => void;
  onAfter: (hook: AsyncHook) => () => void;
}

// Build a runner once per plugin-list change. On each dispatch the runner
// receives cmd and execute as arguments — no per-dispatch closure allocation.
function buildRunner(plugins: Plugin[]) {
  return function run(cmd: Command, execute: () => CommandResult): CommandResult {
    let i = 0;
    function next(): CommandResult {
      const plugin = plugins[i++];
      return plugin ? plugin(cmd, next) : execute();
    }
    return next();
  };
}

export function createCommandBus(options: CommandBusOptions = {}): CommandBus {
  const handlers = new Map<string, Handler>();
  const pluginEntries: Array<{ plugin: Plugin; priority: number }> = [];
  const afterHooks: Hook[] = [];

  // Cached runner — rebuilt only when plugins are added or removed
  let runner = buildRunner([]);

  function handleMissing(cmd: Command): CommandResult {
    const mode = options.onMissing ?? 'error';
    if (mode === 'ignore') return { ok: true, value: undefined };
    if (mode === 'throw') throw new Error(`No handler: ${cmd.action}`);
    if (typeof mode === 'function') return mode(cmd);
    // 'error' (default)
    return { ok: false, error: new Error(`No handler: ${cmd.action}`) };
  }

  function rebuildRunner() {
    const sorted = pluginEntries
      .slice()
      .sort((a, b) => b.priority - a.priority)
      .map(e => e.plugin);
    runner = buildRunner(sorted);
  }

  function dispatch(action: string, target: any, payload?: any): CommandResult {
    const cmd: Command = { action, target, payload };
    const handler = handlers.get(action);

    const execute = (): CommandResult => {
      if (!handler) return handleMissing(cmd);
      try {
        return { ok: true, value: handler(cmd) };
      } catch (e) {
        return { ok: false, error: e as Error };
      }
    };

    const result = runner(cmd, execute);

    for (const hook of afterHooks) {
      try {
        hook(cmd, result);
      } catch (e) {
        console.error('[vapor-chamber] Hook error:', e);
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

  function use(plugin: Plugin, opts: PluginOptions = {}): () => void {
    const entry = { plugin, priority: opts.priority ?? 0 };
    pluginEntries.push(entry);
    rebuildRunner();
    return () => {
      const i = pluginEntries.indexOf(entry);
      if (i !== -1) {
        pluginEntries.splice(i, 1);
        rebuildRunner();
      }
    };
  }

  function onAfter(hook: Hook): () => void {
    afterHooks.push(hook);
    return () => {
      const i = afterHooks.indexOf(hook);
      if (i !== -1) afterHooks.splice(i, 1);
    };
  }

  return { dispatch, dispatchBatch, register, use, onAfter };
}

function buildAsyncRunner(plugins: AsyncPlugin[]) {
  return function run(
    cmd: Command,
    execute: () => Promise<CommandResult>
  ): Promise<CommandResult> {
    let i = 0;
    function next(): CommandResult | Promise<CommandResult> {
      const plugin = plugins[i++];
      return plugin ? plugin(cmd, next) : execute();
    }
    return Promise.resolve(next());
  };
}

/**
 * Async command bus - supports async handlers, plugins, and hooks
 */
export function createAsyncCommandBus(options: CommandBusOptions = {}): AsyncCommandBus {
  const handlers = new Map<string, AsyncHandler>();
  const pluginEntries: Array<{ plugin: AsyncPlugin; priority: number }> = [];
  const afterHooks: AsyncHook[] = [];

  // Cached runner — rebuilt only when plugins are added or removed
  let runner = buildAsyncRunner([]);

  function handleMissing(cmd: Command): CommandResult {
    const mode = options.onMissing ?? 'error';
    if (mode === 'ignore') return { ok: true, value: undefined };
    if (mode === 'throw') throw new Error(`No handler: ${cmd.action}`);
    if (typeof mode === 'function') return mode(cmd);
    return { ok: false, error: new Error(`No handler: ${cmd.action}`) };
  }

  function rebuildRunner() {
    const sorted = pluginEntries
      .slice()
      .sort((a, b) => b.priority - a.priority)
      .map(e => e.plugin);
    runner = buildAsyncRunner(sorted);
  }

  async function dispatch(action: string, target: any, payload?: any): Promise<CommandResult> {
    const cmd: Command = { action, target, payload };
    const handler = handlers.get(action);

    const execute = async (): Promise<CommandResult> => {
      if (!handler) return handleMissing(cmd);
      try {
        return { ok: true, value: await handler(cmd) };
      } catch (e) {
        return { ok: false, error: e as Error };
      }
    };

    const result = await runner(cmd, execute);

    for (const hook of afterHooks) {
      try {
        await hook(cmd, result);
      } catch (e) {
        console.error('[vapor-chamber] Hook error:', e);
      }
    }

    return result;
  }

  async function dispatchBatch(commands: BatchCommand[]): Promise<BatchResult> {
    const results: CommandResult[] = [];
    for (const { action, target, payload } of commands) {
      const result = await dispatch(action, target, payload);
      results.push(result);
      if (!result.ok) return { ok: false, results, error: result.error };
    }
    return { ok: true, results };
  }

  function register(action: string, handler: AsyncHandler): () => void {
    handlers.set(action, handler);
    return () => handlers.delete(action);
  }

  function use(plugin: AsyncPlugin, opts: PluginOptions = {}): () => void {
    const entry = { plugin, priority: opts.priority ?? 0 };
    pluginEntries.push(entry);
    rebuildRunner();
    return () => {
      const i = pluginEntries.indexOf(entry);
      if (i !== -1) {
        pluginEntries.splice(i, 1);
        rebuildRunner();
      }
    };
  }

  function onAfter(hook: AsyncHook): () => void {
    afterHooks.push(hook);
    return () => {
      const i = afterHooks.indexOf(hook);
      if (i !== -1) afterHooks.splice(i, 1);
    };
  }

  return { dispatch, dispatchBatch, register, use, onAfter };
}
