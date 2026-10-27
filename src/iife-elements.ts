/**
 * vapor-chamber - IIFE variant: ELEMENTS
 *
 * Audience: widget builders. Embeddable chat bubbles, checkout buttons,
 * support pop-ups, third-party drop-ins. You ship a `<script>` tag and a
 * custom element tag (`<vc-widget>`); the host page mounts it without a
 * build pipeline.
 *
 * Surface:
 *   - Everything in CORE (bus + HTTP + light plugins + pace + bindCommands + bindDisplay + connect/createApp)
 *   - defineVaporCustomElement - the headline API
 *   - defineWidget() - one-line custom-element registration helper
 *
 * NOT in this variant (use `vapor-chamber.iife.js` if you need them):
 *   - WebSocket / SSE - most widgets poll or use server-side push to HTTP
 *   - createChannel / history, the store's persist and tab sync
 *   - Vapor sync/async composables - these target SFC-based apps, not
 *     custom-element widgets
 *
 * Variant contents may change between major versions; see ROADMAP.md.
 */

import { createCommandBus, createAsyncCommandBus } from './command-bus';
import {
  logger,
  validator,
  authGuard,
} from './plugins';
import { httpTransport } from './transports';
import { pace } from './pace';
import { bindCommands } from './command-binding';
import { bindDisplay } from './page-bindings';
import { defineChamberStore } from './store/core';
import { commandState } from './command-state';
import { Accepted } from './accepted';
import { createApp, connect } from './iife-app';
import { createBuffer } from './buffer';
import { defineVaporCustomElement } from './chamber-vapor';
import { defineWidget, emitDOMEvent } from './widget';
import { configureVue } from './chamber';

const VaporChamber = {
  // Bus
  createCommandBus,
  createAsyncCommandBus,
  createBuffer,
  // Convenience
  createApp,
  connect,
  // Transport (HTTP only)
  httpTransport,
  // Plugins (lightweight)
  logger,
  validator,
  authGuard,
  // Pacing at the sender
  pace,
  // The command binding on plain HTML: [data-vc-command]
  bindCommands,
  bindDisplay,
  // What its display bindings read: a store (core, no Vue) and the command state
  defineChamberStore,
  commandState,
  // A reply whose work goes on: `r.value instanceof Accepted`
  Accepted,
  // Widget surface (the variant's identity)
  defineVaporCustomElement,
  defineWidget,
  emitDOMEvent,
  /**
   * Hand Vue's namespace to the library. Not optional on this variant's
   * audience: Vue ships Vapor as `esm-browser` ONLY (there is no
   * `vue.runtime-with-vapor.global.js`), so a classic `<script src>` page
   * cannot obtain Vapor, and the runtime probe's bare `import('vue')` cannot
   * resolve in a browser. A widget page therefore loads Vue as a module and
   * passes it here.
   *
   * `vueDetectionHint()`'s advice - printed on the wrapper's own null path,
   * deliberately un-gated so a production IIFE shows it - names this call, so
   * it must exist on the global. Pinned by `tests/iife-bundle.test.ts`.
   *
   *   <script type="module">
   *     const Vue = await import('https://.../vue.runtime-with-vapor.esm-browser.prod.js');
   *     VaporChamber.configureVue(Vue);
   *   </script>
   */
  configureVue,
} as const;

(globalThis as any).VaporChamber = VaporChamber;

// Default export only: the IIFE build assigns the DEFAULT export to the
// `VaporChamber` global, so the API object lands directly on window
// (`VaporChamber.connect(...)`). A second named export would force the
// bundler to emit a module-namespace wrapper - `{ VaporChamber, default }`
// - and every documented call site would be undefined in a <script> tag.
export default VaporChamber;
