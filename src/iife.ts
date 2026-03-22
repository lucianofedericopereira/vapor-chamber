/**
 * vapor-chamber - CDN / IIFE entry point
 *
 * Exposes the full vapor-chamber API as `window.VaporChamber`.
 * Designed for zero-build environments: drop a script tag into any HTML page.
 *
 * Usage:
 * <script src="https://cdn.jsdelivr.net/npm/vapor-chamber/dist/vapor-chamber.iife.js"></script>
 *
 * <script>
 * const { bus } = VaporChamber.createApp({
 *   transport: VaporChamber.http({ endpoint: '/api/vc' })
 * })
 * </script>
 */

import {
  createCommandBus,
  createAsyncCommandBus,
  type CommandBusOptions,
} from './command-bus';
import {
  logger,
  validator,
  history,
  debounce,
  throttle,
  authGuard,
  optimistic,
  retry,
  persist,
  sync,
} from './plugins';
import {
  createHttpBridge,
  createWsBridge,
  createSseBridge,
} from './transports';
import type { AsyncPlugin, Plugin } from './command-bus';

// ---------------------------------------------------------------------------
// createApp — convenience entry point for CDN usage
// ---------------------------------------------------------------------------

export type CreateAppOptions = {
  /**
   * An async transport plugin (e.g. createHttpBridge) to install on the bus.
   * Commands without a local handler are forwarded through this transport.
   */
  transport?: AsyncPlugin;
  /**
   * Plugins to install on the bus (sync or async).
   */
  plugins?: Plugin[];
  /**
   * Dead-letter mode. Default: 'error'
   */
  onMissing?: CommandBusOptions['onMissing'];
};

/**
 * createApp — creates a configured command bus, installs transport + plugins.
 *
 * @example
 * const { bus, dispatch } = VaporChamber.createApp({
 *   transport: VaporChamber.http({ endpoint: '/api/vc' })
 * })
 * dispatch('cartAdd', { id: 1 }, { quantity: 2 })
 */
function createApp(options: CreateAppOptions = {}): {
  bus: ReturnType<typeof createAsyncCommandBus>;
  dispatch: ReturnType<typeof createAsyncCommandBus>['dispatch'];
} {
  const bus = createAsyncCommandBus({ onMissing: options.onMissing ?? 'error' });

  if (options.plugins) {
    for (const plugin of options.plugins) bus.use(plugin as AsyncPlugin);
  }
  if (options.transport) {
    bus.use(options.transport);
  }

  return { bus, dispatch: bus.dispatch.bind(bus) };
}

// ---------------------------------------------------------------------------
// mount — mount a command-bus-driven island to a DOM element
// ---------------------------------------------------------------------------

export type MountOptions = CreateAppOptions & {
  /**
   * Initial state object. Not reactive on its own — use with your own
   * signal library or Vue's ref() for reactivity.
   */
  state?: Record<string, any>;
};

/**
 * mount — attach a command bus island to a specific DOM element.
 *
 * @example
 * VaporChamber.mount('#analytics-island', {
 *   transport: VaporChamber.http({ endpoint: '/api/vc' }),
 *   state: { period: 'week', metrics: [] }
 * })
 */
function mount(selector: string, options: MountOptions = {}): {
  bus: ReturnType<typeof createAsyncCommandBus>;
  dispatch: ReturnType<typeof createAsyncCommandBus>['dispatch'];
  state: Record<string, any>;
  el: Element | null;
} {
  const el = typeof document !== 'undefined' ? document.querySelector(selector) : null;
  const { state = {}, ...appOptions } = options;
  const app = createApp(appOptions);

  return { ...app, state, el };
}

// ---------------------------------------------------------------------------
// Global VaporChamber namespace
// ---------------------------------------------------------------------------

const VaporChamber = {
  // --- Core factories ---
  createCommandBus,
  createAsyncCommandBus,

  // --- Convenience ---
  createApp,
  mount,

  // --- Transport shortcuts ---
  /** HTTP fetch transport. Alias for createHttpBridge(). */
  http: createHttpBridge,
  /** WebSocket transport. Alias for createWsBridge(). */
  ws: createWsBridge,
  /** Server-sent events bridge. Alias for createSseBridge(). */
  sse: createSseBridge,

  // --- Plugins ---
  logger,
  validator,
  history,
  debounce,
  throttle,
  authGuard,
  optimistic,
  retry,
  persist,
  sync,

  // --- Version ---
  version: '0.4.2',
} as const;

// Assign to globalThis so it's accessible as window.VaporChamber in browsers
if (typeof globalThis !== 'undefined') {
  (globalThis as any).VaporChamber = VaporChamber;
}

export default VaporChamber;
export { VaporChamber };
