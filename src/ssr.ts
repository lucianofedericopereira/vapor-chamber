/**
 * vapor-chamber - SSR hydration plugin
 *
 * rehydrate() replays bus commands ABOVE Vue's DOM hydration, after it
 * completes: it holds no DOM references, hydration anchors or interop state,
 * so Vue's hydration fixes land below it and only hand it a more-correct DOM.
 * The history is in CHANGELOG.md and the whitepaper's section 9.2.
 *
 * Per the whitepaper (section 14): commands that ran on the server to populate initial
 * state need to replay on the client so reactive signals reflect the same values.
 * This plugin automates the dehydrate/rehydrate pattern as a first-class plugin.
 *
 * CONCURRENCY WARNING: the setCommandBus/resetCommandBus pattern below relies on
 * a module-global shared bus - safe only when the server renders one request at
 * a time. Under concurrent SSR renders, interleaved requests overwrite each
 * other's bus (handler/state leakage across requests). For concurrent servers,
 * create the bus per request and pass it explicitly to your handlers and to
 * rehydrate()/dehydrate() - skip the shared-bus globals on the server entirely.
 *
 * The HTTP client has the same rule: its cache and in-flight dedupe map live
 * in `createHttpClient()`'s closure, and the cache key has no auth dimension,
 * so **create it per request** too. A client created once at module scope and
 * shared across renders lets user A's authenticated GET answer user B's.
 *
 * @example Server entry
 * import { createCommandBus, setCommandBus, resetCommandBus } from 'vapor-chamber';
 * import { createSSRPlugin } from 'vapor-chamber/ssr';
 *
 * const bus = createCommandBus();
 * setCommandBus(bus);
 * const ssr = createSSRPlugin();
 * bus.use(ssr.plugin);
 *
 * // ... render app, dispatch commands ...
 *
 * const html = renderToString(app);
 * const serialized = ssr.dehydrate();
 * // Embed: <script>window.__VAPOR_COMMANDS__ = ${JSON.stringify(serialized)}</script>
 * resetCommandBus();
 *
 * @example Client entry
 * import { getCommandBus } from 'vapor-chamber';
 * import { rehydrate } from 'vapor-chamber/ssr';
 *
 * const bus = getCommandBus();
 * rehydrate(bus, window.__VAPOR_COMMANDS__);
 * createVaporChamberApp(App).mount('#app');
 */

import { DEV } from './dev';
import type { Command, CommandResult, Plugin, BaseBus } from './command-bus';
import { _errResult } from './command-bus';
import { onSettled } from './settled';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Serializable command entry for transport between server and client. */
export type DehydratedCommand = {
  action: string;
  target: any;
  payload?: any;
};

export type SSRPluginOptions = {
  /**
   * Filter which commands to record for dehydration. Return false to skip.
   * Default: record all successful commands.
   *
   * @example Skip side-effectful commands
   * filter: (cmd) => !cmd.action.startsWith('analytics')
   */
  filter?: (cmd: Command) => boolean;
  /**
   * Maximum number of commands to record. Prevents unbounded growth in
   * long SSR renders. Default: 500.
   */
  maxCommands?: number;
};

export type SSRPlugin = {
  /** Sync plugin - install on the server bus via bus.use(ssr.plugin). */
  plugin: Plugin;
  /**
   * Extract the recorded commands as a serializable array.
   * Call after SSR render is complete, embed in HTML for the client.
   */
  dehydrate(): DehydratedCommand[];
  /** Clear recorded commands. Call in `finally` block after each SSR request. */
  clear(): void;
  /** Number of recorded commands. */
  size(): number;
  /**
   * How many commands were dropped at the `maxCommands` cap. Non-zero means
   * the client will rehydrate PARTIAL state - server/client divergence. Check
   * it after `dehydrate()` rather than trusting the render silently: a cap
   * that reads as "recorded everything" when it didn't is the failure mode
   * this accessor exists to make visible.
   */
  dropped(): number;
};

export type RehydrateOptions = {
  /**
   * When true, commands that don't have a registered handler are silently
   * skipped instead of producing errors. Default: true.
   */
  ignoreUnhandled?: boolean;
  /**
   * Plugin to suppress side effects during rehydration. When provided,
   * this function is called for each command before dispatch. Return false
   * to skip the dispatch (e.g. for analytics, API calls).
   */
  filter?: (cmd: DehydratedCommand) => boolean;
};

// ---------------------------------------------------------------------------
// createSSRPlugin - server-side recording
// ---------------------------------------------------------------------------

/**
 * createSSRPlugin - records dispatched commands on the server for dehydration.
 *
 * Install the `.plugin` on the server bus. After rendering, call `.dehydrate()`
 * to get a serializable command list for embedding in the HTML payload.
 */
