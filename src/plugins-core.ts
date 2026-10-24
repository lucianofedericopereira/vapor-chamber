/**
 * vapor-chamber - Core plugins (sync)
 *
 * logger, validator, history (not a plugin: it installs its own recorder),
 * authGuard. Pacing is the sender's (`pace`, src/pace.ts).
 */

import { createLedger, recordOn } from './ledger';
import { GLYPH_COMMAND } from './glyphs';
import type { Command, Fail, PluginParts, CommandBus, AsyncCommandBus, BaseBus, ScopeOptions } from './command-bus';
import { disposeAll, _errResult } from './command-bus';
import { matchesPattern } from './pattern';
import { _registerLocal } from './library-names';

/**
 * Logger plugin - logs all commands and results
 *
 * Successful dispatches log at 'info', failed dispatches at 'error'.
 * The default `level: 'info'` shows both. Raise it to
 * 'warn' or 'error' to hide successful dispatches and only see failures.
 *
 * @example
 * bus.use(logger()); // logs every dispatch and query
 *
 * @example
 * // Failures only, with fixed-width [  OK  ] / [ FAIL ] badges
 * // (colored via %c in browsers, plain brackets in Node)
 * bus.use(logger({ level: 'error', badges: true }));
 */
export function logger(options: ScopeOptions & {
  collapsed?: boolean;
  /** Minimum level to log. Ok results log at 'info', failures at 'error'. Default: 'info'. */
  level?: 'debug' | 'info' | 'warn' | 'error';
  /** Prefix the group label with a fixed-width [  OK  ] / [ FAIL ] badge. Default: false. */
  badges?: boolean;
} = {}): PluginParts {
  const { collapsed = true, level = 'info', badges = false } = options;
  // Ok results log at 'info', failures at 'error' - only 'warn'/'error' can suppress.
  const skipOk = level === 'warn' || level === 'error';
  // A `settled` part: the bus calls it with the result every outcome ends in,
  // so a refusal from anywhere is logged, wherever the logger is installed.
  // The group is written whole at the settle, so a nested dispatch's group
  // prints before its parent's. tests/plugin-settled-part.test.ts.
  return {
    id: 'logger',
    actions: options.actions,
    actionFilter: options.actionFilter,
    settled(cmd, result) {
      if (result.ok && skipOk) return;
      const log = collapsed ? console.groupCollapsed : console.group;
      const label = `${GLYPH_COMMAND} ${cmd.action}`;
      if (!badges) {
        log(label);
      } else {
        const badge = `[ ${result.ok ? ' OK ' : 'FAIL'} ]`;
        if (typeof window !== 'undefined') log(`%c${badge}%c ${label}`, `background:${result.ok ? '#2a6' : '#c33'};color:#fff;font-family:monospace`, '');
        else log(`${badge} ${label}`);
      }
      console.log('target:', cmd.target);
      if (cmd.payload !== undefined) console.log('payload:', cmd.payload);
      if (result.ok) {
        console.log('result:', result.value);
      } else {
        console.error('error:', result.error);
      }
      console.groupEnd();
    },
  };
}

/**
 * Validator - each action's rule, run before every plugin and the work: a
 * message refuses the command, `null` lets it through. A `validate` part
 * (PluginParts), so install it with `bus.use()`.
 */
export function validator(rules: {
  [action: string]: (cmd: Command) => string | null;
}): PluginParts {
  // Own entries into a Map, once. `rules[cmd.action]` looked up an
  // action name - a string from outside - on an object inheriting from
  // Object.prototype, so `constructor` / `toString` / `valueOf` resolved to
  // inherited functions and ran as rules the caller never wrote (see
  // ../dict). A Map has no prototype chain to walk, and the bus asks it
  // once per action.
  const compiled = new Map(Object.entries(rules));
  return {
    id: 'validator',
    validate(action) {
      const rule = compiled.get(action);
      // Coded, as the catalogue declares for per-action validation; the
      // message stays the rule's own.
      // tests/errors-match-catalogue.test.ts.
      return rule && ((cmd, fail) => {
        const error = rule(cmd);
        return error ? _errResult(fail('invalid:payload', error, { action: cmd.action })) : undefined;
      });
    },
  };
}

