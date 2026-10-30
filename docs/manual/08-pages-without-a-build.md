# 8. Pages without a build

This chapter puts the bus on a server-rendered page with a `<script>` tag: Blade, Rails, Django,
WordPress, or a static page. No npm and no bundler.

## Pick a variant

Three `<script>`-tag drop-ins. Pick by audience, not by feature checklist. Each targets
browsers from 2022 on (Chrome 100, Firefox 100, Safari 16), with `?.`, `??` and class fields
native. An older browser is not a target.[^iife-floor]

[^iife-floor]: The floor was raised in v1.25.0. An IIFE from an earlier release runs on Chrome 80, Firefox 75 and Safari 13.

| Variant | Audience | Min | Brotli |
|---|---|--:|--:|
| **core** | Sprinkled JS on server-rendered pages (Blade, Rails, Django, WordPress). You dispatch user actions to a backend over HTTP. | <!-- vc:sizeIifeCoreRaw -->69.3<!-- /vc:sizeIifeCoreRaw --> KB | <!-- vc:sizeIifeCore -->21.7<!-- /vc:sizeIifeCore --> KB |
| **elements** | Embeddable widgets (chat bubbles, checkout buttons, third-party drop-ins). You ship a `<vc-widget>` custom element. | <!-- vc:sizeIifeElementsRaw -->71.7<!-- /vc:sizeIifeElementsRaw --> KB | <!-- vc:sizeIifeElements -->22.4<!-- /vc:sizeIifeElements --> KB |
| **full** | SPAs that grew big enough to want everything (realtime, undo/redo, persistence, full Vapor surface). | <!-- vc:sizeIifeFullRaw -->95.8<!-- /vc:sizeIifeFullRaw --> KB | <!-- vc:sizeIifeFull -->29.8<!-- /vc:sizeIifeFull --> KB |

## Drop a variant into a page

| Surface | core | elements | full |
|---|:--:|:--:|:--:|
| Bus (`createCommandBus`, `createAsyncCommandBus`) | yes | yes | yes |
| `createApp()`, `connect()` one-liner | yes | yes | yes |
| HTTP transport (`httpTransport`) | yes | yes | yes |
| Light plugins (logger, validator, authGuard) and `pace()` | yes | yes | yes |
| `bindCommands()`: `[data-vc-command]` on plain HTML | yes | yes | yes |
| `bindDisplay()`: `data-vc-text`, `-show`, `-each`, `-pending` | yes | yes | yes |
| The core store (`defineChamberStore`) and `commandState`, what the display bindings read | yes | yes | yes |
| `defineVaporCustomElement`, `defineWidget(tag, component, { when })`, `emitDOMEvent()` | - | yes | yes |
| WebSocket / SSE (`wsTransport`, `sse`) | - | - | yes |
| The store's `persist: saveTo()` and `share: shareTabs()`, heavy plugins (history) and `createChannel` | - | - | yes |
| `mount()` | - | - | yes |
| Full Vapor (`defineVaporComponent`, async/Suspense) | - | - | yes |

```html
<!-- core: a button and a search box that dispatch, busy and error styled by vc-loading / vc-error -->
<button data-vc-command="cartAdd" data-vc-target='{"id":42}'>Add</button>
<input data-vc-command="searchQuery" data-vc-debounce="300">
<span data-vc-text="cart.count">0</span> <span data-vc-pending="cartAdd" data-vc-target='{"id":42}'>saving</span>
<script src=".../vapor-chamber-core.iife.min.js"></script>
<script>
  const { bus } = VaporChamber.connect({ endpoint: '/api/vc' });
  VaporChamber.defineChamberStore('cart', { state: () => ({ count: 0 }), reducers: { set: (s, t, count) => ({ count }) } })(bus);
  VaporChamber.bindCommands(document.body, { bus });
  VaporChamber.bindDisplay(document.body, { bus });
</script>

<!-- core: dispatch over HTTP, CSRF auto-wired -->
<script src=".../vapor-chamber-core.iife.min.js"></script>
<script>
  const { dispatch } = VaporChamber.connect({ endpoint: '/api/vc' });
  document.getElementById('add')
    .addEventListener('click', () => dispatch('cartAdd', { id: 42 }));
</script>
```

```html
<!-- elements: register a custom-element widget in one call -->
<script src=".../vapor-chamber-elements.iife.min.js"></script>
<script type="module">
  // Needed: without Vue's Vapor build handed over, defineWidget returns false.
  const Vue = await import('.../vue.runtime-with-vapor.esm-browser.prod.js');
  VaporChamber.configureVue(Vue);
  VaporChamber.defineWidget('vc-cart', {
    props: { sku: String },
    // A Vapor setup() returns a BLOCK - real DOM nodes. There is no compiler
    // on a no-build page to turn a template into one, and `h` is not on the
    // VaporChamber global in any variant, so build the node directly.
    setup(props) {
      const span = document.createElement('span');
      span.textContent = `SKU ${props.sku}`;
      return span;
    },
  });
</script>
<vc-cart sku="ABC-123"></vc-cart>
```

> **Variant contents are not under semver before v2.0.** While Vue 3.6 is in RC, the library may
> move APIs between IIFE variants. ESM consumers get the full surface and are unaffected.

## Hand Vue to the library on a page with no bundler

Vue ships Vapor as a separate build, `vue.runtime-with-vapor.esm-browser.js`. Load that file
and hand it over with `configureVue()`:

```html
<script type="module">
  import * as Vue from 'https://cdn.jsdelivr.net/npm/vue@3.6/dist/vue.runtime-with-vapor.esm-browser.prod.js';
  import { configureVue } from 'https://cdn.jsdelivr.net/npm/vapor-chamber@<version>/dist/index.js';
  configureVue(Vue);
</script>
```

For the IIFE shape, assign the namespace to `window.__VAPOR_CHAMBER_VUE__` before the
library's tag, and use the full or the elements variant (the core one has no Vue surface).

- Load one Vue build per page. Two Vue dist files are two disconnected reactivity engines, and the
  failure is silent.
- On such a page `untracked()` cannot suspend tracking.
- The reasons, and the three detection failures, are in the whitepaper's
  [section 9.6](../whitepaper.md#96-blade--cdn-zero-build).

## Mount an island in a panel

`VaporChamber.mount(selector, { stores })`, in the **full** variant, gives an island its own bus
and creates its stores on it. It binds the element's `data-vc-command` and display attributes,
and `unmount()` releases both. A Filament example is in the whitepaper, section 9.8, and in
[`examples/pattern-5-filament.ts`](../../examples/pattern-5-filament.ts).

Next: [9. Server rendering](./09-ssr.md).
