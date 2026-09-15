/**
 * vapor-chamber - Core plugins (sync)
 *
 * logger, validator, history, debounce, throttle, authGuard, optimistic, optimisticUndo
 */

import { DEV } from './dev';
import { onSettled } from './settled';
import { countOption } from './bounds';
import { GLYPH_COMMAND } from './glyphs';
import type { Command, CommandResult, Plugin, CommandBus } from './command-bus';
import { BusError, commandKey, disposeAll, _okResult, _errResult, _withOriginScope } from './command-bus';

/**
 * Logger plugin - logs all commands and results
 *
 * Successful dispatches log at 'info', failed dispatches at 'error'.
 * The default `level: 'info'` shows both (unchanged output); raise it to
 * 'warn' or 'error' to hide successful dispatches and only see failures.
 *
 * @example
 * bus.use(logger()); // logs every dispatch, as before
 *
 * @example
 * // Failures only, with fixed-width [  OK  ] / [ FAIL ] badges
 * // (colored via %c in browsers, plain brackets in Node)
 * bus.use(logger({ level: 'error', badges: true }));
 */
export function logger(options: {
  collapsed?: boolean;
  filter?: (cmd: Command) => boolean;
  /** Minimum level to log. Ok results log at 'info', failures at 'error'. Default: 'info'. */
  level?: 'debug' | 'info' | 'warn' | 'error';
  /** Prefix the group label with a fixed-width [  OK  ] / [ FAIL ] badge. Default: false. */
  badges?: boolean;
} = {}): Plugin {
  const { collapsed = true, filter, level = 'info', badges = false } = options;
  // Ok results log at 'info', failures at 'error' - only 'warn'/'error' can suppress.
  const skipOk = level === 'warn' || level === 'error';

  return ((cmd: Command, next: () => CommandResult) => {
    if (filter && !filter(cmd)) return next();

    const log = collapsed ? console.groupCollapsed : console.group;
    const open = (ok: boolean): void => {
      const label = `${GLYPH_COMMAND} ${cmd.action}`;
      if (!badges) {
        log(label);
      } else {
        const badge = `[ ${ok ? ' OK ' : 'FAIL'} ]`;
        if (typeof window !== 'undefined') log(`%c${badge}%c ${label}`, `background:${ok ? '#2a6' : '#c33'};color:#fff;font-family:monospace`, '');
        else log(`${badge} ${label}`);
      }
    };
    const close = (result: CommandResult): CommandResult => {
      console.log('target:', cmd.target);
      if (cmd.payload !== undefined) console.log('payload:', cmd.payload);
      if (result.ok) {
        console.log('result:', result.value);
      } else {
        console.error('error:', result.error);
      }
      console.groupEnd();
      return result;
    };

    // AN ASYNC BUS HANDS BACK A PROMISE, and both paths below used to treat it
    // as a CommandResult. `promise.ok` is undefined, so the ok-test failed and
    // EVERY command - successful ones included - was logged through
    // `console.error('error:', undefined)`, with the result value never shown
    // at all. Measured on an async bus; see ../settled for the other four
    // plugins that shared the mistake.

    // Fast path (defaults): open the group before the handler runs so nested
    // dispatch logs stay grouped - output identical to previous versions.
    if (!badges && !skipOk) {
      open(true);
      return onSettled(next(), close);
    }

    // Deferred path: the badge / suppression decision needs the result first.
    const decide = (result: CommandResult): CommandResult => {
      if (result.ok && skipOk) return result;
      open(result.ok);
      return close(result);
    };
    return onSettled(next(), decide);
  }) as unknown as Plugin;
}

/**
 * Validator plugin - validate commands before execution
 */
