/**
 * FIXTURE - the no-build widget shape the docs actually tell people to write.
 *
 * `defineWidget` + `emitDOMEvent` are the identity of the `elements` IIFE
 * variant, and they are documented for a page with NO build step: a `<script>`
 * tag, a custom-element tag, done. Nothing tested that path, and the
 * documentation for it was wrong in a way only a mounted widget can catch -
 * every snippet (the Laravel guide's Alpine/Livewire/Filament patterns and the
 * `defineWidget` JSDoc itself) returned `h('button', ...)` from `setup()`.
 *
 * Two problems with that, both fatal on the page it is written for:
 *   1. `h` is not on the `VaporChamber` global in ANY IIFE variant - a reader
 *      copying the snippet gets `h is not defined`.
 *   2. `h()` builds a VNODE. A Vapor `setup()` returns a BLOCK - DOM nodes.
 *
 * So this pins what a build-less widget really returns, and that the DOM-event
 * bridge reaches a listener on the host. Runs under the aliased project because
 * `defineVaporCustomElement` needs a real with-vapor Vue to be anything but
 * `null`.
 */

import { afterEach, describe, expect, it } from 'vitest';

// Seeds the Vapor registry at module evaluation (see vapor-subpath-wiring),
// so the `defineVaporCustomElement` behind `defineWidget` is not null.
import '../../src/vapor';
// The default export IS the surface: `defineWidget` and `emitDOMEvent` are
// module-local in the IIFE entry and reach consumers only through this object,
// which is exactly how a `<script>`-tag page calls them. Importing it the same
// way is what keeps this fixture honest about the shipped surface.
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
          // The host element, reached the way the docs show: the shadow root's
          // `host`. `composed: true` (the default) is what lets it escape.
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

  // The hop every host-framework pattern in docs/integrations/laravel.md
  // actually depends on, and the one nothing verified. Alpine's
  // `@cart-added.window` binds on WINDOW, and Livewire/Filament's `#[On(...)]`
  // listens above the element too - so "reaches a listener on the host" is not
  // enough to make those patterns true. None of those frameworks is in this
  // repo (Alpine appears in prose only; the runnable Blade example uses plain
  // DOM), so what is testable is the primitive they all sit on: a composed,
  // bubbling CustomEvent leaving a shadow root and arriving at window.
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

  // The channel a NO-BUILD page has to use, and the only one it can.
  //
  // Vue ships Vapor as `esm-browser` only - there is no
  // `vue.runtime-with-vapor.global.js` - so a classic `<script src>` tag cannot
  // obtain Vapor at all, and the runtime probe cannot resolve a bare specifier
  // in a browser. That leaves exactly one route: a `<script type="module">`
  // importing the esm-browser dist and handing it over with `configureVue()`.
  // It is the channel `vueDetectionHint()` points at, and the one whose absence
  // produced two shipped prod-only bugs, so it gets its own assertion rather
  // than riding on the static-import path the tests above use.
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

  it('emitDOMEvent is inert without a real CustomEvent, and never throws', () => {
    // The IIFE guards this so a widget can call it on a server-rendered pass
    // or in a stripped environment without taking the page down.
    expect(emitDOMEvent(null as unknown as Element, 'x')).toBe(true);
  });
});
