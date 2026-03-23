/**
 * vapor-chamber — Core plugins (sync)
 *
 * logger, validator, history, debounce, throttle, authGuard, optimistic, optimisticUndo
 */

import type { Command, CommandResult, Plugin, CommandBus } from './command-bus';
import { BusError } from './command-bus';

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
  let _replaying = false; // true during redo dispatch — prevents double-recording

  const plugin: Plugin = (cmd, next) => {
    const result = next();

    if (!_replaying && result.ok && (!filter || filter(cmd))) {
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
            _replaying = true;
            try { undoHandler(cmd); }
            catch (e) { console.error(`[vapor-chamber] Undo handler error for "${cmd.action}":`, e); }
            finally { _replaying = false; }
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
          _replaying = true;
          try { bus.dispatch(cmd.action, cmd.target, cmd.payload); }
          catch (e) { console.error(`[vapor-chamber] Redo dispatch error for "${cmd.action}":`, e); }
          finally { _replaying = false; }
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
): Plugin & { /** Cancel all pending debounce timers. */ dispose(): void } {
  const actionSet = new Set(actions);
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const latestNext = new Map<string, () => CommandResult>();

  const plugin: Plugin = (cmd, next) => {
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

  return Object.assign(plugin, {
    dispose(): void { for (const [, t] of timers) clearTimeout(t); timers.clear(); latestNext.clear(); },
  });
}

/**
 * Throttle plugin - execute immediately, then block for wait period
 */
export function throttle(
  actions: string[],
  wait: number
): Plugin & { /** Cancel all pending throttle timers. */ dispose(): void } {
  const actionSet = new Set(actions);
  const lastRun = new Map<string, number>();
  const timers = new Set<ReturnType<typeof setTimeout>>();

  const plugin: Plugin = (cmd, next) => {
    if (!actionSet.has(cmd.action)) return next();

    const key = `${cmd.action}:${JSON.stringify(cmd.target)}`;
    const now = Date.now();
    const last = lastRun.get(key) ?? 0;

    if (now - last >= wait) {
      lastRun.set(key, now);
      const timer = setTimeout(() => { lastRun.delete(key); timers.delete(timer); }, wait);
      timers.add(timer);
      return next();
    }

    const retryIn = wait - (now - last);
    return { ok: false, value: undefined, error: new BusError('VC_CORE_THROTTLED', `Action "${cmd.action}" throttled. Retry in ${retryIn}ms.`, { emitter: 'core', action: cmd.action, context: { retryIn, wait } }) };
  };

  return Object.assign(plugin, {
    dispose(): void { for (const t of timers) clearTimeout(t); timers.clear(); lastRun.clear(); },
  });
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
 *
 * Accepts per-action `apply` functions that optimistically mutate state
 * and return a rollback closure. If the handler (or async resolution) fails,
 * the rollback is called automatically.
 *
 * @example
 * bus.use(optimistic({
 *   cartAdd: { apply: (cmd) => { addItem(cmd.target); return () => removeItem(cmd.target); } },
 * }));
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

// ---------------------------------------------------------------------------
// optimisticUndo — auto-rollback using registered undo handlers
// ---------------------------------------------------------------------------

export type OptimisticUndoOptions = {
  /**
   * Predict the optimistic result returned immediately to the caller.
   * If omitted, returns `{ ok: true, value: undefined }` as the optimistic result.
   */
  predict?: (cmd: Command) => any;
  /**
   * Called when the real handler fails and the undo handler runs.
   * Use this to notify the UI of the rollback (e.g. show a toast).
   */
  onRollback?: (cmd: Command, error: Error) => void;
  /**
   * Called when the undo handler itself throws during rollback.
   * If omitted, errors are logged to console.error.
   */
  onRollbackError?: (cmd: Command, undoError: Error, originalError: Error) => void;
};

/**
 * Optimistic dispatch plugin that auto-rollbacks using the bus's registered undo handlers.
 *
 * Unlike `optimistic()`, this plugin does **not** require separate `apply`/rollback
 * closures — it uses the undo handler already registered via `register(action, handler, { undo })`.
 *
 * **How it works on an async bus:**
 * 1. Immediately returns `{ ok: true, value: predict(cmd) }` to the caller.
 * 2. The real handler runs in the background.
 * 3. If the real handler fails, the registered undo handler is called automatically.
 *
 * **On a sync bus:** behaves like the regular `optimistic()` — runs handler synchronously,
 * rolls back via undo handler if it fails.
 *
 * **Requires** undo handlers to be registered for the targeted actions.
 * Actions without undo handlers are passed through unchanged.
 *
 * @example
 * bus.register('cartAdd', addToCart, { undo: removeFromCart });
 * bus.use(optimisticUndo(bus, ['cartAdd'], {
 *   predict: (cmd) => ({ id: cmd.target.id, qty: cmd.payload.qty }),
 *   onRollback: (cmd, err) => toast.error(`Failed to add item: ${err.message}`),
 * }));
 * // dispatch returns immediately with predicted result
 * const result = await bus.dispatch('cartAdd', { id: 5 }, { qty: 2 });
 * // result.ok === true, result.value === { id: 5, qty: 2 }
 */
export function optimisticUndo(
  bus: CommandBus,
  actions: string[],
  options: OptimisticUndoOptions = {},
): Plugin {
  const actionSet = new Set(actions);
  const { predict, onRollback, onRollbackError } = options;

  const plugin: any = (cmd: Command, next: () => any) => {
    if (!actionSet.has(cmd.action)) return next();

    const undoHandler = bus.getUndoHandler(cmd.action);
    if (!undoHandler) return next(); // no undo registered — passthrough

    const result = next();

    // Async path: return predicted result immediately, rollback on failure in background
    if (result && typeof result.then === 'function') {
      const optimisticValue = predict ? predict(cmd) : undefined;

      // Fire-and-forget: monitor the real result and rollback if needed
      (result as Promise<CommandResult>).then((r: CommandResult) => {
        if (!r.ok) {
          try { undoHandler(cmd); }
          catch (undoErr) {
            if (onRollbackError) onRollbackError(cmd, undoErr as Error, r.error!);
            else console.error(`[vapor-chamber] Undo rollback error for "${cmd.action}":`, undoErr);
          }
          if (onRollback) onRollback(cmd, r.error!);
        }
      });

      return { ok: true, value: optimisticValue };
    }

    // Sync path: rollback immediately if handler failed
    if (!result.ok) {
      try { undoHandler(cmd); }
      catch (undoErr) {
        if (onRollbackError) onRollbackError(cmd, undoErr as Error, result.error!);
        else console.error(`[vapor-chamber] Undo rollback error for "${cmd.action}":`, undoErr);
      }
      if (onRollback) onRollback(cmd, result.error!);
    }

    return result;
  };

  return plugin as Plugin;
}
