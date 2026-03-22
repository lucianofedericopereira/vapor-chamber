/**
 * vapor-chamber — Core plugins (sync)
 *
 * logger, validator, history, debounce, throttle, authGuard, optimistic
 */

import type { Command, CommandResult, Plugin, CommandBus } from './command-bus';

/**
 * Logger plugin - logs all commands and results
 */
export function logger(options: {
  collapsed?: boolean;
  filter?: (cmd: Command) => boolean;
} = {}): Plugin {
  const { collapsed = true, filter } = options;

  return (cmd, next) => {
    if (filter && !filter(cmd)) return next();

    const label = `⚡ ${cmd.action}`;
    const log = collapsed ? console.groupCollapsed : console.group;

    log(label);
    console.log('target:', cmd.target);
    if (cmd.payload !== undefined) console.log('payload:', cmd.payload);

    const result = next();

    if (result.ok) {
      console.log('result:', result.value);
    } else {
      console.error('error:', result.error);
    }
    console.groupEnd();

    return result;
  };
}

/**
 * Validator plugin - validate commands before execution
 */
export function validator(rules: {
  [action: string]: (cmd: Command) => string | null;
}): Plugin {
  return (cmd, next) => {
    const rule = rules[cmd.action];
    if (rule) {
      const error = rule(cmd);
      if (error) {
        return { ok: false, error: new Error(error) };
      }
    }
    return next();
  };
}

/**
 * History plugin - tracks command history for undo/redo
 *
 * v0.3.0: undo() now executes the inverse handler if the command was
 * registered with { undo: fn } via bus.register(). Falls back to
 * data-only pop if no inverse handler exists.
 */
export interface HistoryState {
  past: Command[];
  future: Command[];
  canUndo: boolean;
  canRedo: boolean;
}

export function history(options: {
  maxSize?: number;
  filter?: (cmd: Command) => boolean;
  /** Reference to the command bus — enables undo() to execute inverse handlers */
  bus?: CommandBus;
} = {}): Plugin & {
  getState: () => HistoryState;
  undo: () => Command | undefined;
  redo: () => Command | undefined;
  clear: () => void;
} {
  const { maxSize = 50, filter, bus } = options;
  const past: Command[] = [];
  const future: Command[] = [];

  const plugin: Plugin = (cmd, next) => {
    const result = next();

    if (result.ok && (!filter || filter(cmd))) {
      past.push(cmd);
      if (past.length > maxSize) past.shift();
      future.length = 0;
    }

    return result;
  };

  return Object.assign(plugin, {
    getState: (): HistoryState => ({
      past: [...past],
      future: [...future],
      canUndo: past.length > 0,
      canRedo: future.length > 0,
    }),

    undo: () => {
      const cmd = past.pop();
      if (cmd) {
        future.push(cmd);
        if (bus) {
          const undoHandler = bus.getUndoHandler(cmd.action);
          if (undoHandler) {
            try { undoHandler(cmd); }
            catch (e) { console.error(`[vapor-chamber] Undo handler error for "${cmd.action}":`, e); }
          }
        }
      }
      return cmd;
    },

    redo: () => {
      const cmd = future.pop();
      if (cmd) {
        past.push(cmd);
        if (bus) {
          try { bus.dispatch(cmd.action, cmd.target, cmd.payload); }
          catch (e) { console.error(`[vapor-chamber] Redo dispatch error for "${cmd.action}":`, e); }
        }
      }
      return cmd;
    },

    clear: () => {
      past.length = 0;
      future.length = 0;
    },
  });
}

/**
 * Debounce plugin - debounce specific actions
 *
 * v0.3.0 FIX: Stores the latest next() closure and re-invokes it after the
 * debounce period. Returns { pending: true } synchronously.
 */
export function debounce(
  actions: string[],
  wait: number
): Plugin {
  const actionSet = new Set(actions);
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const latestNext = new Map<string, () => CommandResult>();

  return (cmd, next) => {
    if (!actionSet.has(cmd.action)) return next();

    const key = `${cmd.action}:${JSON.stringify(cmd.target)}`;

    const existing = timers.get(key);
    if (existing) clearTimeout(existing);

    latestNext.set(key, next);

    timers.set(key, setTimeout(() => {
      timers.delete(key);
      const currentNext = latestNext.get(key);
      latestNext.delete(key);
      if (currentNext) {
        try { currentNext(); }
        catch (e) { console.error('[vapor-chamber] Debounced execution error:', e); }
      }
    }, wait));

    return { ok: true, value: { pending: true, key } };
  };
}

/**
 * Throttle plugin - execute immediately, then block for wait period
 */
export function throttle(
  actions: string[],
  wait: number
): Plugin {
  const actionSet = new Set(actions);
  const lastRun = new Map<string, number>();

  return (cmd, next) => {
    if (!actionSet.has(cmd.action)) return next();

    const key = `${cmd.action}:${JSON.stringify(cmd.target)}`;
    const now = Date.now();
    const last = lastRun.get(key) ?? 0;

    if (now - last >= wait) {
      lastRun.set(key, now);
      setTimeout(() => lastRun.delete(key), wait);
      return next();
    }

    return { ok: false, error: Object.assign(new Error('throttled'), { retryIn: wait - (now - last) }) };
  };
}

/**
 * Auth guard plugin - blocks protected commands when not authenticated.
 */
export function authGuard(options: {
  isAuthenticated: () => boolean;
  protected: string[];
  onUnauthenticated?: (cmd: Command) => void;
}): Plugin {
  const { isAuthenticated, protected: protectedPrefixes, onUnauthenticated } = options;

  return (cmd, next) => {
    const isProtected = protectedPrefixes.some(p =>
      cmd.action.startsWith(p) || cmd.action === p
    );

    if (isProtected && !isAuthenticated()) {
      if (onUnauthenticated) onUnauthenticated(cmd);
      return { ok: false, error: new Error(`Unauthorized: ${cmd.action} requires authentication`) };
    }

    return next();
  };
}

/**
 * Optimistic update plugin - apply optimistic state, rollback on failure.
 */
export function optimistic(
  handlers: Record<string, {
    apply: (cmd: Command) => (() => void) | null;
  }>
): Plugin {
  const plugin: any = (cmd: Command, next: () => any) => {
    const config = handlers[cmd.action];
    if (!config) return next();

    const rollback = config.apply(cmd);
    const result = next();

    // Handle async result (when used on an async bus)
    if (result && typeof result.then === 'function') {
      return result.then((r: CommandResult) => {
        if (!r.ok && rollback) {
          try { rollback(); }
          catch (e) { console.error(`[vapor-chamber] Rollback error for "${cmd.action}":`, e); }
        }
        return r;
      });
    }

    if (!result.ok && rollback) {
      try { rollback(); }
      catch (e) { console.error(`[vapor-chamber] Rollback error for "${cmd.action}":`, e); }
    }

    return result;
  };
  return plugin as Plugin;
}
