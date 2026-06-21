/**
 * Tests for src/directives.ts — v-vc:command, v-vc:payload, v-vc:optimistic
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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

// Minimal mock element
function createElement(tag = 'button'): any {
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
  });
});

describe('createDirectivePlugin factory', () => {
  it('returns an object with install method', () => {
    const plugin = createDirectivePlugin();
    expect(plugin).toHaveProperty('install');
    expect(typeof plugin.install).toBe('function');
  });
});
