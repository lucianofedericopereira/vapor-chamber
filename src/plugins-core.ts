/**
 * vapor-chamber - Core plugins (sync)
 *
 * logger, validator, history, debounce, throttle, authGuard, optimistic, optimisticUndo
 */

import { DEV } from './dev';
import { onSettled, isThenable } from './settled';
import { createLedger } from './ledger';
import { GLYPH_COMMAND } from './glyphs';
import type { Command, CommandResult, Plugin, CommandBus, AsyncCommandBus, BaseBus } from './command-bus';
import { commandKey, disposeAll, _okResult, _errResult, _throttleGate, _undo } from './command-bus';

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

  const plugin: Plugin = (cmd, next) => {
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

    // Both paths settle through `onSettled`: on the async bus `next()` is a
    // promise, and reading `.ok` off it would log every command as an error.

    // Fast path (defaults): open the group before the handler runs so nested
    // dispatch logs stay grouped.
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
  };
  return Object.assign(plugin, { id: 'logger' });
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
  const plugin: Plugin = (cmd, next, fail) => {
    const rule = compiled.get(cmd.action);
    if (rule) {
      const error = rule(cmd);
      // Coded, as the catalogue declares for per-action validation; the
      // message stays the rule's own.
      // tests/errors-match-catalogue.test.ts.
      if (error) {
        return _errResult(fail('invalid:payload', error, { action: cmd.action }));
      }
    }
    return next();
  };
  return Object.assign(plugin, { id: 'validator' });
}

/**
 * History plugin - tracks command history for undo/redo
 *
 * undo() dispatches `<action>$undo`, which runs the inverse registered with
 * { undo: fn } via bus.register(), and falls back to a data-only pop if none
 * exists.
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
  /** Either bus: an undo handler is read and a redo dispatched through it. */
  bus?: CommandBus | AsyncCommandBus;
  undoAction?: string;
  redoAction?: string;
} = {}): Plugin & {
  getState: () => HistoryState;
  undo: () => Command | undefined;
  redo: () => Command | undefined;
  clear: () => void;
  dispose: () => void;
} {
  const { maxSize, filter, bus, undoAction, redoAction } = options;
  // The stacks, the recording rule and undo/redo live in ONE place,
  // createLedger (ledger.ts), shared with useCommandHistory. What is this
  // plugin's own: recording in the plugin chain once the dispatch settles, and
  // leaving its trigger actions out.
  const ledger = createLedger({
    maxSize,
    filter,
    bus,
    skip: (cmd) => cmd.action === undoAction || cmd.action === redoAction,
  });
  const { past, future } = ledger;
  const plugin: Plugin = (cmd, next) => onSettled(next(), (result) => {
    ledger.record(cmd, result);
    return result;
  });

  const api = Object.assign(plugin, {
    id: 'history',
    getState: (): HistoryState => ({
      past: [...past],
      future: [...future],
      canUndo: ledger.canUndo(),
      canRedo: future.length > 0,
    }),
    undo: () => ledger.undo(),
    redo: () => ledger.redo(),
    clear: () => ledger.clear(),
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
      const either: BaseBus = bus;
      if (undoAction) _triggerUnregisters.push(either.register(undoAction, () => { api.undo(); }));
      if (redoAction) _triggerUnregisters.push(either.register(redoAction, () => { api.redo(); }));
    }
  }

  return api;
}

/**
 * Debounce plugin - debounce specific actions
 *
 * Runs the latest dispatch per action and target once `wait` passes with no
 * newer one. Returns { pending: true, key } synchronously, `key` being the
 * action and target the timer is kept under (`commandKey`).
 */
export function debounce(
  actions: string[],
  wait: number
): Plugin & { /** Cancel all pending debounce timers. */ dispose(): void } {
  // One entry per key: its timer and the latest next(), replaced together.
  const pending = new Map<string, { timer: ReturnType<typeof setTimeout>; next: () => unknown }>();

  const plugin: Plugin = (cmd, next) => {
    const key = commandKey(cmd.action, cmd.target);
    const existing = pending.get(key);
    if (existing) clearTimeout(existing.timer);

    pending.set(key, { next, timer: setTimeout(() => {
      pending.delete(key);
      try { next(); }
      catch (e) { console.error('[vapor-chamber] Debounced execution error:', e); }
    }, wait) });

    return _okResult({ pending: true, key });
  };

  return Object.assign(plugin, {
    id: 'debounce',
    actions,
    dispose(): void { for (const [, e] of pending) clearTimeout(e.timer); pending.clear(); },
  });
}

