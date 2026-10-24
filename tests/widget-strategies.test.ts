// @vitest-environment happy-dom
// defineWidget's `when`: a real Vapor custom element defined now, when idle, when visible, or from a loader; rationale at the end.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { configureVue } from '../src/chamber';
import { defineWidget, emitDOMEvent } from '../src/widget';

// The with-Vapor build, as the default project's fixtures load it (tests/directive-empty-action.test.ts).
const WITH_VAPOR = 'vue/dist/vue.runtime-with-vapor.esm-browser.js';
let vapor: { defineVaporCustomElement: unknown };
beforeAll(async () => { vapor = await import(/* @vite-ignore */ WITH_VAPOR); });

const hosts: Element[] = [];
afterEach(() => {
  for (const h of hosts.splice(0)) h.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const counter = (label: string) => ({
  setup() {
    const span = document.createElement('span');
    span.textContent = label;
    return span;
  },
});

function place(html: string): Element {
  const box = document.createElement('div');
  box.innerHTML = html;
  document.body.append(box);
  hosts.push(box);
  return box.firstElementChild as Element;
}

describe('with no Vapor, or no custom elements', () => {
  it('answers false and defines nothing', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect([defineWidget('vc-ws-none', counter('x')), customElements.get('vc-ws-none')]).toEqual([false, undefined]);
    vi.stubGlobal('customElements', undefined);
    expect(defineWidget('vc-ws-none', counter('x'))).toBe(false);
  });
});

describe('defineWidget({ when })', () => {
  it('load (the default) defines the tag at once', () => {
    // An app on a page wires the custom-element runtime itself (src/vapor.ts's note).
    configureVue({ defineVaporCustomElement: vapor.defineVaporCustomElement });
    expect(defineWidget('vc-ws-load', counter('now'))).toBe(true);
    expect(customElements.get('vc-ws-load')).toBeDefined();
  });

  it('idle defines it once the browser is idle, not before', async () => {
    vi.useFakeTimers();
    expect(defineWidget('vc-ws-idle', counter('later'), { when: 'idle' })).toBe(true);
    const before = customElements.get('vc-ws-idle');
    await vi.advanceTimersByTimeAsync(5);
    expect({ before, after: customElements.get('vc-ws-idle') !== undefined }).toEqual({ before: undefined, after: true });
  });

  it('idle uses requestIdleCallback where the browser has it', () => {
    const queued: Array<() => void> = [];
    vi.stubGlobal('requestIdleCallback', (fn: () => void) => { queued.push(fn); return 1; });
    defineWidget('vc-ws-ric', counter('ric'), { when: 'idle' });
    const before = customElements.get('vc-ws-ric');
    for (const fn of queued) fn();
    expect({ before, after: customElements.get('vc-ws-ric') !== undefined }).toEqual({ before: undefined, after: true });
  });

  it('a loader is imported only when the tag is defined; a module with no default is the component', async () => {
    const loader = vi.fn(async () => ({ default: counter('loaded') }));
    vi.useFakeTimers();
    defineWidget('vc-ws-loader', loader, { when: 'idle' });
    const called = loader.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5);
    defineWidget('vc-ws-bare-module', async () => counter('bare'));
    await vi.advanceTimersByTimeAsync(1);
    expect({ called, after: loader.mock.calls.length, defined: customElements.get('vc-ws-loader') !== undefined, bare: customElements.get('vc-ws-bare-module') !== undefined })
      .toEqual({ called: 0, after: 1, defined: true, bare: true });
  });

  it('two loaders racing for one tag define it once', async () => {
    const define = vi.spyOn(customElements, 'define');
    defineWidget('vc-ws-race', async () => ({ default: counter('one') }));
    defineWidget('vc-ws-race', async () => ({ default: counter('two') }));
    await new Promise((r) => setTimeout(r, 0));
    expect(define.mock.calls.filter((c) => c[0] === 'vc-ws-race').length).toBe(1);
  });

  it('a loader that fails is reported and defines nothing', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    defineWidget('vc-ws-broken', async () => { throw new Error('404'); });
    await new Promise((r) => setTimeout(r, 0));
    expect({ defined: customElements.get('vc-ws-broken'), reported: error.mock.calls.length }).toEqual({ defined: undefined, reported: 1 });
  });

  it('visible with no element on the page defines at once', () => {
    defineWidget('vc-ws-absent', counter('x'), { when: 'visible' });
    expect(customElements.get('vc-ws-absent')).toBeDefined();
  });

  it('visible waits for an intersection, one observer for every widget', () => {
    const observers: Array<{ cb: (entries: Array<{ isIntersecting: boolean; target: Element }>) => void; watched: Element[] }> = [];
    vi.stubGlobal('IntersectionObserver', class {
      watched: Element[] = [];
      constructor(public cb: (entries: Array<{ isIntersecting: boolean; target: Element }>) => void) { observers.push(this); }
      observe(el: Element) { this.watched.push(el); }
      unobserve(el: Element) { this.watched = this.watched.filter((w) => w !== el); }
    });
    const a = place('<vc-ws-seen-a></vc-ws-seen-a>');
    const b = place('<vc-ws-seen-b></vc-ws-seen-b>');
    defineWidget('vc-ws-seen-a', counter('a'), { when: 'visible' });
    defineWidget('vc-ws-seen-b', counter('b'), { when: 'visible' });
    const io = observers[0];
    io.cb([{ isIntersecting: false, target: a }]);
    const notYet = customElements.get('vc-ws-seen-a');
    io.cb([{ isIntersecting: true, target: a }]);
    expect({ observers: observers.length, notYet, a: customElements.get('vc-ws-seen-a') !== undefined, b: customElements.get('vc-ws-seen-b'), watched: io.watched })
      .toEqual({ observers: 1, notYet: undefined, a: true, b: undefined, watched: [b] });
  });

  it('the other options reach defineVaporCustomElement: shadowRoot false renders in the light DOM', () => {
    defineWidget('vc-ws-light', counter('light'), { shadowRoot: false });
    const el = place('<vc-ws-light></vc-ws-light>');
    expect({ shadow: el.shadowRoot, text: el.textContent }).toEqual({ shadow: null, text: 'light' });
  });

  it('a tag already defined is left alone and answers true', () => {
    defineWidget('vc-ws-twice', counter('first'));
    const first = customElements.get('vc-ws-twice');
    expect([defineWidget('vc-ws-twice', counter('second')), customElements.get('vc-ws-twice') === first]).toEqual([true, true]);
  });

  it('emitDOMEvent reaches a listener on the document', () => {
    const el = place('<div></div>');
    const heard: unknown[] = [];
    const listen = (e: Event) => heard.push((e as CustomEvent).detail);
    document.addEventListener('cart-added', listen);
    emitDOMEvent(el, 'cart-added', { sku: 'X' });
    document.removeEventListener('cart-added', listen);
    expect(heard).toEqual([{ sku: 'X' }]);
  });
});

// Plan 1.32 4.5: `defineWidget(tag, component, { when })` with the three strategies
// vapor-island-cart wrote by hand (capacity C19), one module for the IIFEs and the root.
// The default `vue` entry carries the Vapor runtime (tests/vue-bundler-vapor-exports.test.ts),
// so this runs on Vue's own `defineVaporCustomElement`, handed over as an app does. `idle`
// uses `requestIdleCallback` where it exists, else a 1 ms timer. A loader is imported at
// the moment the strategy picks. The `visible` case here drives the observer's callback by
// hand to reach its branches; tests/browser/widget-visible.browser.test.ts shows a real
// IntersectionObserver in Chromium does the same.
