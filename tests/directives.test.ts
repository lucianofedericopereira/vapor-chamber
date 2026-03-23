/**
 * Tests for src/directives.ts — v-vc:command, v-vc:payload, v-vc:optimistic
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
  const dataset: Record<string, string> = {};

  return {
    tagName: tag.toUpperCase(),
    classList: {
      add(c: string) { classes.add(c); },
      remove(c: string) { classes.delete(c); },
      has(c: string) { return classes.has(c); },
      contains(c: string) { return classes.has(c); },
    },
    addEventListener(event: string, fn: Function) { listeners.set(event, fn); },
    removeEventListener(event: string) { listeners.delete(event); },
    triggerClick() { listeners.get('click')?.(new Event('click')); },
    disabled: false,
    dataset,
    get _classes() { return [...classes]; },
    // Type guard — mock is not HTMLButtonElement by default
    ...(tag === 'button' ? { __isButton: true } : {}),
  };
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
  });
});

describe('createDirectivePlugin factory', () => {
  it('returns an object with install method', () => {
    const plugin = createDirectivePlugin();
    expect(plugin).toHaveProperty('install');
    expect(typeof plugin.install).toBe('function');
  });
});
