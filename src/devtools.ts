/**
 * vapor-chamber - Vue DevTools integration
 *
 * Optional. Call setupDevtools(bus, app) once at app setup.
 * Requires @vue/devtools-api to be installed — silently no-ops if not present.
 */

import type { Command, CommandResult, Hook } from './command-bus';

const INSPECTOR_ID = 'vapor-chamber';
const LAYER_ID = 'vapor-chamber';

// Minimal interface — only what setupDevtools actually uses.
// Accepts both CommandBus and AsyncCommandBus without requiring the full type.
interface Observable {
  onAfter: (hook: Hook) => () => void;
}

interface CommandEntry {
  id: number;
  cmd: Command;
  result: CommandResult;
  time: number;
}

/**
 * Connect a command bus to Vue DevTools.
 *
 * - Adds a **Commands** timeline layer: every dispatch appears as an event,
 *   green for success, red for error.
 * - Adds a **Vapor Chamber** inspector panel: browse recent commands,
 *   inspect target/payload/result of each one.
 *
 * @param bus  A CommandBus or AsyncCommandBus instance to observe.
 * @param app  The Vue app instance (passed to setupDevtoolsPlugin).
 * @returns    Unsubscribe function — call it to detach from the bus.
 *
 * @example
 * import { createApp } from 'vue';
 * import { getCommandBus, setupDevtools } from 'vapor-chamber';
 *
 * const app = createApp(App);
 * setupDevtools(getCommandBus(), app);
 * app.mount('#app');
 */
export function setupDevtools(bus: Observable, app: unknown): () => void {
  // Guard: no-op in production. Bundlers (Vite, webpack, Rollup) replace
  // process.env.NODE_ENV with 'production' in prod builds, making this entire
  // function body dead code that tree-shakers eliminate for a true 0KB footprint.
  // globalThis cast avoids requiring @types/node while preserving the replacement target.
  const env = (globalThis as any).process?.env?.NODE_ENV as string | undefined;
  if (env === 'production') {
    return () => {};
  }

  const entries: CommandEntry[] = [];
  let counter = 0;
  let devApi: any = null;

  // Hook into the bus — this runs even before devtools loads
  const unsubscribe = bus.onAfter((cmd, result) => {
    const entry: CommandEntry = {
      id: counter++,
      cmd,
      result,
      time: Date.now(),
    };

    entries.unshift(entry);
    if (entries.length > 100) entries.pop(); // keep last 100 commands

    if (devApi) {
      devApi.addTimelineEvent({
        layerId: LAYER_ID,
        event: {
          time: Date.now(),
          title: cmd.action,
          subtitle: result.ok ? '✓' : '✗ error',
          data: {
            action: cmd.action,
            target: cmd.target,
            ...(cmd.payload !== undefined ? { payload: cmd.payload } : {}),
            ok: result.ok,
            ...(result.ok
              ? { value: result.value }
              : { error: result.error?.message }),
          },
          logType: result.ok ? 'default' : 'error',
        },
      });
      devApi.sendInspectorTree(INSPECTOR_ID);
    }
  });

  // Dynamic import — zero cost if @vue/devtools-api is not installed.
  // Using a variable prevents TypeScript from attempting module resolution
  // on an optional peer dependency that may not be installed.
  const devtoolsModule = '@vue/devtools-api';
  import(devtoolsModule)
    .then(({ setupDevtoolsPlugin }: any) => {
      setupDevtoolsPlugin(
        {
          id: 'vapor-chamber',
          label: 'Vapor Chamber',
          packageName: 'vapor-chamber',
          homepage: 'https://github.com/lucianofedericopereira/vapor-chamber',
          app,
        },
        (api: any) => {
          devApi = api;

          // Timeline layer: one event per dispatched command
          api.addTimelineLayer({
            id: LAYER_ID,
            color: 0x41b883, // Vue green
            label: 'Commands',
          });

          // Inspector panel: browse and inspect recent commands
          api.addInspector({
            id: INSPECTOR_ID,
            label: 'Vapor Chamber',
            icon: 'mediation',
            treeFilterPlaceholder: 'Filter by action',
          });

          // Build the inspector tree from buffered entries
          api.on.getInspectorTree((payload: any) => {
            if (payload.inspectorId !== INSPECTOR_ID) return;

            const filter = (payload.filter ?? '').toLowerCase();

            payload.rootNodes = entries
              .filter(e => !filter || e.cmd.action.toLowerCase().includes(filter))
              .map(e => ({
                id: String(e.id),
                label: e.cmd.action,
                tags: [
                  {
                    label: e.result.ok ? 'ok' : 'error',
                    textColor: 0xffffff,
                    backgroundColor: e.result.ok ? 0x41b883 : 0xff4444,
                  },
                ],
              }));
          });

          // Show full detail when a node is selected in the inspector
          api.on.getInspectorState((payload: any) => {
            if (payload.inspectorId !== INSPECTOR_ID) return;

            const entry = entries.find(e => String(e.id) === payload.nodeId);
            if (!entry) return;

            payload.state = {
              command: [
                { key: 'action', value: entry.cmd.action },
                { key: 'target', value: entry.cmd.target },
                ...(entry.cmd.payload !== undefined
                  ? [{ key: 'payload', value: entry.cmd.payload }]
                  : []),
              ],
              result: [
                { key: 'ok', value: entry.result.ok },
                ...(entry.result.ok
                  ? [{ key: 'value', value: entry.result.value }]
                  : [{ key: 'error', value: entry.result.error?.message }]),
              ],
              meta: [
                { key: 'time', value: new Date(entry.time).toISOString() },
                { key: 'index', value: entry.id },
              ],
            };
          });
        }
      );
    })
    .catch(() => {
      // @vue/devtools-api not installed — silently no-op in production
    });

  return unsubscribe;
}
