/**
 * vapor-chamber - Command Bus for Vue Vapor
 * ~1KB - Commands + Plugins + Hooks
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
export type AsyncHandler = (cmd: Command) => any | Promise<any>;
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

export function createCommandBus(): CommandBus {
  const handlers = new Map<string, Handler>();
  const plugins: Plugin[] = [];
  const afterHooks: Hook[] = [];

  function dispatch(action: string, target: any, payload?: any): CommandResult {
    const cmd: Command = { action, target, payload };
    const handler = handlers.get(action);

    // Build execution chain: plugins wrap the handler
    const execute = (): CommandResult => {
      if (!handler) {
        return { ok: false, error: new Error(`No handler: ${action}`) };
      }
      try {
        const value = handler(cmd);
        return { ok: true, value };
      } catch (e) {
        return { ok: false, error: e as Error };
      }
    };

    // Apply plugins (right to left, so first plugin is outermost)
    const chain = plugins.reduceRight<() => CommandResult>(
      (next, plugin) => () => plugin(cmd, next),
      execute
    );

    const result = chain();

    // Run after hooks
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
    return () => {
      const i = plugins.indexOf(plugin);
      if (i !== -1) plugins.splice(i, 1);
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

/**
 * Async command bus - supports async handlers, plugins, and hooks
 */
export function createAsyncCommandBus(): AsyncCommandBus {
  const handlers = new Map<string, AsyncHandler>();
  const plugins: AsyncPlugin[] = [];
  const afterHooks: AsyncHook[] = [];

  async function dispatch(action: string, target: any, payload?: any): Promise<CommandResult> {
    const cmd: Command = { action, target, payload };
    const handler = handlers.get(action);

    // Build execution chain: plugins wrap the handler
    const execute = async (): Promise<CommandResult> => {
      if (!handler) {
        return { ok: false, error: new Error(`No handler: ${action}`) };
      }
      try {
        const value = await handler(cmd);
        return { ok: true, value };
      } catch (e) {
        return { ok: false, error: e as Error };
      }
    };

    // Apply plugins (right to left, so first plugin is outermost)
    const chain = plugins.reduceRight<() => CommandResult | Promise<CommandResult>>(
      (next, plugin) => () => plugin(cmd, next),
      execute
    );

    const result = await chain();

    // Run after hooks
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
    return () => {
      const i = plugins.indexOf(plugin);
      if (i !== -1) plugins.splice(i, 1);
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
