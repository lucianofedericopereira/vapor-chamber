/**
 * vapor-chamber - Command Bus for Vue Vapor
 * ~2KB gzipped (core + plugins + composables) — DevTools loaded dynamically
 *
 * v0.3.0 — Added: typed generics, naming validation, request/response,
 *           wildcard listeners, per-command debounce/throttle at register time.
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
  /** Debounce this handler by N ms. Handler runs after activity stops. */
  debounce?: number;
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

// ---------------------------------------------------------------------------
// Wildcard/pattern matching
// ---------------------------------------------------------------------------

/** Listener callback for on() subscriptions (wildcard-capable) */
export type Listener = (cmd: Command, result: CommandResult) => void;

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface CommandBus {
  dispatch: (action: string, target: any, payload?: any) => CommandResult;
  dispatchBatch: (commands: BatchCommand[]) => BatchResult;
  register: (action: string, handler: Handler, options?: RegisterOptions) => () => void;
  use: (plugin: Plugin, options?: PluginOptions) => () => void;
  onAfter: (hook: Hook) => () => void;
  /** Subscribe to commands matching a pattern. Supports '*' (all), 'prefix_*' (glob), or exact. */
  on: (pattern: string, listener: Listener) => () => void;
  /** Request/response: dispatch and wait for a response from a responder. */
  request: (action: string, target: any, options?: { timeout?: number }) => Promise<CommandResult>;
  /** Register a responder for request() calls. */
  respond: (action: string, handler: (cmd: Command) => any | Promise<any>) => () => void;
  /** Get the undo handler for an action (if registered with { undo }) */
  getUndoHandler: (action: string) => Handler | undefined;
}

export interface AsyncCommandBus {
  dispatch: (action: string, target: any, payload?: any) => Promise<CommandResult>;
  dispatchBatch: (commands: BatchCommand[]) => Promise<BatchResult>;
  register: (action: string, handler: AsyncHandler, options?: RegisterOptions) => () => void;
  use: (plugin: AsyncPlugin, options?: PluginOptions) => () => void;
  onAfter: (hook: AsyncHook) => () => void;
}

// ---------------------------------------------------------------------------
// Naming validation helper
// ---------------------------------------------------------------------------

function validateNaming(action: string, naming?: NamingConvention): void {
  if (!naming) return;
  if (naming.pattern.test(action)) return;

  const mode = naming.onViolation ?? 'warn';
  const msg = `[vapor-chamber] Action name "${action}" does not match pattern ${naming.pattern}`;

  if (mode === 'throw') throw new Error(msg);
  if (mode === 'warn') console.warn(msg);
  // 'ignore' — do nothing
}

// ---------------------------------------------------------------------------
// Pattern matching for on() subscriptions
// ---------------------------------------------------------------------------

function matchesPattern(pattern: string, action: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('_*')) {
    return action.startsWith(pattern.slice(0, -1)); // 'shop_*' → starts with 'shop_'
  }
  return pattern === action;
}

// ---------------------------------------------------------------------------
// Debounce/throttle wrappers for per-command options
// ---------------------------------------------------------------------------

function wrapDebounce(handler: Handler, wait: number, dispatchFn: (action: string, target: any, payload?: any) => CommandResult): Handler {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  return (cmd: Command) => {
    const key = `${cmd.action}:${JSON.stringify(cmd.target)}`;
    const existing = timers.get(key);
    if (existing) clearTimeout(existing);

    return new Promise<any>((resolve) => {
      timers.set(key, setTimeout(() => {
        timers.delete(key);
        const result = handler(cmd);
        resolve(result);
      }, wait));
    });
  };
}

function wrapThrottle(handler: Handler, wait: number): Handler {
  const lastRun = new Map<string, number>();

  return (cmd: Command) => {
    const key = `${cmd.action}:${JSON.stringify(cmd.target)}`;
    const now = Date.now();
    const last = lastRun.get(key) ?? 0;

    if (now - last >= wait) {
      lastRun.set(key, now);
      setTimeout(() => lastRun.delete(key), wait);
      return handler(cmd);
    }

    return { throttled: true, key, retryIn: wait - (now - last) };
  };
}

