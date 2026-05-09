/**
 * vapor-chamber — IIFE variant: CORE
 *
 * Audience: server-rendered apps with sprinkled JS — Blade, Rails, Django,
 * .NET MVC, WordPress. The page already returns HTML; you need a command bus
 * to dispatch user actions to the backend (cart add, form submit, analytics).
 *
 * Surface:
 *   • Command bus (sync + async)
 *   • HTTP transport only (createHttpBridge)
 *   • Lightweight plugins: logger, validator, debounce, throttle, retry, authGuard
 *   • createApp() for one-line setup
 *   • connect() — even shorter: HTTP + CSRF in a single call
 *
 * NOT in this variant (use `vapor-chamber.iife.js` if you need them):
 *   • WebSocket / SSE transports — realtime infra is a different deployment shape
 *   • persist / sync / history / optimistic — stateful plugins, niche for sprinkled JS
 *   • mount() — DOM-coupled convenience
 *   • Vapor custom elements — see `vapor-chamber-elements.iife.js`
 *
 * Variant contents are not stable across major versions until v2.0; see ROADMAP.md.
 */

import {
  createCommandBus,
  createAsyncCommandBus,
  type CommandBusOptions,
} from './command-bus';
import {
  logger,
  validator,
  debounce,
  throttle,
  authGuard,
  retry,
} from './plugins';
import { createHttpBridge, type HttpBridgeOptions } from './transports';
import type { AsyncPlugin, Plugin } from './command-bus';

export type CreateAppOptions = {
  transport?: AsyncPlugin;
  plugins?: Plugin[];
  onMissing?: CommandBusOptions['onMissing'];
};

function createApp(options: CreateAppOptions = {}) {
  const bus = createAsyncCommandBus({ onMissing: options.onMissing ?? 'error' });
  if (options.plugins) for (const p of options.plugins) bus.use(p as AsyncPlugin);
  if (options.transport) bus.use(options.transport);
  return { bus, dispatch: bus.dispatch.bind(bus) };
}

/**
 * connect — one-line setup for the sprinkled-JS audience.
 *
 * Equivalent to:
 *   createApp({ transport: createHttpBridge({ endpoint, csrf: true, ...rest }) })
 *
 * @example
 * <script>
 *   const { dispatch } = VaporChamber.connect({ endpoint: '/api/vc' });
 *   document.getElementById('add').addEventListener('click', () => {
 *     dispatch('cartAdd', { id: 42 });
 *   });
 * </script>
 */
function connect(options: HttpBridgeOptions & { plugins?: Plugin[]; onMissing?: CommandBusOptions['onMissing'] }) {
  const { plugins, onMissing, ...httpOptions } = options;
  return createApp({
    transport: createHttpBridge({ csrf: true, ...httpOptions }),
    plugins,
    onMissing,
  });
}

const VaporChamber = {
  // Bus
  createCommandBus,
  createAsyncCommandBus,
  // Convenience
  createApp,
  connect,
  // Transport (HTTP only in core)
  http: createHttpBridge,
  // Plugins (lightweight only in core)
  logger,
  validator,
  debounce,
  throttle,
  authGuard,
  retry,
} as const;

if (typeof globalThis !== 'undefined') {
  (globalThis as any).VaporChamber = VaporChamber;
}

export default VaporChamber;
export { VaporChamber };
