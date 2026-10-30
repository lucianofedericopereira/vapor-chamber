/**
 * The no-build widget shape (`defineWidget` + `emitDOMEvent` from the `elements` IIFE variant) mounted as custom elements, under the with-vapor `vue` alias.
 * Why: a page with no build step must be able to define a widget whose `setup()` returns DOM nodes (a Vapor block, not an `h()` vnode, and `h` is not on the global) and hear its events on the host, document and window.
 * Shows: `setup()` DOM output renders in the shadow root; `emitDOMEvent` reaches host, document and window listeners; Vue handed over only via `configureVue()` works; a function-valued property arrives uncalled; `emitDOMEvent(null, ...)` returns true.
 * See: docs/integrations/laravel.md, tests/vapor/vapor-subpath-wiring.test.ts
 */

import { afterEach, describe, expect, it } from 'vitest';

// Seeds the Vapor registry at module evaluation, so the `defineVaporCustomElement` behind `defineWidget` is not null.
import '../../src/vapor';
// The default export is the shipped surface: `defineWidget` and `emitDOMEvent` reach a `<script>`-tag page only through this object.
import VaporChamber from '../../src/iife-elements';

const { defineWidget, emitDOMEvent } = VaporChamber;

const hosts: Element[] = [];

afterEach(() => {
  for (const host of hosts.splice(0)) host.remove();
});

function mount(html: string): Element {
  const container = document.createElement('div');
  document.body.appendChild(container);
  hosts.push(container);
  container.innerHTML = html;
  return container.firstElementChild as Element;
}

describe('no-build widget shape', () => {
  it('setup() returns DOM nodes, not vnodes', () => {
    const defined = defineWidget('vc-fixture-plain', {
      setup() {
        const button = document.createElement('button');
        button.textContent = 'Add to cart';
        return button;
      },
    });
    expect(defined).toBe(true);

    const el = mount('<vc-fixture-plain></vc-fixture-plain>');
    expect(el.shadowRoot?.textContent).toContain('Add to cart');
  });

  it('emitDOMEvent carries a payload out of the shadow root to a host listener', () => {
    defineWidget('vc-fixture-emit', {
      setup() {
        const button = document.createElement('button');
        button.textContent = 'Add';
        button.addEventListener('click', (event) => {
          // The host element, reached as the docs show: the shadow root's `host`.
          const host = (event.target as Element).getRootNode() as ShadowRoot;
          emitDOMEvent(host.host, 'cart-added', { count: 1 });
        });
        return button;
      },
    });

    const el = mount('<vc-fixture-emit></vc-fixture-emit>');
    const seen: Array<{ count: number }> = [];
    el.addEventListener('cart-added', (event) => {
      seen.push((event as CustomEvent).detail);
    });

    const button = el.shadowRoot?.querySelector('button');
    expect(button).toBeTruthy();
    (button as HTMLButtonElement).click();

    expect(seen).toEqual([{ count: 1 }]);
  });

  // The host-framework patterns in docs/integrations/laravel.md listen above the element (Alpine's `.window`, Livewire's `#[On]`); none of those frameworks is in this repo, so the primitive is tested: a composed, bubbling CustomEvent reaching window.
  it('the event escapes the shadow root and reaches document and window', () => {
    defineWidget('vc-fixture-bubble', {
      setup() {
        const button = document.createElement('button');
        button.addEventListener('click', (event) => {
          const host = (event.target as Element).getRootNode() as ShadowRoot;
          emitDOMEvent(host.host, 'cart-added', { count: 2 });
        });
        return button;
      },
    });

    const el = mount('<vc-fixture-bubble></vc-fixture-bubble>');
    const atWindow: unknown[] = [];
    const atDocument: unknown[] = [];
    const onWindow = (e: Event) => atWindow.push((e as CustomEvent).detail);
    const onDocument = (e: Event) => atDocument.push((e as CustomEvent).detail);
    window.addEventListener('cart-added', onWindow);
    document.addEventListener('cart-added', onDocument);

    try {
      const button = el.shadowRoot?.querySelector('button');
      expect(button).toBeTruthy();
      (button as HTMLButtonElement).click();

      expect(atWindow).toEqual([{ count: 2 }]);
      expect(atDocument).toEqual([{ count: 2 }]);
    } finally {
      window.removeEventListener('cart-added', onWindow);
      document.removeEventListener('cart-added', onDocument);
    }
  });

  // The only channel a no-build page has: Vue ships Vapor as `esm-browser` only, so a `<script type="module">` hands it over with `configureVue()` (the call `vueDetectionHint()` names).
  it('a widget works when Vue arrives only through configureVue()', async () => {
    const { configureVue } = await import('../../src/chamber');
    const v = (await import('vue')) as unknown as Record<string, unknown>;

    configureVue(v);

    const defined = defineWidget('vc-fixture-configured', {
      setup() {
        const span = document.createElement('span');
        span.textContent = 'configured';
        return span;
      },
    });
    expect(defined).toBe(true);

    const el = mount('<vc-fixture-configured></vc-fixture-configured>');
    expect(el.shadowRoot?.textContent).toContain('configured');
  });

  // A function-valued property must not be treated as a prop getter (called, with its return value delivered).
  it('a function set on a widget property arrives as that function, uncalled', () => {
    let calls = 0;
    const onSave = () => {
      calls++;
      return 'returned';
    };
    let arrived: unknown;
    defineWidget('vc-fixture-fn-prop', {
      props: { onSave: Function },
      setup(props: { onSave: unknown }) {
        arrived = props.onSave;
        return document.createElement('span');
      },
    });

    const container = document.createElement('div');
    document.body.appendChild(container);
    hosts.push(container);
    const el = document.createElement('vc-fixture-fn-prop') as HTMLElement & { onSave: unknown };
    el.onSave = onSave;
    container.appendChild(el);

    expect(arrived).toBe(onSave);
    expect(calls).toBe(0);
  });

  it('emitDOMEvent is inert without a real CustomEvent, and never throws', () => {
    // The guard lets a widget call it on a server-rendered pass without taking the page down.
    expect(emitDOMEvent(null as unknown as Element, 'x')).toBe(true);
  });
});
