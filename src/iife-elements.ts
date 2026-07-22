/**
 * vapor-chamber — IIFE variant: ELEMENTS
 *
 * Audience: widget builders. Embeddable chat bubbles, checkout buttons,
 * support pop-ups, third-party drop-ins. You ship a `<script>` tag and a
 * custom element tag (`<vc-widget>`); the host page mounts it without a
 * build pipeline.
 *
 * Surface:
 *   • Everything in CORE (bus + HTTP + light plugins + connect/createApp)
 *   • defineVaporCustomElement — the headline API
 *   • defineWidget() — one-line custom-element registration helper
 *
 * NOT in this variant (use `vapor-chamber.iife.js` if you need them):
 *   • WebSocket / SSE — most widgets poll or use server-side push to HTTP
 *   • persist / sync / history / optimistic — stateful plugins; widgets
 *     usually keep state in their own custom-element instance
 *   • Vapor sync/async composables — these target SFC-based apps, not
 *     custom-element widgets
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
import { defineVaporCustomElement } from './chamber-vapor';
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

function connect(options: HttpBridgeOptions & { plugins?: Plugin[]; onMissing?: CommandBusOptions['onMissing'] }) {
  const { plugins, onMissing, ...httpOptions } = options;
  return createApp({
    transport: createHttpBridge({ csrf: true, ...httpOptions }),
    plugins,
    onMissing,
  });
}

/**
 * defineWidget — one-line custom-element registration for embeddable widgets.
 *
 * Wraps `defineVaporCustomElement(options)` + `customElements.define(tag, ...)`.
 * No-ops gracefully if Vue 3.6+ Vapor is not detected on the page (returns
 * `false`); inspect the return value to fall back to a non-Vapor renderer.
 *
 * ## Naming convention — use the `vc-` prefix
 *
 * Recommended: prefix every vapor-chamber widget tag with `vc-`.
 *
 *   `<vc-title/>`, `<vc-cart/>`, `<vc-search/>`, `<vc-counter/>`
 *
 * Reasons it's the right convention here:
 *
 *   • Reads cleanly in server-rendered HTML next to Blade / Twig / ERB
 *     components — a Laravel dev sees `<vc-cart/>` in a `.blade.php` file
 *     and immediately recognizes it as a vapor-chamber widget, not a
 *     framework directive.
 *   • Avoids collisions with host-page elements when the widget is
 *     embedded into a third-party site.
 *   • Searchable: `grep -r "<vc-"` finds every widget instance in one shot.
 *   • Short — two characters of overhead.
 *
 * The HTML spec requires custom-element names contain a hyphen;
 * `customElements.define()` enforces that. `vc-` satisfies it.
 *
 * If your project already has a brand prefix (`<acme-cart/>`,
 * `<myapp-checkout/>`), keep yours — the brand convention wins. The
 * `vc-` recommendation is for projects without an existing convention.
 *
 * @example
 * <script src=".../vapor-chamber-elements.iife.min.js"></script>
 * <script>
 *   VaporChamber.defineWidget('vc-cart', {
 *     props: { sku: String },
 *     setup(props) { return () => h('span', `SKU ${props.sku}`); }
 *   });
 * </script>
 * <vc-cart sku="ABC-123"></vc-cart>
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
 * Emit a real DOM `CustomEvent` from inside a widget so host pages can
 * subscribe with `addEventListener`.
 *
 * Vue's component `emit(...)` goes through Vue's event system — it does
 * NOT bubble out as a DOM event. For widgets that need to communicate with
 * the surrounding page (a `<vc-cart>` notifying its container that
 * a product was added), use this to dispatch an actual `CustomEvent`.
 *
 * Pattern adapted from
 * [vue-custom-element](https://github.com/karol-f/vue-custom-element)'s
 * `customEmit` helper (Karol-F, MIT) — original predates Vue 3.6's Vapor
 * but the underlying gap (Vue emit ≠ DOM event) still exists today.
 *
 * @example Widget side
 * VaporChamber.defineWidget('vc-cart', {
 *   setup() {
 *     return () => h('button', {
 *       onClick: (e) => emitDOMEvent(e.target.getRootNode().host, 'cart-added', { sku: 'X' })
 *     }, 'Add');
 *   }
 * });
 *
 * @example Host page
 * document.querySelector('vc-cart').addEventListener('cart-added', (e) => {
 *   console.log(e.detail.sku);   // 'X'
 * });
 *
 * @param el — the custom element instance (host element)
 * @param eventName — DOM event name (kebab-case is conventional for custom events)
 * @param detail — payload attached to event.detail
 * @param options — bubbles/composed/cancelable. Defaults: bubbles=true, composed=true
 *                  (composed=true escapes shadow-DOM boundaries by default — required
 *                  for events to reach light-DOM listeners on the host page).
 * @returns `false` if `event.preventDefault()` was called by a listener, `true` otherwise.
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

const VaporChamber = {
  // Bus
  createCommandBus,
  createAsyncCommandBus,
  // Convenience
  createApp,
  connect,
  // Transport (HTTP only)
  http: createHttpBridge,
  // Plugins (lightweight)
  logger,
  validator,
  debounce,
  throttle,
  authGuard,
  retry,
  // Widget surface (the variant's identity)
  defineVaporCustomElement,
  defineWidget,
  emitDOMEvent,
} as const;

if (typeof globalThis !== 'undefined') {
  (globalThis as any).VaporChamber = VaporChamber;
}

// Default export only: the IIFE build assigns the DEFAULT export to the
// `VaporChamber` global, so the API object lands directly on window
// (`VaporChamber.connect(...)`). A second named export would force the
// bundler to emit a module-namespace wrapper — `{ VaporChamber, default }`
// — and every documented call site would be undefined in a <script> tag.
export default VaporChamber;
