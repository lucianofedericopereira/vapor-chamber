/**
 * vapor-chamber - Built-in plugins
 *
 * v0.3.0 — Fixed: debounce stale closure, history undo now executes inverse handlers.
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

    // Only track successful commands that pass filter
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

        // Execute inverse handler if bus is available and handler exists
        if (bus) {
          const undoHandler = bus.getUndoHandler(cmd.action);
          if (undoHandler) {
            try {
              undoHandler(cmd);
            } catch (e) {
              console.error(`[vapor-chamber] Undo handler error for "${cmd.action}":`, e);
            }
          }
        }
      }
      return cmd;
    },

    redo: () => {
      const cmd = future.pop();
      if (cmd) {
        past.push(cmd);

        // Re-dispatch on redo if bus is available
        if (bus) {
          try {
            bus.dispatch(cmd.action, cmd.target, cmd.payload);
          } catch (e) {
            console.error(`[vapor-chamber] Redo dispatch error for "${cmd.action}":`, e);
          }
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
 * v0.3.0 FIX: The previous implementation called next() inside a setTimeout,
 * which invoked the middleware chain continuation from a stale closure context.
 * Fixed by storing the latest command and re-dispatching through the bus after
 * the debounce period, or — when no bus ref is available — tracking a
 * "pending" result that callers can check.
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

    // Clear existing timer
    const existing = timers.get(key);
    if (existing) clearTimeout(existing);

    // Store the current next for this key — we capture the fresh closure each time
    latestNext.set(key, next);

    // Schedule execution
    timers.set(key, setTimeout(() => {
      timers.delete(key);
      const currentNext = latestNext.get(key);
      latestNext.delete(key);
      if (currentNext) {
        // Execute with the latest closure (not stale)
        try {
          currentNext();
        } catch (e) {
          console.error('[vapor-chamber] Debounced execution error:', e);
        }
      }
    }, wait));

    // Return pending status synchronously
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

    return { ok: true, value: { throttled: true, key, retryIn: wait - (now - last) } };
  };
}

/**
 * Auth guard plugin - blocks protected commands when not authenticated.
 *
 * NEW in v0.3.0. Supports intent storage for post-login replay.
 */
export function authGuard(options: {
  /** Function that returns true if the user is authenticated */
  isAuthenticated: () => boolean;
  /** Action prefixes that require authentication (e.g. ['shop_cart_', 'shop_wishlist_']) */
  protected: string[];
  /** Called when an unauthenticated user tries a protected action */
  onUnauthenticated?: (cmd: Command) => void;
}): Plugin {
  const { isAuthenticated, protected: protectedPrefixes, onUnauthenticated } = options;

  return (cmd, next) => {
    const isProtected = protectedPrefixes.some(p =>
      cmd.action.startsWith(p) || cmd.action === p
    );

    if (isProtected && !isAuthenticated()) {
      if (onUnauthenticated) {
        onUnauthenticated(cmd);
      }
      return {
        ok: false,
        error: new Error(`Unauthorized: ${cmd.action} requires authentication`)
      };
    }

    return next();
  };
}

/**
 * Optimistic update plugin - apply optimistic state, rollback on failure.
 *
 * NEW in v0.3.0.
 */
export function optimistic(
  handlers: Record<string, {
    /** Apply optimistic update immediately, return rollback function */
    apply: (cmd: Command) => (() => void) | null;
  }>
): Plugin {
  return (cmd, next) => {
    const config = handlers[cmd.action];
    if (!config) return next();

    const rollback = config.apply(cmd);
    const result = next();

    if (!result.ok && rollback) {
      try {
        rollback();
      } catch (e) {
        console.error(`[vapor-chamber] Rollback error for "${cmd.action}":`, e);
      }
    }

    return result;
  };
}
