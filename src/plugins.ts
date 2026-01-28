/**
 * vapor-chamber - Built-in plugins
 */

import type { Command, CommandResult, Plugin } from './command-bus';

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
  [action: string]: (cmd: Command) => string | null; // returns error message or null
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
 */
export interface HistoryState {
  past: Command[];
  future: Command[];
  canUndo: boolean;
  canRedo: boolean;
}

export function history(options: {
  maxSize?: number;
  filter?: (cmd: Command) => boolean; // only track filtered commands
} = {}): Plugin & {
  getState: () => HistoryState;
  undo: () => Command | undefined;
  redo: () => Command | undefined;
  clear: () => void;
} {
  const { maxSize = 50, filter } = options;
  const past: Command[] = [];
  const future: Command[] = [];

  const plugin: Plugin = (cmd, next) => {
    const result = next();

    // Only track successful commands that pass filter
    if (result.ok && (!filter || filter(cmd))) {
      past.push(cmd);
      if (past.length > maxSize) past.shift();
      future.length = 0; // Clear redo stack on new command
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
      if (cmd) future.push(cmd);
      return cmd;
    },
    redo: () => {
      const cmd = future.pop();
      if (cmd) past.push(cmd);
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
 * Returns a pending result immediately, executes after wait period
 */
export function debounce(
  actions: string[],
  wait: number
): Plugin {
  const actionSet = new Set(actions);
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const results = new Map<string, CommandResult>();

  return (cmd, next) => {
    if (!actionSet.has(cmd.action)) return next();

    const key = `${cmd.action}:${JSON.stringify(cmd.target)}`;

    // Clear existing timer
    const existing = timers.get(key);
    if (existing) clearTimeout(existing);

    // Schedule execution
    timers.set(key, setTimeout(() => {
      const result = next();
      results.set(key, result);
      timers.delete(key);
    }, wait));

    // Return pending status synchronously (check results map for actual result)
    return results.get(key) ?? { ok: true, value: { pending: true, key } };
  };
}

/**
 * Throttle plugin - execute immediately, then block for wait period
 * Unlike debounce, throttle guarantees execution on first call
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
      return next();
    }

    // Throttled - return skipped status
    return { ok: true, value: { throttled: true, key, retryIn: wait - (now - last) } };
  };
}
