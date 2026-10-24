/**
 * vapor-chamber - IIFE variant: FULL
 *
 * Exposes the full vapor-chamber API as `window.VaporChamber`. For sites that
 * want every feature in a single `<script>` tag drop-in. For smaller bundles,
 * see `vapor-chamber-core.iife.js` and `vapor-chamber-elements.iife.js`.
 *
 * Includes: command bus, transports, the core and I/O plugins (logger,
 * validator, history, authGuard, createChannel), pace, bindCommands, bindDisplay,
 * the store (`defineChamberStore`, the core store, with its `persist`), Vapor custom elements,
 * Vapor sync + async (Suspense-aware) composables.
 *
 * Usage:
 * <script src="https://cdn.jsdelivr.net/npm/vapor-chamber/dist/vapor-chamber.iife.js"></script>
 *
 * <script>
 * const { bus } = VaporChamber.createApp({
 *   transport: VaporChamber.httpTransport({ endpoint: '/api/vc' })
 * })
 * </script>
 */

import { createCommandBus, createAsyncCommandBus, type BaseBus } from './command-bus';
import {
  logger,
  validator,
  history,
  authGuard,
  createChannel,
} from './plugins';
import { pace } from './pace';
import { bindCommands } from './command-binding';
import { bindDisplay } from './page-bindings';
import { defineChamberStore, saveTo, shareTabs } from './store/core';
import { httpTransport, wsTransport, createSseBridge } from './transports';
import { createApp, connect, type CreateAppOptions } from './iife-app';
import { createBuffer } from './buffer';
import {
  defineVaporCustomElement,
  defineVaporComponent,
  defineVaporAsyncComponent,
  defineVaporCommand,
  useVaporAsyncCommand,
  createVaporChamberApp,
  getVaporInteropPlugin,
} from './chamber-vapor';
import { useSharedCommandState, useCommand, configureVue } from './chamber';
import { commandState } from './command-state';
import { Accepted } from './accepted';
import { defineWidget, emitDOMEvent } from './widget';
import { DEV } from './dev';
import { _report } from './report';

// ---------------------------------------------------------------------------
// mount - mount a command-bus-driven island to a DOM element
// ---------------------------------------------------------------------------

/** A store definition, what `defineChamberStore(id, options)` returns: mount reads only `$dispose` of its store. */
type StoreDefinition = (bus: BaseBus) => { $dispose: () => void };

export type MountOptions<D extends Record<string, StoreDefinition> = Record<string, StoreDefinition>> = CreateAppOptions & {
  /** The island's stores, `{ name: defineChamberStore(id, options) }`, each created on the island's bus. */
  stores?: D;
};

/**
 * mount - an island on one element: its own bus, its stores on that bus, and
 * the element's `data-vc-command` and display attributes bound to both
 * (`bindCommands`, `bindDisplay`). The stores come back under their names.
 * `unmount()` unbinds the element and disposes the stores. A selector that
 * matches nothing binds nothing and warns in development.
 * tests/iife-mount.test.ts.
 *
 * @example
 * VaporChamber.mount('#analytics-island', {
 *   transport: VaporChamber.httpTransport({ endpoint: '/api/vc' }),
 *   stores: { analytics: VaporChamber.defineChamberStore('analytics', { state, reducers }) }
 * })
 */
function mount<D extends Record<string, StoreDefinition> = {}>(selector: string, options: MountOptions<D> = {}): {
  bus: ReturnType<typeof createAsyncCommandBus>;
  dispatch: ReturnType<typeof createAsyncCommandBus>['dispatch'];
  stores: { [K in keyof D]: ReturnType<D[K]> };
  el: Element | null;
  unmount: () => void;
} {
  const el = typeof document !== 'undefined' ? document.querySelector(selector) : null;
  const { stores: defined = {} as D, ...appOptions } = options;
  const app = createApp(appOptions);
  const names = Object.keys(defined) as (keyof D)[];
  const stores = {} as { [K in keyof D]: ReturnType<D[K]> };
  // The stores exist before the element binds: bindDisplay reads them at bind time.
  for (const name of names) stores[name] = defined[name](app.bus) as ReturnType<D[keyof D]>;
  const unbind = el === null ? [] : [bindCommands(el, app), bindDisplay(el, app)];
  if (DEV && el === null) _report('warn', 'mount:missing:element', `mount("${selector}"): no element matches, so the island's stores are created and nothing is bound.`, undefined, { selector });
  return {
    ...app,
    stores,
    el,
    unmount: () => {
      for (const u of unbind) u();
      for (const name of names) stores[name].$dispose();
    },
  };
}

// ---------------------------------------------------------------------------
// Global VaporChamber namespace
// ---------------------------------------------------------------------------

const VaporChamber = {
  // --- Core factories ---
  createCommandBus,
  createAsyncCommandBus,
  createBuffer,

  // --- Convenience ---
  createApp,
  connect,
  mount,
  defineWidget,
  emitDOMEvent,

  // --- Transport shortcuts ---
  httpTransport,
  wsTransport,
  /** Server-sent events bridge. Alias for createSseBridge(). */
  sse: createSseBridge,

  // --- Plugins ---
  logger,
  validator,
  history,
  authGuard,
  createChannel,
  // Pacing at the sender
  pace,
  // The command binding on plain HTML: [data-vc-command]
  bindCommands,
  bindDisplay,

  // --- State ---
  /** The core store: `persist: saveTo({ key })` saves it, `share: shareTabs()` shares it across tabs, `$onField` follows a field. */
  defineChamberStore,
  saveTo,
  shareTabs,
  /** What is in flight on a bus and what failed: `pending(action, target?)`, `anyPending`, `errors`, `subscribe(fn)`. */
  commandState,
  /** A reply whose work goes on: `r.value instanceof Accepted`, `done` settles at the end. */
  Accepted,

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
  /**
   * Hand Vue's namespace to the library - the only channel that works on a
   * `<script>`-tag page, since Vapor ships as `esm-browser` only and the
   * runtime probe cannot resolve a bare specifier in a browser. See the same
   * export in the ELEMENTS variant for the full note; it was missing from both,
   * so `vueDetectionHint()`'s "Pass it: configureVue(Vue)" - printed on every
   * wrapper's null path and deliberately un-gated for exactly this audience -
   * could not be followed. Pinned by `tests/iife-bundle.test.ts`.
   */
  configureVue,
} as const;

// Assign to globalThis so it's accessible as window.VaporChamber in browsers
(globalThis as any).VaporChamber = VaporChamber;

// Default export only: the IIFE build assigns the DEFAULT export to the
// `VaporChamber` global, so the API object lands directly on window
// (`VaporChamber.connect(...)`). A second named export would force the
// bundler to emit a module-namespace wrapper - `{ VaporChamber, default }`
// - and every documented call site would be undefined in a <script> tag.
export default VaporChamber;
