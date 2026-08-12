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

  it('ignores __VUE__ === true — Vue\'s own marker, written when an app mounts', async () => {
    // Not a hypothetical: Vue assigns `target.__VUE__ = true` from prepareApp()
    // (Vapor) and baseCreateRenderer() (vDOM). Measured against the real build
    // in tests/vue-detection-global-clobber.test.ts. Any page that has mounted
    // presents this shape, which is why the sync channel needed a second slot.
    vi.stubGlobal('__VUE__', true);
    vi.resetModules();
    const chamber = await import('../src/chamber');
    expect(chamber.getVaporAppFn()).toBeNull();
    expect(chamber.isVaporAvailable()).toBe(false);
  });
});

describe('the library-owned detection slot', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('reads __VAPOR_CHAMBER_VUE__ at module load', async () => {
    vi.stubGlobal('__VAPOR_CHAMBER_VUE__', mockVue);
    vi.resetModules();
    const chamber = await import('../src/chamber');

    expect(chamber.isVaporAvailable()).toBe(true);
    expect(chamber.getVaporAppFn()).toBe(mockVue.createVaporApp);
  });

  it('survives the case that breaks __VUE__: Vue\'s marker already written', async () => {
    // The exact ordering that used to lose detection outright — an app has
    // mounted (so __VUE__ is `true`), and the library is only imported after
    // that (a code-split chunk, a late island, an MPA page). The owned slot
    // still holds the namespace, so detection succeeds.
    vi.stubGlobal('__VUE__', true);
    vi.stubGlobal('__VAPOR_CHAMBER_VUE__', mockVue);
    vi.resetModules();
    const chamber = await import('../src/chamber');

    expect(chamber.isVaporAvailable()).toBe(true);
    expect(chamber.getVaporAppFn()).toBe(mockVue.createVaporApp);
  });
});

describe('configureVue', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('wires the Vapor surface with no globals involved at all', async () => {
    vi.resetModules();
    const chamber = await import('../src/chamber');
    // Nothing on either slot: this is the no-bundler page where the sync
    // channel finds nothing and the async bare-specifier import cannot resolve.
    expect(chamber.getVaporAppFn()).toBeNull();

    chamber.configureVue(mockVue);

    expect(chamber.isVaporAvailable()).toBe(true);
    expect(chamber.getVaporAppFn()).toBe(mockVue.createVaporApp);
    expect(chamber.getDefineVaporComponentFn()).toBe(mockVue.defineVaporComponent);
  });

  it('is safe to call with a falsy value and does not clear prior detection', async () => {
    vi.stubGlobal('__VAPOR_CHAMBER_VUE__', mockVue);
    vi.resetModules();
    const chamber = await import('../src/chamber');
    expect(chamber.getVaporAppFn()).toBe(mockVue.createVaporApp);

    chamber.configureVue(undefined as unknown as object);

    expect(chamber.getVaporAppFn()).toBe(mockVue.createVaporApp);
  });

  it('names the reachable-but-invisible case in its failure hint', async () => {
    vi.stubGlobal('__VUE__', true);
    vi.resetModules();
    const chamber = await import('../src/chamber');

    // Distinguishing "no Vue" from "Vue is here and I cannot see it" is the
    // whole point — they have different one-line fixes.
    expect(chamber.vueDetectionHint()).toMatch(/unreachable/);
    expect(chamber.vueDetectionHint()).toMatch(/configureVue\(/);
  });
});
