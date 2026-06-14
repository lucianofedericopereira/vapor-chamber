import { defineVaporCustomElement } from 'vue';
import './style.css';

// The component shape defineVaporCustomElement accepts — keeps the glob typed
// without falling back to `any` (the .vue default export satisfies it).
type VaporComponent = Parameters<typeof defineVaporCustomElement>[0];

const glob = import.meta.glob<{ default: VaporComponent }>('./islands/*.vue');

// Build tag → loader map from the glob keys: './islands/Products.vue' → 'vc-products'
const loaders: Record<string, () => Promise<{ default: VaporComponent }>> = {};
for (const path in glob) {
  // PascalCase → kebab-case: ProductCard → product-card
  const pascal = path.match(/\/(\w+)\.vue$/)![1];
  const kebab  = pascal.replace(/([A-Z])/g, (_, c, i) => (i ? '-' : '') + c.toLowerCase());
  loaders[`vc-${kebab}`] = glob[path];
}

async function hydrate(el: Element): Promise<void> {
  const tag = el.tagName.toLowerCase();
  if (customElements.get(tag) || !loaders[tag]) return;
  const mod = await loaders[tag]();
  if (!customElements.get(tag)) {
    customElements.define(tag, defineVaporCustomElement(mod.default, { shadowRoot: false }));
  }
}

// client:load — hydrate immediately on script parse
document.querySelectorAll('[client\\:load]').forEach(el => hydrate(el));

// client:visible — hydrate when element enters the viewport
const io = new IntersectionObserver((entries, obs) => {
  for (const { isIntersecting, target } of entries) {
    if (isIntersecting) { obs.unobserve(target); hydrate(target); }
  }
});
document.querySelectorAll('[client\\:visible]').forEach(el => io.observe(el));

// client:idle — hydrate during browser idle time
const whenIdle: (cb: () => void) => void =
  window.requestIdleCallback?.bind(window) ?? ((cb) => setTimeout(cb, 1));
document.querySelectorAll('[client\\:idle]').forEach(el => whenIdle(() => hydrate(el)));