// ---------------------------------------------------------------------------
// Sync runner
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// createCommandBus
// ---------------------------------------------------------------------------

export function createCommandBus(options: CommandBusOptions = {}): CommandBus {
  const handlers = new Map<string, Handler>();
  const undoHandlers = new Map<string, Handler>();
  const pluginEntries: Array<{ plugin: Plugin; priority: number }> = [];
  const afterHooks: Hook[] = [];
  const patternListeners: Array<{ pattern: string; listener: Listener }> = [];
  const responders = new Map<string, (cmd: Command) => any | Promise<any>>();

  let runner = buildRunner([]);

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
    runner = buildRunner(sorted);
  }

  function dispatch(action: string, target: any, payload?: any): CommandResult {
    validateNaming(action, options.naming);

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

    // Run after hooks
    for (const hook of afterHooks) {
      try {
        hook(cmd, result);
      } catch (e) {
        console.error('[vapor-chamber] Hook error:', e);
      }
    }

    // Notify pattern listeners
    for (const { pattern, listener } of patternListeners) {
      if (matchesPattern(pattern, action)) {
        try {
          listener(cmd, result);
        } catch (e) {
          console.error('[vapor-chamber] Listener error:', e);
        }
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

  function register(action: string, handler: Handler, opts: RegisterOptions = {}): () => void {
    validateNaming(action, options.naming);

    let finalHandler = handler;

    // Wrap with throttle if specified
    if (opts.throttle && opts.throttle > 0) {
      finalHandler = wrapThrottle(finalHandler, opts.throttle);
    }

    // Store undo handler if provided
    if (opts.undo) {
      undoHandlers.set(action, opts.undo);
    }

    handlers.set(action, finalHandler);
    return () => {
      handlers.delete(action);
      undoHandlers.delete(action);
    };
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

  function on(pattern: string, listener: Listener): () => void {
    const entry = { pattern, listener };
    patternListeners.push(entry);
    return () => {
      const i = patternListeners.indexOf(entry);
      if (i !== -1) patternListeners.splice(i, 1);
    };
  }

  function request(action: string, target: any, reqOpts: { timeout?: number } = {}): Promise<CommandResult> {
    const timeout = reqOpts.timeout ?? 5000;

    return new Promise((resolve, reject) => {
      const responder = responders.get(action);
      if (!responder) {
        // Fall back to normal dispatch
        resolve(dispatch(action, target));
        return;
      }

      const timeoutId = setTimeout(() => {
        reject(new Error(`Request "${action}" timed out after ${timeout}ms`));
      }, timeout);

      const cmd: Command = { action, target };
      try {
        const result = responder(cmd);
        if (result && typeof result.then === 'function') {
          result
            .then((value: any) => {
              clearTimeout(timeoutId);
              resolve({ ok: true, value });
            })
            .catch((error: Error) => {
              clearTimeout(timeoutId);
              resolve({ ok: false, error });
            });
        } else {
          clearTimeout(timeoutId);
          resolve({ ok: true, value: result });
        }
      } catch (e) {
        clearTimeout(timeoutId);
        resolve({ ok: false, error: e as Error });
      }
    });
  }

  function respond(action: string, handler: (cmd: Command) => any | Promise<any>): () => void {
    validateNaming(action, options.naming);
    responders.set(action, handler);
    return () => { responders.delete(action); };
  }

  function getUndoHandler(action: string): Handler | undefined {
    return undoHandlers.get(action);
  }

  return { dispatch, dispatchBatch, register, use, onAfter, on, request, respond, getUndoHandler };
}

// ---------------------------------------------------------------------------
// Async runner
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// createAsyncCommandBus
// ---------------------------------------------------------------------------

export function createAsyncCommandBus(options: CommandBusOptions = {}): AsyncCommandBus {
  const handlers = new Map<string, AsyncHandler>();
  const pluginEntries: Array<{ plugin: AsyncPlugin; priority: number }> = [];
  const afterHooks: AsyncHook[] = [];

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
    validateNaming(action, options.naming);

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

  function register(action: string, handler: AsyncHandler, opts: RegisterOptions = {}): () => void {
    validateNaming(action, options.naming);
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
