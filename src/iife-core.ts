/**
 * vapor-chamber - IIFE variant: CORE
 *
 * Audience: server-rendered apps with sprinkled JS - Blade, Rails, Django,
 * .NET MVC, WordPress. The page already returns HTML; you need a command bus
 * to dispatch user actions to the backend (cart add, form submit, analytics).
 *
 * Surface:
 *   - Command bus (sync + async)
 *   - HTTP transport only (httpTransport)
 *   - Lightweight plugins: logger, validator, authGuard
 *   - pace() - debounce or throttle a dispatch at the sender
 *   - bindCommands() - [data-vc-command] on plain HTML, the bus passed in
 *   - bindDisplay() - data-vc-text, -show, -each, -pending on a store and the command state
 *   - defineChamberStore (core) and commandState - what the display bindings read
 *   - createApp() for one-line setup
 *   - connect() - even shorter: HTTP + CSRF in a single call
 *
 * NOT in this variant (use `vapor-chamber.iife.js` if you need them):
 *   - WebSocket / SSE transports - realtime infra is a different deployment shape
 *   - createChannel / history, the store's persist and tab sync
 *   - mount() - DOM-coupled convenience
 *   - Vapor custom elements - see `vapor-chamber-elements.iife.js`
 *
 * Variant contents are not stable across major versions until v2.0; see ROADMAP.md.
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

const VaporChamber = {
  // Bus
  createCommandBus,
  createAsyncCommandBus,
  createBuffer,
  // Convenience
  createApp,
  connect,
  // Transport (HTTP only in core)
  httpTransport,
  // Plugins (lightweight only in core)
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
} as const;

(globalThis as any).VaporChamber = VaporChamber;

// Default export only: the IIFE build assigns the DEFAULT export to the
// `VaporChamber` global, so the API object lands directly on window
// (`VaporChamber.connect(...)`). A second named export would force the
// bundler to emit a module-namespace wrapper - `{ VaporChamber, default }`
// - and every documented call site would be undefined in a <script> tag.
export default VaporChamber;
