/**
 * vapor-chamber — Vue 3.6+ Vapor-specific API
 *
 * createVaporChamberApp, getVaporInteropPlugin, defineVaporCommand
 *
 * Separated from chamber.ts to keep the core composable module CDCC-compliant.
 */

import {
  getCommandBus,
  tryAutoCleanup,
  getVaporAppFn,
  getVaporInteropRef,
} from './chamber';
import type { Handler, RegisterOptions, CommandResult } from './command-bus';

/**
 * Create a Vapor app instance with vapor-chamber ready.
 * Requires Vue 3.6+. Throws if Vapor is not available.
 *
 * @example
 * import { createVaporChamberApp } from 'vapor-chamber';
 * import App from './App.vue';
 * createVaporChamberApp(App).mount('#app');
 */
export function createVaporChamberApp(rootComponent: any, rootProps?: any) {
  const fn = getVaporAppFn();
  if (!fn) {
    throw new Error(
      '[vapor-chamber] Vue 3.6+ with Vapor mode required. ' +
      'Install vue@^3.6.0-beta.1 or use createApp() for VDOM mode.'
    );
  }
  return fn(rootComponent, rootProps);
}

/**
 * Returns the vaporInteropPlugin if available (Vue 3.6+).
 * Use this to enable mixed Vapor/VDOM component trees.
 *
 * @example
 * import { createApp } from 'vue';
 * import { getVaporInteropPlugin } from 'vapor-chamber';
 * const plugin = getVaporInteropPlugin();
 * if (plugin) createApp(App).use(plugin).mount('#app');
 */
export function getVaporInteropPlugin(): any | null {
  return getVaporInteropRef();
}

/**
 * defineVaporCommand — zero-overhead command for hot paths in Vapor mode.
 *
 * Unlike useCommand(), this skips reactive loading/error signal creation.
 * Ideal for high-frequency dispatches: scroll tracking, mousemove, GA4 events,
 * debounced search, and any fire-and-forget pattern where you don't need
 * reactive loading/error state.
 *
 * @example
 * const { dispatch } = defineVaporCommand('analyticsTrack', (cmd) => {
 *   gtag('event', cmd.target.event, cmd.target.params);
 * });
 * dispatch({ event: 'page_view', params: { page: '/shop' } });
 */
export function defineVaporCommand(
  action: string,
  handler: Handler,
  options?: RegisterOptions
) {
  const bus = getCommandBus();
  const unregister = bus.register(action, handler, options);

  function dispatch(target: any, payload?: any): CommandResult {
    return bus.dispatch(action, target, payload);
  }

  function dispose() { unregister(); }

  tryAutoCleanup(dispose);

  return { dispatch, dispose };
}
