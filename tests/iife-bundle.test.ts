/**
 * The built IIFE bundles (core, elements, full) and the API each puts on window.VaporChamber.
 * Why: a variant that gains or loses an export silently bloats or narrows what a script-tag page can call, and an API nested under the global would throw "is not a function" in the browser.
 * Shows: each bundle exposes its API directly on the global, the exact present and absent names per variant, configureVue only where a Vapor wrapper ships, and sizes ordered core <= elements <= full.
 * See: tests/require-dist.ts, ROADMAP.md.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { requireDist } from './require-dist';

const dist = (f: string) => resolve(process.cwd(), 'dist', f);

const variants = {
  full:     'vapor-chamber.iife.js',
  core:     'vapor-chamber-core.iife.js',
  elements: 'vapor-chamber-elements.iife.js',
};

requireDist(Object.values(variants).every(f => existsSync(dist(f))));

/** Loads a variant as a <script> tag does; the global is the API, so nothing is unwrapped. */
function loadNamespace(file: string): Record<string, unknown> {
  const src = readFileSync(dist(file), 'utf8');
  const sandbox: any = {};
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  const ns = sandbox.VaporChamber;
  if (!ns) throw new Error(`${file} did not expose VaporChamber`);
  return ns as Record<string, unknown>;
}

function assertPresent(ns: Record<string, unknown>, names: string[]) {
  for (const n of names) {
    expect(typeof ns[n], `expected ${n} to be a function on the namespace`).toBe('function');
  }
}
function assertAbsent(ns: Record<string, unknown>, names: string[]) {
  for (const n of names) {
    expect(ns[n], `expected ${n} to be absent from the namespace`).toBeUndefined();
  }
}

describe('IIFE variants - audience-based contracts', () => {
  describe.each(Object.entries(variants))('%s: global shape', (_name, file) => {
    it('puts the API directly on window.VaporChamber, never nested', () => {
      const ns = loadNamespace(file);
      expect(typeof ns.createCommandBus).toBe('function');
      expect(typeof ns.connect).toBe('function');
      expect(ns.VaporChamber).toBeUndefined();
      expect(ns.default).toBeUndefined();
    });
  });

  describe('core: dispatch over HTTP for sprinkled-JS sites', () => {
    it('exposes bus, createApp, connect, httpTransport, light plugins', () => {
      const ns = loadNamespace(variants.core);
      assertPresent(ns, [
        'createCommandBus', 'createAsyncCommandBus',
        'createApp', 'connect',
        'httpTransport',
        'logger', 'validator', 'authGuard', 'pace', 'bindCommands', 'bindDisplay',
        'defineChamberStore', 'commandState', 'Accepted',
      ]);
    });

    it('does NOT expose realtime transports, heavy plugins, mount, Vapor APIs', () => {
      const ns = loadNamespace(variants.core);
      assertAbsent(ns, [
        'wsTransport', 'sse',
        'saveTo', 'createChannel', 'history',
        'mount',
        'defineVaporCustomElement', 'defineWidget',
        'defineVaporComponent', 'defineVaporAsyncComponent',
        'useCommand', 'useVaporAsyncCommand',
      ]);
    });
  });

  describe('elements: embeddable widgets via custom elements', () => {
    it('exposes everything CORE does, plus defineVaporCustomElement + defineWidget + emitDOMEvent', () => {
      const ns = loadNamespace(variants.elements);
      assertPresent(ns, [
        'createCommandBus', 'createAsyncCommandBus',
        'createApp', 'connect',
        'httpTransport',
        'logger', 'validator', 'authGuard', 'pace', 'bindCommands', 'bindDisplay',
        'defineChamberStore', 'commandState', 'Accepted',
        'defineVaporCustomElement', 'defineWidget', 'emitDOMEvent',
      ]);
    });

    it('does NOT expose realtime transports, heavy plugins, full Vapor surface', () => {
      const ns = loadNamespace(variants.elements);
      assertAbsent(ns, [
        'wsTransport', 'sse',
        'saveTo', 'createChannel', 'history',
        'mount',
        'defineVaporComponent', 'defineVaporAsyncComponent',
        'useCommand', 'useVaporAsyncCommand',
      ]);
    });
  });

  describe('full: kitchen sink for SPAs', () => {
    it('exposes the union of all variants plus realtime transports + heavy plugins + Vapor', () => {
      const ns = loadNamespace(variants.full);
      assertPresent(ns, [
        'createCommandBus', 'createAsyncCommandBus',
        'createApp', 'connect', 'mount',
        'httpTransport', 'wsTransport', 'sse',
        'logger', 'validator', 'history',
        'authGuard', 'createChannel', 'pace', 'bindCommands', 'bindDisplay',
        'defineChamberStore', 'saveTo', 'Accepted',
        'defineVaporCustomElement', 'defineWidget', 'emitDOMEvent',
        'defineVaporComponent', 'defineVaporAsyncComponent',
        'defineVaporCommand', 'useCommand', 'useVaporAsyncCommand',
        'createVaporChamberApp',
      ]);
    });
  });

  // The Vapor hint "Pass it: configureVue(Vue)" is not dev-gated and a no-bundler page runs only a production IIFE, so configureVue must be on every variant that ships a Vapor wrapper.
  describe.each([
    ['elements', variants.elements],
    ['full', variants.full],
  ])('%s: the documented Vapor escape hatch is callable', (_name, file) => {
    it('exposes configureVue, which its own null path tells users to call', () => {
      const ns = loadNamespace(file);
      expect(typeof ns.defineVaporCustomElement).toBe('function');
      assertPresent(ns, ['configureVue']);
    });
  });

  it('core does NOT gain configureVue - it ships no Vapor wrapper to rescue', () => {
    assertAbsent(loadNamespace(variants.core), ['configureVue']);
  });

  it('size order is core ≤ elements ≤ full', () => {
    const sz = (k: keyof typeof variants) => statSync(dist(variants[k])).size;
    expect(sz('core')).toBeLessThanOrEqual(sz('elements'));
    expect(sz('elements')).toBeLessThanOrEqual(sz('full'));
  });
});
