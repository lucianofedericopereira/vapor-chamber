/**
 * Covers the `globalThis.__VUE__` synchronous probe path in chamber.ts — the
 * MPA / script-tag scenario where Vue is a page global rather than an ESM import.
 * Exercises applyVueModule's full Vapor-surface detection (createVaporApp,
 * vaporInteropPlugin, defineVapor* ) which the real beta.14 ESM `vue` doesn't
 * expose as main exports, so it's otherwise unreachable in tests.
 *
 * Uses vi.resetModules() + a dynamic import so chamber's module-load probeVue()
 * re-runs with the global set. Assertions target the Vapor-API getters, whose
 * mock wiring persists even after the async ESM probe resolves (the real `vue`
 * lacks those functions, so applyVueModule never overwrites them).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

const mockVue = {
  ref: <T>(v: T) => ({ value: v }),
  shallowRef: <T>(v: T) => ({ value: v }),
  onScopeDispose: vi.fn(),
  getCurrentScope: vi.fn(() => ({})),
  getCurrentInstance: vi.fn(() => null),
  onActivated: vi.fn(),
  onDeactivated: vi.fn(),
  createVaporApp: vi.fn(() => ({ mount: vi.fn() })),
  vaporInteropPlugin: { __isInterop: true },
  defineVaporCustomElement: vi.fn(() => ({})),
  defineVaporComponent: vi.fn((o: any) => o),
  defineVaporAsyncComponent: vi.fn((l: any) => l),
};

describe('Vue-as-global (script-tag / MPA) sync probe', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('wires the full Vapor surface from globalThis.__VUE__ at module load', async () => {
    vi.stubGlobal('__VUE__', mockVue);
    vi.resetModules();
    const chamber = await import('../src/chamber');

    expect(chamber.isVaporAvailable()).toBe(true);
    expect(chamber.getVaporAppFn()).toBe(mockVue.createVaporApp);
    expect(chamber.getVaporInteropRef()).toBe(mockVue.vaporInteropPlugin);
    expect(chamber.getDefineVaporCustomElementFn()).toBe(mockVue.defineVaporCustomElement);
    expect(chamber.getDefineVaporComponentFn()).toBe(mockVue.defineVaporComponent);
    expect(chamber.getDefineVaporAsyncComponentFn()).toBe(mockVue.defineVaporAsyncComponent);
    expect(chamber.getVueDeepRefFn()).toBe(mockVue.ref);
  });

  it('ignores a __VUE__ global that lacks ref() (devtools-hook shape)', async () => {
    vi.stubGlobal('__VUE__', { someDevtoolsField: true }); // no .ref → sync probe is a no-op
    vi.resetModules();
    const chamber = await import('../src/chamber');
    // Vapor getters stay null from the sync path (the real async ESM probe may
    // still set ref-based things, but createVaporApp isn't a real main export).
    expect(chamber.getVaporAppFn()).toBeNull();
  });
});