export function validator(rules: {
  [action: string]: (cmd: Command) => string | null;
}): Plugin {
  // Own entries into a Map, once. `rules[cmd.action]` looked up an
  // action name - a string from outside - on an object inheriting from
  // Object.prototype, so `constructor` / `toString` / `valueOf` resolved to
  // inherited functions and ran as rules the caller never wrote (see
  // ../dict). A Map has no prototype chain to walk and turns the per-dispatch
  // property load into a hash lookup, the same "classify once at
  // construction" shape as schemaValidator's `compiled`.
  const compiled = new Map(Object.entries(rules));
  return (cmd, next) => {
    const rule = compiled.get(cmd.action);
    if (rule) {
      const error = rule(cmd);
      if (error) {
        return _errResult(new Error(error));
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
  /** Reference to the command bus - enables undo() to execute inverse handlers */
  bus?: CommandBus;
  /**
   * Action name to register as the undo trigger (e.g. 'cart.undo'). The plugin
   * registers the bus handler itself and ALWAYS excludes this action from
   * recording - even if `filter` would match it. Without this, a hand-wired
   * `bus.register('cart.undo', () => h.undo())` records the trigger command
   * into history (clearing the redo stack and burying real entries), so undo
   * works once and redo never enables. Requires `bus`.
   */
  undoAction?: string;
  /** Action name to register as the redo trigger. Same semantics as undoAction. */
  redoAction?: string;
} = {}): Plugin & {
  getState: () => HistoryState;
  undo: () => Command | undefined;
  redo: () => Command | undefined;
  clear: () => void;
  /** Unregister the undoAction/redoAction bus handlers (no-op if none). */
  dispose: () => void;
} {
  const { maxSize: rawMaxSize = 50, filter, bus, undoAction, redoAction } = options;
  // `past.length > maxSize` gates EVICTION, so a NaN cap evicted nothing and the
  // stack grew without bound - measured at 500 entries against a cap of 50.
  const maxSize = countOption(rawMaxSize, 50);
  const past: Command[] = [];
  const future: Command[] = [];
  // A `_replaying` flag used to bracket the redo dispatch and the undo
  // handler. It held only while the recorder ran INSIDE the dispatch - the
  // sync bus. On an async bus the recorder runs when the dispatch settles,
  // after the `finally` had cleared it, so a redo was recorded twice and the
  // rest of the redo stack wiped; the redo dispatch then got origin 'redo'
  // (`_withOrigin`, the useCommandHistory fix), which the recorder skips on
  // both buses, and the flag stayed for what only it covered on the sync bus:
  // the commands an undo handler or a redone handler dispatch themselves. On
  // the async bus those were still recorded. Since v1.20.0 both windows are a
  // SCOPED origin (`_withOriginScope`, read in stampMeta's synchronous
  // prologue), which marks every dispatch made synchronously inside them on
  // either bus, so the flag went. The origin test sits first because that
  // order measured smallest (+14 B br on the full IIFE, against +20 after
  // the action tests).

  const plugin: Plugin = ((cmd: Command, next: () => CommandResult) => onSettled(next(), (result) => {
    const origin = cmd.meta?.origin;
    if (
      origin !== 'redo' && origin !== 'undo' && result.ok &&
      cmd.action !== undoAction && cmd.action !== redoAction &&
      (!filter || filter(cmd))
    ) {
      past.push(cmd);
      if (past.length > maxSize) past.shift();
      future.length = 0;
    }

    return result;
  })) as unknown as Plugin;

  const api = Object.assign(plugin, {
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
            try { _withOriginScope('undo', () => undoHandler(cmd)); }
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
          try { _withOriginScope('redo', () => bus.dispatch(cmd.action, cmd.target, cmd.payload)); }
          catch (e) { console.error(`[vapor-chamber] Redo dispatch error for "${cmd.action}":`, e); }
        }
      }
      return cmd;
    },

    clear: () => {
      past.length = 0;
      future.length = 0;
    },

    dispose: () => {
      disposeAll(_triggerUnregisters);
    },
  });

  // Self-registered undo/redo triggers - recording above always skips them.
  const _triggerUnregisters: Array<() => void> = [];
  if (undoAction || redoAction) {
    if (!bus) {
      if (DEV) {
        console.warn("[vapor-chamber] history(): undoAction/redoAction require the `bus` option - triggers not registered.");
      }
    } else {
      if (undoAction) _triggerUnregisters.push(bus.register(undoAction, () => { api.undo(); }));
      if (redoAction) _triggerUnregisters.push(bus.register(redoAction, () => { api.redo(); }));
    }
  }

  return api;
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

    const key = commandKey(cmd.action, cmd.target);

    const existing = timers.get(key);
    if (existing) clearTimeout(existing);

    latestNext.set(key, next);

    timers.set(key, setTimeout(() => {
      timers.delete(key);
      const currentNext = latestNext.get(key);
      latestNext.delete(key);
      /* v8 ignore next -- defensive: latestNext and this timer are set
         back-to-back and only cleared together (here or in dispose(), which
         also clears the timer), so a live timer always finds its entry */
      if (currentNext) {
        try { currentNext(); }
        catch (e) { console.error('[vapor-chamber] Debounced execution error:', e); }
      }
    }, wait));

    return _okResult({ pending: true, key });
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

    const key = commandKey(cmd.action, cmd.target);
    const now = Date.now();
    const last = lastRun.get(key) ?? 0;

    if (now - last >= wait) {
      lastRun.set(key, now);
      const timer = setTimeout(() => { lastRun.delete(key); timers.delete(timer); }, wait);
      timers.add(timer);
      return next();
    }

    const retryIn = wait - (now - last);
    return _errResult(new BusError('VC_CORE_THROTTLED', `Action "${cmd.action}" throttled. Retry in ${retryIn}ms.`, { emitter: 'core', action: cmd.action, context: { retryIn, wait } }));
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
      return _errResult(new Error(`Unauthorized: ${cmd.action} requires authentication`));
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
  // Own entries into a Map - see validator() above. `handlers['constructor']`
  // resolved to `Object`, whose `.apply` is Function.prototype.apply, so the
  // plugin called it as the optimistic `apply` and treated the result as a
  // rollback closure.
  const compiled = new Map(Object.entries(handlers));
  const plugin: any = (cmd: Command, next: () => any) => {
    const config = compiled.get(cmd.action);
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
// optimisticUndo - auto-rollback using registered undo handlers
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
 * closures - it uses the undo handler already registered via `register(action, handler, { undo })`.
 *
 * **How it works on an async bus:**
 * 1. Immediately returns `{ ok: true, value: predict(cmd) }` to the caller.
 * 2. The real handler runs in the background.
 * 3. If the real handler fails, the registered undo handler is called automatically.
 *
 * **On a sync bus:** behaves like the regular `optimistic()` - runs handler synchronously,
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
    if (!undoHandler) return next(); // no undo registered - passthrough

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

      return _okResult(optimisticValue);
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