/** What `history().getState()` returns: the ledger's stacks, `readonly` (each change writes new ones). */
export interface HistoryState {
  past: readonly Command[];
  future: readonly Command[];
  canUndo: boolean;
  canRedo: boolean;
}

/**
 * history - undo/redo of the commands dispatched on `bus`, recorded from the
 * call on. Not a plugin: the recorder is the ledger's (ledger.ts), so it
 * records what the caller got wherever plugins sit. undo() dispatches
 * `<action>$undo`, which runs the inverse registered with `{ undo: fn }` via
 * bus.register(); with none it only moves the step. `undoAction` /
 * `redoAction` register actions that press undo and redo.
 */
export function history(options: ScopeOptions & {
  /** Either bus: recorded on, an undo handler read and a redo dispatched through it. */
  bus: CommandBus | AsyncCommandBus;
  maxSize?: number;
  undoAction?: string;
  redoAction?: string;
}): {
  getState: () => HistoryState;
  undo: () => Command | undefined;
  redo: () => Command | undefined;
  clear: () => void;
  dispose: () => void;
} {
  const { maxSize, undoAction, redoAction } = options;
  const bus: BaseBus = options.bus;
  // What is this function's own: leaving its trigger actions out. The rest
  // is the ledger's, shared with useCommandHistory.
  const ledger = createLedger({
    maxSize,
    actions: options.actions,
    actionFilter: options.actionFilter,
    bus: options.bus,
    skip: (cmd) => cmd.action === undoAction || cmd.action === redoAction,
  });
  // The trigger actions first: a sealed bus refuses them before anything is installed.
  const offs: Array<() => void> = [];
  if (undoAction) offs.push(_registerLocal(bus, undoAction, () => { ledger.undo(); }));
  if (redoAction) offs.push(_registerLocal(bus, redoAction, () => { ledger.redo(); }));
  offs.push(recordOn(bus, ledger));
  return {
    getState: () => ({
      past: ledger.past,
      future: ledger.future,
      canUndo: ledger.canUndo(),
      canRedo: ledger.future.length > 0,
    }),
    undo: () => ledger.undo(),
    redo: () => ledger.redo(),
    clear: () => ledger.clear(),
    dispose: () => disposeAll(offs),
  };
}

/**
 * Auth guard - refuses a protected command when not authenticated, before
 * every validator, plugin and the work. An `authorize` part (PluginParts), so
 * install it with `bus.use()`.
 */
export function authGuard(options: {
  isAuthenticated: () => boolean;
  /**
   * Protected actions, each a pattern as everywhere in the library: `'admin'`
   * that action only, `'admin*'` every action that starts with admin, `'*'`
   * every action. tests/auth-guard-pattern.test.ts.
   */
  protected: string[];
  onUnauthenticated?: (cmd: Command) => void;
}): PluginParts {
  const { isAuthenticated, onUnauthenticated } = options;
  const list = options.protected;
  // One check for every protected action; whether an action is protected is
  // decided once per action, by the bus asking `authorize`.
  const check = (cmd: Command, fail: Fail) => {
    if (isAuthenticated()) return undefined;
    if (onUnauthenticated) onUnauthenticated(cmd);
    return _errResult(fail('unauthenticated:action', `Unauthorized: ${cmd.action} requires authentication`, { action: cmd.action }));
  };
  return {
    id: 'authGuard',
    // The library's one pattern rule (`matchesPattern`); `[]` protects nothing.
    authorize: (action) => (list.some((p) => matchesPattern(p, action)) ? check : undefined),
  };
}

