/**
 * vapor-chamber - widgets: a Vapor custom element registered by tag, when the
 * page needs it, and a DOM event that reaches the host page.
 *
 * One module for the elements and full IIFEs and the ESM root. Astro keeps
 * its own `client:*`; this is the same three strategies for a page without it.
 */

import { getDefineVaporCustomElementFn } from './chamber';
import { _report } from './report';
import { defineVaporCustomElement } from './chamber-vapor';

/** When a widget's tag is defined: now, when its first element shows, or when the browser is idle. */
export type WidgetWhen = 'load' | 'visible' | 'idle';

/** `when`, plus the options `defineVaporCustomElement` takes (`shadowRoot`, `nonce`, `configureApp`). */
export type WidgetOptions = { when?: WidgetWhen } & Record<string, unknown>;

/** A component, or a loader of one (`() => import('./Cart.vue')`), so `visible` and `idle` defer its code. */
export type WidgetComponent = object | (() => Promise<{ default: object } | object>);

/** The one observer every `visible` widget shares, made by the first, and what each watched element defines. */
let observer: IntersectionObserver | null = null;
const onVisible = new Map<Element, () => void>();

function watch(elements: Element[], define: () => void): void {
  if (observer === null) {
    observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        onVisible.get(entry.target)?.();
      }
    });
  }
  const once = (): void => {
    for (const el of elements) {
      observer?.unobserve(el);
      onVisible.delete(el);
    }
    define();
  };
  for (const el of elements) {
    onVisible.set(el, once);
    observer.observe(el);
  }
}

const idle = (fn: () => void): void => {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(fn);
  else setTimeout(fn, 1);
};

/**
 * defineWidget - register a Vapor custom element by tag, in one line.
 *
 * `when` picks the moment (default `load`): `load` defines it now; `visible`
 * when the first element of that tag on the page enters the viewport (one
 * IntersectionObserver for every widget; with none on the page, now);
 * `idle` in `requestIdleCallback` (a 1 ms timer where it is missing). A
 * component given as a loader is imported at that moment. The other options
 * go to `defineVaporCustomElement`. Returns `false`, and defines nothing,
 * when Vue 3.6 Vapor is not detected; `true` once the tag is defined or
 * will be.
 *
 * ## Naming convention - use the `vc-` prefix
 *
 * `<vc-cart/>` reads as a vapor-chamber widget in Blade or Twig, avoids
 * clashing with a host page's elements, and `grep -r "<vc-"` finds every one.
 * The HTML spec needs a hyphen in a custom element's name; `vc-` gives it. A
 * project with its own brand prefix (`<acme-cart/>`) keeps it.
 *
 * ## What `setup()` returns
 *
 * A Vapor component returns a BLOCK - real DOM nodes - not a vnode. On a page
 * with no build step there is no compiler to turn a template into one, so
 * build the nodes directly: `h()` is not on the `VaporChamber` global in any
 * variant, and it produces a vnode, the vDOM shape Vapor replaced. Pinned by
 * `tests/vapor/widget-shape.test.ts`, which mounts a real widget.
 *
 * ## A function set on a property
 *
 * `el.onSave = fn` hands `setup(props)` the function itself, from Vue
 * 3.6.0-rc.10. Pinned by the same file.
 *
 * @example
 * <script src=".../vapor-chamber-elements.iife.min.js"></script>
 * <script type="module">
 *   // Vue ships Vapor as esm-browser only, so a classic page loads it as a
 *   // module and hands it over; without it defineWidget returns false.
 *   const Vue = await import('https://.../vue.runtime-with-vapor.esm-browser.prod.js');
 *   VaporChamber.configureVue(Vue);
 *   VaporChamber.defineWidget('vc-cart', {
 *     props: { sku: String },
 *     setup(props) {
 *       const span = document.createElement('span');
 *       span.textContent = `SKU ${props.sku}`;
 *       return span;
 *     }
 *   }, { when: 'visible' });
 * </script>
 * <vc-cart sku="ABC-123"></vc-cart>
 */
export function defineWidget(tagName: string, component: WidgetComponent, options?: WidgetOptions): boolean {
  if (typeof customElements === 'undefined') return false;
  if (getDefineVaporCustomElementFn() === null) {
    // Says why in development, as every Vapor wrapper does, and creates nothing.
    defineVaporCustomElement({});
    return false;
  }
  if (customElements.get(tagName)) return true;
  const { when = 'load', ...extra } = options ?? {};
  const elementOptions = Object.keys(extra).length > 0 ? extra : undefined;
  const register = (def: object): void => {
    if (customElements.get(tagName)) return;
    // Not null: Vapor was found above, and the wrapper answers null only without it.
    customElements.define(tagName, defineVaporCustomElement(def, elementOptions) as CustomElementConstructor);
  };
  const define = (): void => {
    if (typeof component !== 'function') {
      register(component);
      return;
    }
    (component as () => Promise<{ default: object } | object>)().then(
      (mod) => register((mod as { default?: object }).default ?? (mod as object)),
      (e) => { _report('error', 'widget:failed:load', `defineWidget("${tagName}"): the component failed to load`, e, { tag: tagName }); },
    );
  };
  if (when === 'visible' && typeof IntersectionObserver === 'function') {
    const elements = [...document.querySelectorAll(tagName)];
    if (elements.length > 0) {
      watch(elements, define);
      return true;
    }
  }
  if (when === 'idle') idle(define);
  else define();
  return true;
}

/**
 * Emit a real DOM `CustomEvent` from inside a widget so host pages can
 * subscribe with `addEventListener`.
 *
 * A custom element's own `emit(...)` reaches its host as a `CustomEvent`
 * that neither bubbles nor crosses a shadow root (rc.11, VueElementBase), so
 * a listener on the host hears it while `document`, `window` and the
 * containers around it do not. An `emit` from a component nested inside the
 * widget stays in Vue's event system. For widgets that need to reach the
 * surrounding page, this dispatches a bubbling, composed `CustomEvent`.
 *
 * Pattern adapted from
 * [vue-custom-element](https://github.com/karol-f/vue-custom-element)'s
 * `customEmit` helper (Karol-F, MIT), which predates Vue 3.6's Vapor.
 *
 * @example Widget side
 * button.addEventListener('click', (e) => {
 *   const host = e.target.getRootNode().host;   // escape the shadow root
 *   VaporChamber.emitDOMEvent(host, 'cart-added', { sku: 'X' });
 * });
 *
 * @example Host page
 * document.querySelector('vc-cart').addEventListener('cart-added', (e) => {
 *   console.log(e.detail.sku);   // 'X'
 * });
 *
 * @param el - the custom element instance (host element)
 * @param eventName - DOM event name (kebab-case is conventional for custom events)
 * @param detail - payload attached to event.detail
 * @param options - bubbles/composed/cancelable. Defaults: bubbles=true, composed=true
 *                  (composed=true escapes shadow-DOM boundaries by default - required
 *                  for events to reach light-DOM listeners on the host page).
 * @returns `false` if `event.preventDefault()` was called by a listener, `true` otherwise.
 */
export function emitDOMEvent(
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
