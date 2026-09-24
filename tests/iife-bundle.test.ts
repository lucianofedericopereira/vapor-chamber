/**
 * IIFE bundle smoke test - locks the audience-based variant contract.
 *
 * Variants reflect deployment shapes (sprinkled JS / widget / kitchen-sink),
 * not Vue feature axes. Drift = silent bloat or silent narrowing, both bad.
 *
 * Variant contents are not under semver before v2.0 - see ROADMAP.md.
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

/**
 * Load a variant exactly the way a <script> tag does: whatever ends up on the
 * global IS the API. No unwrapping - an earlier version of this helper fell
 * back through `outer.default ?? outer.VaporChamber ?? outer`, which happily
 * passed while the shipped global was really `{ VaporChamber, default }` and
 * every documented call site (`VaporChamber.connect(...)`) threw
 * "is not a function" in the browser.
 */
function loadNamespace(file: string): Record<string, unknown> {
  const src = readFileSync(dist(file), 'utf8');
  const sandbox: any = {};
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  const ns = sandbox.VaporChamber;
  if (!ns) throw new Error(`${file} did not expose VaporChamber`);
  return ns as Record<string, unknown>;
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

describe.skipIf(!haveAll)('IIFE variants - audience-based contracts', () => {
  // ---------------------------------------------------------------------
  // The global shape itself, before any per-variant contract: a <script>
  // user calls VaporChamber.connect(), not VaporChamber.VaporChamber.connect
  // and not VaporChamber.default.connect.
  // ---------------------------------------------------------------------
  describe.each(Object.entries(variants))('%s: global shape', (_name, file) => {
    it('puts the API directly on window.VaporChamber, never nested', () => {
      const ns = loadNamespace(file);
      expect(typeof ns.createCommandBus).toBe('function');
      expect(typeof ns.connect).toBe('function');
      expect(ns.VaporChamber).toBeUndefined(); // no self-nesting
      expect(ns.default).toBeUndefined(); // no module-namespace wrapper
    });
  });

  // -------------------------------------------------------------------------
  // CORE - sprinkled JS (Blade / Rails / Django). Bus + HTTP + light plugins.
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
        'persist', 'createChannel', 'history', 'optimistic',
        'mount',
        'defineVaporCustomElement', 'defineWidget',
        'defineVaporComponent', 'defineVaporAsyncComponent',
        'useCommand', 'useVaporAsyncCommand',
      ]);
    });
  });

  // -------------------------------------------------------------------------
  // ELEMENTS - embeddable widgets. Core + custom-element surface.
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
        'persist', 'createChannel', 'history', 'optimistic',
        'mount',
        'defineVaporComponent', 'defineVaporAsyncComponent',
        'useCommand', 'useVaporAsyncCommand',
      ]);
    });
  });

  // -------------------------------------------------------------------------
  // FULL - kitchen sink for SPAs that grew big.
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
        'authGuard', 'optimistic', 'retry', 'persist', 'createChannel',
        // widget surface
        'defineVaporCustomElement', 'defineWidget', 'emitDOMEvent',
        // full Vapor surface
        'defineVaporComponent', 'defineVaporAsyncComponent',
        'defineVaporCommand', 'useCommand', 'useVaporAsyncCommand',
        'createVaporChamberApp',
      ]);
    });
  });

  // -------------------------------------------------------------------------
  // The escape hatch has to be reachable by the audience that needs it.
  //
  // A variant that ships a Vapor wrapper ships its failure path too: the
  // wrapper returns `null` when Vapor is undetected and `vueDetectionHint()`
  // says "Pass it: configureVue(Vue)." That hint is deliberately NOT dev-gated,
  // precisely because the audience most likely to hit it is the no-bundler
  // <script>-tag page - which only ever runs a production IIFE.
  //
  // It was unreachable there. `configureVue` was on no variant's namespace, so
  // the one remedy the library prints for that audience threw
  // "VaporChamber.configureVue is not a function" - found by actually loading
  // the elements bundle in a browser, not by reading it.
  //
  // And on that page it is the ONLY channel: Vue publishes Vapor as
  // `esm-browser` only (there is no `vue.runtime-with-vapor.global.js`), and the
  // runtime probe's bare `import('vue')` cannot resolve in a browser.
  // -------------------------------------------------------------------------
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

  // -------------------------------------------------------------------------
  // Size monotonicity - guards against accidental bloat.
  // -------------------------------------------------------------------------
  it('size order is core ≤ elements ≤ full', () => {
    const sz = (k: keyof typeof variants) => statSync(dist(variants[k])).size;
    expect(sz('core')).toBeLessThanOrEqual(sz('elements'));
    expect(sz('elements')).toBeLessThanOrEqual(sz('full'));
  });
});