export function createSSRPlugin(options: SSRPluginOptions = {}): SSRPlugin {
  const { filter, maxCommands = 500 } = options;
  const recorded: DehydratedCommand[] = [];
  let droppedCount = 0;
  let capWarned = false;

  // THROUGH `onSettled`: on the async bus `next()` is a promise, whose `.ok`
  // is undefined, so reading it directly records nothing and `dehydrate()`
  // comes back empty with no error (tests/ssr.test.ts, both buses).
  const plugin: Plugin = (cmd, next) => onSettled(next(), (result) => {
    if (result.ok && (!filter || filter(cmd))) {
      if (recorded.length < maxCommands) {
        recorded.push({
          action: cmd.action,
          target: cmd.target,
          ...(cmd.payload !== undefined ? { payload: cmd.payload } : {}),
        });
      } else {
        // Past the cap the client rehydrates partial state, so say so: warn
        // once (a blown cap means thousands) and keep a count.
        droppedCount++;
        if (!capWarned && DEV) {
          capWarned = true;
          console.warn(
            `[vapor-chamber] SSR command recording hit maxCommands (${maxCommands}) at "${cmd.action}". ` +
              'Further commands are dropped and the client will rehydrate PARTIAL state. ' +
              'Raise maxCommands, or narrow what is recorded with the `filter` option.',
          );
        }
      }
    }
    return result;
  }) as CommandResult;

  function dehydrate(): DehydratedCommand[] {
    return [...recorded];
  }

  function clear(): void {
    recorded.length = 0;
    droppedCount = 0;
    capWarned = false;
  }

  function size(): number {
    return recorded.length;
  }

  function dropped(): number {
    return droppedCount;
  }

  return { plugin, dehydrate, clear, size, dropped };
}

// ---------------------------------------------------------------------------
// rehydrate - client-side replay
// ---------------------------------------------------------------------------

/**
 * rehydrate - replay server-recorded commands on the client bus.
 *
 * Dispatches each dehydrated command in order so reactive signals reach the
 * same state as the server render. Commands without registered handlers are
 * silently skipped by default (the handler may not be registered yet during
 * early client bootstrap).
 *
 * @returns Array of results from each replayed command.
 */
export function rehydrate(
  bus: BaseBus,
  commands: DehydratedCommand[],
  options: RehydrateOptions = {},
): CommandResult[] {
  const { ignoreUnhandled = true, filter } = options;
  const results: CommandResult[] = [];
  let asyncWarned = false;

  for (const cmd of commands) {
    if (filter && !filter(cmd)) continue;

    if (ignoreUnhandled && !bus.hasHandler(cmd.action)) continue;

    try {
      const result = bus.dispatch(cmd.action, cmd.target, cmd.payload);
      // `BaseBus.dispatch` returns `any`, so an AsyncCommandBus type-checks
      // here - and this loop is sync. A pending promise pushed as a
      // CommandResult is a lie: `result.ok` reads `undefined`, the try/catch
      // above catches nothing that rejects later, and a failed replay surfaces
      // as an unhandled rejection while `results` reports nothing wrong. Say
      // so instead, and point at the function that actually handles this.
      if (isThenable(result)) {
        (result as Promise<CommandResult>).catch(() => {
          /* already reported below - never an unhandled rejection */
        });
        if (!asyncWarned && DEV) {
          asyncWarned = true;
          console.warn(
            `[vapor-chamber] rehydrate() received a pending dispatch for "${cmd.action}" - ` +
              'this bus is asynchronous and rehydrate() is synchronous. ' +
              'Use `await rehydrateAsync(bus, commands)` instead.',
          );
        }
        results.push({
          ok: false,
          error: new Error(
            `[vapor-chamber] rehydrate() cannot replay "${cmd.action}" on an async bus - use rehydrateAsync()`,
          ),
        });
        continue;
      }
      results.push(result);
    } catch (e) {
      results.push(_errResult(e as Error));
    }
  }

  return results;
}

function isThenable(value: unknown): boolean {
  return value != null && typeof (value as { then?: unknown }).then === 'function';
}

/**
 * rehydrate for an `AsyncCommandBus` - the common case as soon as any handler
 * hits an HTTP transport.
 *
 * Awaits each dispatch **in order**, preserving the module's design intent
 * (deterministic replay before the app goes interactive). A rejected dispatch
 * becomes `{ ok: false, error }` in the results, exactly as a thrown one does
 * on the sync path - never an unhandled rejection.
 */
export async function rehydrateAsync(
  bus: BaseBus,
  commands: DehydratedCommand[],
  options: RehydrateOptions = {},
): Promise<CommandResult[]> {
  const { ignoreUnhandled = true, filter } = options;
  const results: CommandResult[] = [];

  for (const cmd of commands) {
    if (filter && !filter(cmd)) continue;
    if (ignoreUnhandled && !bus.hasHandler(cmd.action)) continue;

    try {
      results.push(await bus.dispatch(cmd.action, cmd.target, cmd.payload));
    } catch (e) {
      results.push(_errResult(e as Error));
    }
  }

  return results;
}
