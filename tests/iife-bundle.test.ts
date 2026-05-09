/**
 * IIFE bundle smoke test — locks the audience-based variant contract.
 *
 * Variants reflect deployment shapes (sprinkled JS / widget / kitchen-sink),
 * not Vue feature axes. Drift = silent bloat or silent narrowing, both bad.
 *
 * Variant contents are not under semver before v2.0 — see ROADMAP.md.
 *
 * Skips automatically when dist/ hasn't been built.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';

const dist = (f: string) => resolve(process.cwd(), 'dist', f);

const variants = {
  full:     'vapor-chamber.iife.js',
  core:     'vapor-chamber-core.iife.js',
  elements: 'vapor-chamber-elements.iife.js',
};

const haveAll = Object.values(variants).every(f => existsSync(dist(f)));

function loadNamespace(file: string): Record<string, unknown> {
  const src = readFileSync(dist(file), 'utf8');
  const sandbox: any = {};
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  const outer = sandbox.VaporChamber;
  if (!outer) throw new Error(`${file} did not expose VaporChamber`);
  return (outer.default ?? outer.VaporChamber ?? outer) as Record<string, unknown>;
}

// Helper: assert a list of names are functions / undefined on the namespace.
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

describe.skipIf(!haveAll)('IIFE variants — audience-based contracts', () => {
  // -------------------------------------------------------------------------
  // CORE — sprinkled JS (Blade / Rails / Django). Bus + HTTP + light plugins.
  // -------------------------------------------------------------------------
  describe('core: dispatch over HTTP for sprinkled-JS sites', () => {
    it('exposes bus, createApp, connect, http transport, light plugins', () => {
      const ns = loadNamespace(variants.core);
      assertPresent(ns, [
        'createCommandBus', 'createAsyncCommandBus',
        'createApp', 'connect',
        'http',
        'logger', 'validator', 'debounce', 'throttle', 'authGuard', 'retry',
      ]);
    });

    it('does NOT expose realtime transports, heavy plugins, mount, Vapor APIs', () => {
      const ns = loadNamespace(variants.core);
      assertAbsent(ns, [
        'ws', 'sse',
        'persist', 'sync', 'history', 'optimistic',
        'mount',
        'defineVaporCustomElement', 'defineWidget',
        'defineVaporComponent', 'defineVaporAsyncComponent',
        'useVaporCommand', 'useVaporAsyncCommand',
      ]);
    });
  });

  // -------------------------------------------------------------------------
  // ELEMENTS — embeddable widgets. Core + custom-element surface.
  // -------------------------------------------------------------------------
  describe('elements: embeddable widgets via custom elements', () => {
    it('exposes everything CORE does, plus defineVaporCustomElement + defineWidget + emitDOMEvent', () => {
      const ns = loadNamespace(variants.elements);
      assertPresent(ns, [
        'createCommandBus', 'createAsyncCommandBus',
        'createApp', 'connect',
        'http',
        'logger', 'validator', 'debounce', 'throttle', 'authGuard', 'retry',
        'defineVaporCustomElement', 'defineWidget', 'emitDOMEvent',
      ]);
    });

    it('does NOT expose realtime transports, heavy plugins, full Vapor surface', () => {
      const ns = loadNamespace(variants.elements);
      assertAbsent(ns, [
        'ws', 'sse',
        'persist', 'sync', 'history', 'optimistic',
        'mount',
        'defineVaporComponent', 'defineVaporAsyncComponent',
        'useVaporCommand', 'useVaporAsyncCommand',
      ]);
    });
  });

  // -------------------------------------------------------------------------
  // FULL — kitchen sink for SPAs that grew big.
  // -------------------------------------------------------------------------
  describe('full: kitchen sink for SPAs', () => {
    it('exposes the union of all variants plus realtime transports + heavy plugins + Vapor', () => {
      const ns = loadNamespace(variants.full);
      assertPresent(ns, [
        // bus + convenience
        'createCommandBus', 'createAsyncCommandBus',
        'createApp', 'connect', 'mount',
        // transports
        'http', 'ws', 'sse',
        // all plugins
        'logger', 'validator', 'history', 'debounce', 'throttle',
        'authGuard', 'optimistic', 'retry', 'persist', 'sync',
        // widget surface
        'defineVaporCustomElement', 'defineWidget', 'emitDOMEvent',
        // full Vapor surface
        'defineVaporComponent', 'defineVaporAsyncComponent',
        'defineVaporCommand', 'useVaporCommand', 'useVaporAsyncCommand',
        'createVaporChamberApp',
      ]);
    });
  });

  // -------------------------------------------------------------------------
  // Size monotonicity — guards against accidental bloat.
  // -------------------------------------------------------------------------
  it('size order is core ≤ elements ≤ full', () => {
    const sz = (k: keyof typeof variants) => statSync(dist(variants[k])).size;
    expect(sz('core')).toBeLessThanOrEqual(sz('elements'));
    expect(sz('elements')).toBeLessThanOrEqual(sz('full'));
  });
});
