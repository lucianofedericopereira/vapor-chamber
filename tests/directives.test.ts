/**
 * Tests for src/directives.ts — v-vc:command, v-vc:payload, v-vc:optimistic
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createDirectivePlugin } from '../src/directives';
import { createCommandBus } from '../src/command-bus';
import { setCommandBus, resetCommandBus } from '../src/chamber';

// Stub HTMLButtonElement for Node environment (vitest runs in node, not jsdom)
if (typeof globalThis.HTMLButtonElement === 'undefined') {
  (globalThis as any).HTMLButtonElement = class HTMLButtonElement {};
}

// Minimal mock Vue app with directive registration
function createMockApp() {
  const directives = new Map<string, any>();
  return {
    directive(name: string, def: any) {
      directives.set(name, def);
    },
    getDirective(name: string) {
      return directives.get(name);
    },
  };
}

// Minimal mock document — stands in for the real `document` the .delegate
// modifier registers a shared listener on (tests/directives.test.ts runs in
// the plain 'node' vitest environment, no real DOM/happy-dom).
function createMockDocument() {
  const listeners = new Map<string, Function>();
  return {
    addEventListener(type: string, fn: Function) { listeners.set(type, fn); },
    removeEventListener(type: string) { listeners.delete(type); },
    // Simulate the browser invoking the delegated listener after an event
    // bubbled all the way to document.
    dispatchClick(target: any, evt?: any) {
      listeners.get('click')?.(evt ?? { type: 'click', target, stopPropagation() {}, preventDefault() {} });
    },
    hasClickListener() { return listeners.has('click'); },
  };
}

// Minimal mock element
function createElement(tag = 'button', opts: { parent?: any; ownerDocument?: any } = {}): any {
  const classes = new Set<string>();
  const listeners = new Map<string, Function>();
  const listenerOpts = new Map<string, any>();
  const dataset: Record<string, string> = {};

  const self: any = {
    tagName: tag.toUpperCase(),
    classList: {
      add(c: string) { classes.add(c); },
      remove(c: string) { classes.delete(c); },
      has(c: string) { return classes.has(c); },
      contains(c: string) { return classes.has(c); },
    },
    addEventListener(event: string, fn: Function, opts?: any) {
      listeners.set(event, fn);
      if (opts !== undefined) listenerOpts.set(event, opts);
    },
    removeEventListener(event: string) { listeners.delete(event); },
    // Fire the click handler. Pass a custom (duck-typed) event to exercise
    // modifiers; defaults to a self-targeted plain event.
    triggerClick(evt?: any) {
      listeners.get('click')?.(evt ?? { type: 'click', target: self, stopPropagation() {}, preventDefault() {} });
    },
    hasClick() { return listeners.has('click'); },
    disabled: false,
    dataset,
    parentElement: opts.parent ?? null,
    ownerDocument: opts.ownerDocument,
    get _classes() { return [...classes]; },
    get _listenerOpts() { return listenerOpts.get('click'); },
    // Type guard — mock is not HTMLButtonElement by default
    ...(tag === 'button' ? { __isButton: true } : {}),
  };
  return self;
}

describe('createDirectivePlugin', () => {
  let bus: ReturnType<typeof createCommandBus>;
  let app: ReturnType<typeof createMockApp>;

  beforeEach(() => {
    bus = createCommandBus({ onMissing: 'ignore' });
    setCommandBus(bus as any);
    app = createMockApp();
    const plugin = createDirectivePlugin();
    plugin.install(app);
  });

  afterEach(() => {
    resetCommandBus();
  });

  it('installs vc, vc-payload, and vc-optimistic directives', () => {
    expect(app.getDirective('vc')).toBeDefined();
    expect(app.getDirective('vc-payload')).toBeDefined();
    expect(app.getDirective('vc-optimistic')).toBeDefined();
  });

  describe('v-vc:command', () => {
    it('registers click handler on mounted', () => {
      const el = createElement();
      const vcDir = app.getDirective('vc');
      vcDir.mounted(el, { arg: 'command', value: 'testAction', modifiers: {} });

      // Should have registered a click listener
      bus.register('testAction', () => 'success');
      el.triggerClick();
      // No error means handler was attached
    });

    it('ignores non-command args', () => {
      const el = createElement();
      const vcDir = app.getDirective('vc');
      // Should not throw for other args
      vcDir.mounted(el, { arg: 'other', value: 'test', modifiers: {} });
    });

    it('updated() changes the action', () => {
      const el = createElement();
      const vcDir = app.getDirective('vc');
      vcDir.mounted(el, { arg: 'command', value: 'action1', modifiers: {} });
      vcDir.updated(el, { arg: 'command', value: 'action2' });
      // Should not throw
    });

    it('beforeUnmount() removes click handler', () => {
      const el = createElement();
      const vcDir = app.getDirective('vc');
      vcDir.mounted(el, { arg: 'command', value: 'test', modifiers: {} });
      vcDir.beforeUnmount(el, { arg: 'command' });
      // After unmount, triggering click should do nothing
    });

    // Vue 3.6.0-beta.15 alignment: skip disabled / in-flight direct handlers.
    it('skips dispatch when the element is disabled', () => {
      const el = createElement();
      el.disabled = true;
      let calls = 0;
      bus.register('disabledAction', () => { calls += 1; });
      const vcDir = app.getDirective('vc');
      vcDir.mounted(el, { arg: 'command', value: 'disabledAction', modifiers: {} });
      el.triggerClick();
      expect(calls).toBe(0);
    });

    it('skips dispatch when aria-disabled is set', () => {
      const el = createElement();
      el.getAttribute = (name: string) => (name === 'aria-disabled' ? 'true' : null);
      let calls = 0;
      bus.register('ariaAction', () => { calls += 1; });
      const vcDir = app.getDirective('vc');
      vcDir.mounted(el, { arg: 'command', value: 'ariaAction', modifiers: {} });
      el.triggerClick();
      expect(calls).toBe(0);
    });

    // Event modifiers — the direct listener never sees Vue's compiled withModifiers,
    // so v-vc:command applies .stop/.prevent/.self/.left/.middle/.right/.capture/
    // .once/.passive itself (the numeric modifier remains the dispatch timeout).
    describe('event modifiers', () => {
      it('honors .stop and .prevent on the DOM event', () => {
        const el = createElement();
        let calls = 0, stopped = 0, prevented = 0;
        bus.register('mAction', () => { calls += 1; });
        const vcDir = app.getDirective('vc');
        vcDir.mounted(el, { arg: 'command', value: 'mAction', modifiers: { stop: true, prevent: true } });
        el.triggerClick({ type: 'click', target: el, stopPropagation() { stopped += 1; }, preventDefault() { prevented += 1; } });
        expect(stopped).toBe(1);
        expect(prevented).toBe(1);
        expect(calls).toBe(1);
      });

      it('honors .self — only dispatches when the event targets the bound element', () => {
        const el = createElement();
        let calls = 0;
        bus.register('selfAction', () => { calls += 1; });
        const vcDir = app.getDirective('vc');
        vcDir.mounted(el, { arg: 'command', value: 'selfAction', modifiers: { self: true } });
        // target is a different element → ignored
        el.triggerClick({ type: 'click', target: {}, stopPropagation() {}, preventDefault() {} });
        expect(calls).toBe(0);
        // target is the bound element → dispatched
        el.triggerClick({ type: 'click', target: el, stopPropagation() {}, preventDefault() {} });
        expect(calls).toBe(1);
      });

      it('honors mouse-button modifiers (.left / .right)', () => {
        const el = createElement();
        let calls = 0;
        bus.register('btnAction', () => { calls += 1; });
        const vcDir = app.getDirective('vc');
        vcDir.mounted(el, { arg: 'command', value: 'btnAction', modifiers: { left: true } });
        // right button (2) → ignored
        el.triggerClick({ type: 'click', target: el, button: 2, stopPropagation() {}, preventDefault() {} });
        expect(calls).toBe(0);
        // left button (0) → dispatched
        el.triggerClick({ type: 'click', target: el, button: 0, stopPropagation() {}, preventDefault() {} });
        expect(calls).toBe(1);
      });

      it('passes .capture / .once / .passive as addEventListener options', () => {
        const el = createElement();
        const vcDir = app.getDirective('vc');
        vcDir.mounted(el, { arg: 'command', value: 'optAction', modifiers: { capture: true, once: true, passive: true } });
        expect(el._listenerOpts).toEqual({ capture: true, once: true, passive: true });
      });

      it('still reads the numeric .timeout modifier alongside event modifiers', () => {
        const el = createElement();
        let calls = 0;
        bus.register('tAction', () => { calls += 1; });
        const vcDir = app.getDirective('vc');
        // numeric modifier (timeout) + a real event modifier must coexist
        vcDir.mounted(el, { arg: 'command', value: 'tAction', modifiers: { '5000': true, stop: true } });
        el.triggerClick({ type: 'click', target: el, stopPropagation() {}, preventDefault() {} });
        expect(calls).toBe(1);
      });
    });

    // Vue 3.6.0-rc.2 (#15127) flipped compiler-vapor event delegation to
    // opt-in. v-vc:command mirrors the same trade-off with its own opt-in
    // `.delegate` modifier: one shared document listener instead of one per
    // element.
    describe('.delegate modifier', () => {
      // The delegation registry (attach/detach refcount) is shared MODULE
      // state, same as it would be in a real page with one `document` — each
      // test below mounts and unmounts in balance so it doesn't leak into
      // the next test.

      it('does not attach a direct listener on the element', () => {
        const doc = createMockDocument();
        const el = createElement('button', { ownerDocument: doc });
        const vcDir = app.getDirective('vc');
        vcDir.mounted(el, { arg: 'command', value: 'a', modifiers: { delegate: true } });
        expect(el.hasClick()).toBe(false);
        expect(doc.hasClickListener()).toBe(true);
        vcDir.beforeUnmount(el, { arg: 'command' });
      });

      it('dispatches via the shared document listener', () => {
        const doc = createMockDocument();
        const el = createElement('button', { ownerDocument: doc });
        let calls = 0;
        bus.register('a', () => { calls += 1; });
        const vcDir = app.getDirective('vc');
        vcDir.mounted(el, { arg: 'command', value: 'a', modifiers: { delegate: true } });
        doc.dispatchClick(el);
        expect(calls).toBe(1);
        vcDir.beforeUnmount(el, { arg: 'command' });
      });

      it('walks up to the closest delegated ancestor of the click target', () => {
        const doc = createMockDocument();
        const button = createElement('button', { ownerDocument: doc });
        const icon = createElement('span', { parent: button, ownerDocument: doc });
        let calls = 0;
        bus.register('a', () => { calls += 1; });
        const vcDir = app.getDirective('vc');
        vcDir.mounted(button, { arg: 'command', value: 'a', modifiers: { delegate: true } });
        // Click lands on the inner <span>, not the delegated <button> itself.
        doc.dispatchClick(icon);
        expect(calls).toBe(1);
        vcDir.beforeUnmount(button, { arg: 'command' });
      });

      it('shares one document listener across many delegated elements', () => {
        const doc = createMockDocument();
        const vcDir = app.getDirective('vc');
        const els = Array.from({ length: 5 }, () => createElement('button', { ownerDocument: doc }));
        for (const el of els) {
          vcDir.mounted(el, { arg: 'command', value: 'a', modifiers: { delegate: true } });
        }
        expect(doc.hasClickListener()).toBe(true);
        // Unmount all but one — listener must stay attached.
        for (const el of els.slice(0, -1)) {
          vcDir.beforeUnmount(el, { arg: 'command' });
        }
        expect(doc.hasClickListener()).toBe(true);
        // Unmount the last one — listener is removed.
        vcDir.beforeUnmount(els[els.length - 1], { arg: 'command' });
        expect(doc.hasClickListener()).toBe(false);
      });

      // Item 29: at document level the event target is retargeted to the
      // shadow HOST, so a parentElement walk from it never reaches the real
      // element and the click silently did nothing. `router/dom.ts` link
      // interception already documents the composed-path fix.
      it('dispatches for a delegated element inside a shadow root', () => {
        const doc = createMockDocument();
        const host = createElement('my-widget', { ownerDocument: doc });
        const button = createElement('button', { ownerDocument: doc }); // lives in the shadow root
        let calls = 0;
        bus.register('a', () => { calls += 1; });
        const vcDir = app.getDirective('vc');
        vcDir.mounted(button, { arg: 'command', value: 'a', modifiers: { delegate: true } });

        // What the browser actually delivers at document level: target is the
        // host, but composedPath() still carries the inner element.
        doc.dispatchClick(host, {
          type: 'click',
          target: host,
          composedPath: () => [button, host, doc],
          stopPropagation() {},
          preventDefault() {},
        });

        expect(calls).toBe(1); // was 0 — the control rendered and did nothing
        vcDir.beforeUnmount(button, { arg: 'command' });
      });

      it('does not fire for a delegated element outside the event path', () => {
        const doc = createMockDocument();
        const unrelated = createElement('button', { ownerDocument: doc });
        const clicked = createElement('div', { ownerDocument: doc });
        let calls = 0;
        bus.register('a', () => { calls += 1; });
        const vcDir = app.getDirective('vc');
        vcDir.mounted(unrelated, { arg: 'command', value: 'a', modifiers: { delegate: true } });

        doc.dispatchClick(clicked, {
          type: 'click',
          target: clicked,
          composedPath: () => [clicked, doc],
          stopPropagation() {},
          preventDefault() {},
        });

        expect(calls).toBe(0);
        vcDir.beforeUnmount(unrelated, { arg: 'command' });
      });

      it('attaches a listener per document (iframe / popup)', () => {
        // The count was global and the document single, so delegated elements
        // in a second document bumped the count and got no listener at all.
        const docA = createMockDocument();
        const docB = createMockDocument();
        const elA = createElement('button', { ownerDocument: docA });
        const elB = createElement('button', { ownerDocument: docB });
        let calls = 0;
        bus.register('a', () => { calls += 1; });
        const vcDir = app.getDirective('vc');

        vcDir.mounted(elA, { arg: 'command', value: 'a', modifiers: { delegate: true } });
        vcDir.mounted(elB, { arg: 'command', value: 'a', modifiers: { delegate: true } });

        expect(docA.hasClickListener()).toBe(true);
        expect(docB.hasClickListener()).toBe(true); // was false

        docB.dispatchClick(elB);
        expect(calls).toBe(1); // was 0

        // Unmounting every element of the first document must not strand the
        // second document's listener.
        vcDir.beforeUnmount(elA, { arg: 'command' });
        expect(docA.hasClickListener()).toBe(false);
        expect(docB.hasClickListener()).toBe(true);

        docB.dispatchClick(elB);
        expect(calls).toBe(2);

        vcDir.beforeUnmount(elB, { arg: 'command' });
        expect(docB.hasClickListener()).toBe(false);
      });

      it('falls back to a direct listener with a warning when combined with .capture/.once/.passive', () => {
        const doc = createMockDocument();
        const el = createElement('button', { ownerDocument: doc });
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const vcDir = app.getDirective('vc');
        vcDir.mounted(el, { arg: 'command', value: 'a', modifiers: { delegate: true, once: true } });
        expect(el.hasClick()).toBe(true);
        expect(doc.hasClickListener()).toBe(false);
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('.delegate is incompatible'));
        warnSpy.mockRestore();
      });

      it('beforeUnmount on a non-delegated element does not touch the document listener', () => {
        const doc = createMockDocument();
        const el = createElement('button', { ownerDocument: doc });
        const vcDir = app.getDirective('vc');
        vcDir.mounted(el, { arg: 'command', value: 'a', modifiers: {} });
        vcDir.beforeUnmount(el, { arg: 'command' });
        expect(doc.hasClickListener()).toBe(false);
      });
    });
  });
});

describe('createDirectivePlugin factory', () => {
  it('returns an object with install method', () => {
    const plugin = createDirectivePlugin();
    expect(plugin).toHaveProperty('install');
    expect(typeof plugin.install).toBe('function');
  });
});
