import { defineVaporCustomElement } from 'vue';
import { configureVue, defineWidget, type WidgetComponent, type WidgetWhen } from 'vapor-chamber/vue';
import './style.css';

// The custom-element runtime is wired by hand: no entry wires it by default
// (vapor-chamber/vapor's note: it pulls Vue's custom-element machinery).
configureVue({ defineVaporCustomElement });

const glob = import.meta.glob<{ default: object }>('./islands/*.vue');

// One widget per island file: './islands/ProductCard.vue' -> 'vc-product-card'.
// The tag's first element names when it hydrates (client:load, client:visible,
// client:idle), and the island's code is loaded at that moment.
for (const path in glob) {
  const pascal = path.match(/\/(\w+)\.vue$/)![1];
  const tag = `vc-${pascal.replace(/([A-Z])/g, (_, c, i) => (i ? '-' : '') + c.toLowerCase())}`;
  const first = document.querySelector(tag);
  if (first === null) continue;
  const when: WidgetWhen = first.hasAttribute('client:visible') ? 'visible' : first.hasAttribute('client:idle') ? 'idle' : 'load';
  defineWidget(tag, glob[path] as WidgetComponent, { when, shadowRoot: false });
}
