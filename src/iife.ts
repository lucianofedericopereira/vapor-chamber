/**
 * vapor-chamber — IIFE variant: FULL
 *
 * Exposes the full vapor-chamber API as `window.VaporChamber`. For sites that
 * want every feature in a single `<script>` tag drop-in. For smaller bundles,
 * see `vapor-chamber-core.iife.js` and `vapor-chamber-elements.iife.js`.
 *
 * Includes: command bus, transports, all plugins, Vapor custom elements,
 * Vapor sync + async (Suspense-aware) composables.
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
  type HttpBridgeOptions,
} from './transports';
import {
  defineVaporCustomElement,
  defineVaporComponent,
  defineVaporAsyncComponent,
  defineVaporCommand,
  useVaporAsyncCommand,
  createVaporChamberApp,
  getVaporInteropPlugin,
} from './chamber-vapor';
import { useSharedCommandState, useCommand } from './chamber';
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

/**
 * connect — one-line setup mirroring the CORE variant's API. Equivalent to
 * `createApp({ transport: createHttpBridge({ csrf: true, ...opts }) })`.
 * Available in every variant so the same call site works regardless of which
 * IIFE bundle is loaded.
 */
function connect(options: HttpBridgeOptions & { plugins?: Plugin[]; onMissing?: CommandBusOptions['onMissing'] }) {
  const { plugins, onMissing, ...httpOptions } = options;
  return createApp({
    transport: createHttpBridge({ csrf: true, ...httpOptions }),
    plugins,
    onMissing,
  });
}

/**
 * defineWidget — one-line custom-element registration mirroring the ELEMENTS
 * variant's API. Returns `false` if Vue 3.6+ Vapor is not detected.
 */
function defineWidget(tagName: string, options: any, extraOptions?: any): boolean {
  const El = extraOptions !== undefined
    ? defineVaporCustomElement(options, extraOptions)
    : defineVaporCustomElement(options);
  if (!El) return false;
  if (typeof customElements === 'undefined') return false;
  if (customElements.get(tagName)) return true;
  customElements.define(tagName, El);
  return true;
}

/**
 * emitDOMEvent — bridge Vue's component emit() to a real DOM CustomEvent so
 * host pages can `addEventListener` on the widget tag. See ELEMENTS variant
 * for the full doc + attribution.
 */
function emitDOMEvent(
  el: Element,
  eventName: string,
  detail?: any,
  options: { bubbles?: boolean; composed?: boolean; cancelable?: boolean } = {},
): boolean {
  if (typeof CustomEvent !== 'function' || !el) return true;
  const event = new CustomEvent(eventName, {
    detail,
    bubbles: options.bubbles ?? true,
    composed: options.composed ?? true,
    cancelable: options.cancelable ?? false,
  });
  return el.dispatchEvent(event);
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
  connect,
  mount,
  defineWidget,
  emitDOMEvent,

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

  // --- Vapor (Vue 3.6+) ---
  defineVaporCustomElement,
  defineVaporComponent,
  defineVaporAsyncComponent,
  defineVaporCommand,
  useCommand,
  useVaporAsyncCommand,
  useSharedCommandState,
  createVaporChamberApp,
  getVaporInteropPlugin,
} as const;

// Assign to globalThis so it's accessible as window.VaporChamber in browsers
if (typeof globalThis !== 'undefined') {
  (globalThis as any).VaporChamber = VaporChamber;
}

export default VaporChamber;
export { VaporChamber };