/**
 * Throttle plugin - execute immediately, then block for wait period
 */
export function throttle(
  actions: string[],
  wait: number
): Plugin & { /** Cancel all pending throttle timers. */ dispose(): void } {
  const timers = new Set<ReturnType<typeof setTimeout>>();
  // The gate register({ throttle }) uses; a plugin returns the refusal.
  const lastRun = new Map<string, number>();
  const gate = _throttleGate(wait, timers, lastRun);
  const plugin: Plugin = (cmd, next, fail) => {
    // The plugin's own `fail`: the refusal is the plugin's, not core's.
    const refused = gate(cmd, fail);
    return refused ? _errResult(refused) : next();
  };

  return Object.assign(plugin, {
    id: 'throttle',
    actions,
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

  const plugin: Plugin = (cmd, next, fail) => {
    // A prefix match covers the exact name too.
    if (protectedPrefixes.some(p => cmd.action.startsWith(p)) && !isAuthenticated()) {
      if (onUnauthenticated) onUnauthenticated(cmd);
      return _errResult(fail('unauthenticated:action', `Unauthorized: ${cmd.action} requires authentication`, { action: cmd.action }));
    }
    return next();
  };
  return Object.assign(plugin, { id: 'authGuard' });
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
  const plugin: Plugin = (cmd, next) => {
    const config = compiled.get(cmd.action);
    if (!config) return next();

    const rollback = config.apply(cmd);

    // Through `onSettled`: settle the result, roll back if it failed, hand the
    // settled result on - synchronously on the sync bus.
    return onSettled(next(), (result) => {
      if (!result.ok && rollback) {
        try { rollback(); }
        catch (e) { console.error(`[vapor-chamber] Rollback error for "${cmd.action}":`, e); }
      }
      return result;
    });
  };
  return Object.assign(plugin, { id: 'optimistic' });
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
  const { predict, onRollback, onRollbackError } = options;

  const plugin: Plugin = (cmd, next) => {
    const undoHandler = bus.getUndoHandler(cmd.action);
    if (!undoHandler) return next(); // no undo registered - passthrough

    const result = next();

    // The rollback was written out twice - once inside the `.then` below and
    // once for the sync path - and the two copies had to stay in step by hand.
    // This plugin cannot use `onSettled` (see the return values below), but
    // nothing about that required the BODY to be duplicated as well.
    const rollbackIfFailed = (r: CommandResult): void => {
      if (r.ok) return;
      // The rollback is the `$undo` command; a failed or refused one is reported.
      onSettled(_undo(bus, cmd), (u: CommandResult) => {
        if (!u.ok) {
          if (onRollbackError) onRollbackError(cmd, u.error as Error, r.error!);
          else console.error(`[vapor-chamber] Undo rollback error for "${cmd.action}":`, u.error);
        }
        if (onRollback) onRollback(cmd, r.error!);
        return u;
      });
    };

    // THE TWO PATHS RETURN DIFFERENT THINGS, and that is the feature rather
    // than an oversight: on an async bus the point is to answer NOW with the
    // prediction and reconcile in the background, so the settled result is
    // deliberately not handed on. That is why `onSettled` - whose whole
    // contract is to pass the settled result through - cannot serve here, and
    // why a sync bus, having nothing to wait for, returns the real result
    // instead (documented above).
    if (isThenable(result)) {
      const optimisticValue = predict ? predict(cmd) : undefined;
      (result as Promise<CommandResult>).then(rollbackIfFailed);
      return _okResult(optimisticValue);
    }

    rollbackIfFailed(result as CommandResult);
    return result;
  };
  return Object.assign(plugin, { id: 'optimisticUndo', actions });
}
