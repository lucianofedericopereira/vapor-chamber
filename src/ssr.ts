/**
 * vapor-chamber — SSR hydration plugin
 *
 * Vue alignment history (one line per version — full per-item detail lives in
 * CHANGELOG.md and the whitepaper's "Vue 3.6 alignment log" table):
 *   vNext / beta.17 — pass-through. beta.17's lone hydration fix (#14972 — dynamic native
 *            element slots hydrated correctly, cf5eefa) sits in Vue's DOM hydration, below
 *            rehydrate()'s command replay; it only hands replay a more-correct DOM. No code change.
 *   vNext / beta.16 — pass-through. rehydrate() command replay sits ABOVE Vue's DOM
 *            hydration, so beta.16's 7 hydration fixes (dynamic props on mismatch-
 *            recreated nodes, static-text patching, exact tag-mismatch detection,
 *            clone-cache reuse, v-if empty-branch hydration, fragment warning text,
 *            empty-container full mount on createVaporSSRApp — which we do not wrap)
 *            are all below us; they only hand replay a more-correct DOM. They also
 *            reduce "Hydration text mismatch" dev-warnings — the lib keys off nothing
 *            there.
 *   v1.6.0 / beta.15 — pass-through (teleport mount-location tracking + disabled-
 *            target order keep rehydrate() command replay in document order).
 *   v1.4.0 / beta.13 — pass-through (5 hydration fixes: mismatch recovery,
 *            namespace preservation, allowed prop mismatches, teleport-range
 *            sibling walks, dev target validation).
 *   v1.1.0 — module added: dehydrate bus state on the server, rehydrate on client.
 *
 * Per the whitepaper (§14): commands that ran on the server to populate initial
 * state need to replay on the client so reactive signals reflect the same values.
 * This plugin automates the dehydrate/rehydrate pattern as a first-class plugin.
 *
 * CONCURRENCY WARNING: the setCommandBus/resetCommandBus pattern below relies on
 * a module-global shared bus — safe only when the server renders one request at
 * a time. Under concurrent SSR renders, interleaved requests overwrite each
 * other's bus (handler/state leakage across requests). For concurrent servers,
 * create the bus per request and pass it explicitly to your handlers and to
 * rehydrate()/dehydrate() — skip the shared-bus globals on the server entirely.
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

import type { Command, CommandResult, Plugin, BaseBus } from './command-bus';

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
  /** Sync plugin — install on the server bus via bus.use(ssr.plugin). */
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
// createSSRPlugin — server-side recording
// ---------------------------------------------------------------------------

/**
 * createSSRPlugin — records dispatched commands on the server for dehydration.
 *
 * Install the `.plugin` on the server bus. After rendering, call `.dehydrate()`
 * to get a serializable command list for embedding in the HTML payload.
 */
export function createSSRPlugin(options: SSRPluginOptions = {}): SSRPlugin {
  const { filter, maxCommands = 500 } = options;
  const recorded: DehydratedCommand[] = [];

  const plugin: Plugin = (cmd: Command, next: () => CommandResult): CommandResult => {
    const result = next();
    if (result.ok && (!filter || filter(cmd))) {
      if (recorded.length < maxCommands) {
        recorded.push({
          action: cmd.action,
          target: cmd.target,
          ...(cmd.payload !== undefined ? { payload: cmd.payload } : {}),
        });
      }
    }
    return result;
  };

  function dehydrate(): DehydratedCommand[] {
    return [...recorded];
  }

  function clear(): void {
    recorded.length = 0;
  }

  function size(): number {
    return recorded.length;
  }

  return { plugin, dehydrate, clear, size };
}

// ---------------------------------------------------------------------------
// rehydrate — client-side replay
// ---------------------------------------------------------------------------

/**
 * rehydrate — replay server-recorded commands on the client bus.
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

  for (const cmd of commands) {
    if (filter && !filter(cmd)) continue;

    if (ignoreUnhandled && !bus.hasHandler(cmd.action)) continue;

    try {
      const result = bus.dispatch(cmd.action, cmd.target, cmd.payload);
      results.push(result);
    } catch (e) {
      results.push({ ok: false, error: e as Error });
    }
  }

  return results;
}
