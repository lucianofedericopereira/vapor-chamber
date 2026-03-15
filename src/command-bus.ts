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

export interface CommandBus {
  dispatch: (action: string, target: any, payload?: any) => CommandResult;
  register: (action: string, handler: Handler) => () => void;
  use: (plugin: Plugin) => () => void;
  onAfter: (hook: Hook) => () => void;
}

export interface AsyncCommandBus {
  dispatch: (action: string, target: any, payload?: any) => Promise<CommandResult>;
  register: (action: string, handler: AsyncHandler) => () => void;
  use: (plugin: AsyncPlugin) => () => void;
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

export function createCommandBus(): CommandBus {
  const handlers = new Map<string, Handler>();
  const plugins: Plugin[] = [];
  const afterHooks: Hook[] = [];

  // Cached runner — rebuilt only when plugins are added or removed
  let runner = buildRunner(plugins);

  function dispatch(action: string, target: any, payload?: any): CommandResult {
    const cmd: Command = { action, target, payload };
    const handler = handlers.get(action);

    const execute = (): CommandResult => {
      if (!handler) {
        return { ok: false, error: new Error(`No handler: ${action}`) };
      }
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

  function register(action: string, handler: Handler): () => void {
    handlers.set(action, handler);
    return () => handlers.delete(action);
  }

  function use(plugin: Plugin): () => void {
    plugins.push(plugin);
    runner = buildRunner(plugins);
    return () => {
      const i = plugins.indexOf(plugin);
      if (i !== -1) {
        plugins.splice(i, 1);
        runner = buildRunner(plugins);
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

  return { dispatch, register, use, onAfter };
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
export function createAsyncCommandBus(): AsyncCommandBus {
  const handlers = new Map<string, AsyncHandler>();
  const plugins: AsyncPlugin[] = [];
  const afterHooks: AsyncHook[] = [];

  // Cached runner — rebuilt only when plugins are added or removed
  let runner = buildAsyncRunner(plugins);

  async function dispatch(action: string, target: any, payload?: any): Promise<CommandResult> {
    const cmd: Command = { action, target, payload };
    const handler = handlers.get(action);

    const execute = async (): Promise<CommandResult> => {
      if (!handler) {
        return { ok: false, error: new Error(`No handler: ${action}`) };
      }
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

  function register(action: string, handler: AsyncHandler): () => void {
    handlers.set(action, handler);
    return () => handlers.delete(action);
  }

  function use(plugin: AsyncPlugin): () => void {
    plugins.push(plugin);
    runner = buildAsyncRunner(plugins);
    return () => {
      const i = plugins.indexOf(plugin);
      if (i !== -1) {
        plugins.splice(i, 1);
        runner = buildAsyncRunner(plugins);
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

  return { dispatch, register, use, onAfter };
}
