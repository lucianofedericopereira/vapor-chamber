/**
 * Vue detection in src/chamber.ts from a page global (`__VAPOR_CHAMBER_VUE__`) or `configureVue()`, with a mock Vue namespace.
 * Why: on a script-tag or MPA page Vue is a page global, not an ESM import; if the library read Vue's own `__VUE__` key, or lost the owned slot, Vapor would go undetected.
 * Shows: `__VUE__` (a namespace, a devtools-shaped object, or `true`) is never read for Vue; `__VAPOR_CHAMBER_VUE__` wires the full Vapor surface at module load, even beside `__VUE__ === true`; `configureVue()` wires it with no globals, ignores a falsy value and keeps prior detection; the failure hint names the unreachable case and `configureVue(`.
 * See: tests/vue-detection-global-clobber.test.ts, tests/vue-detection-real-ordering.test.ts
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

// A mock stands in for Vue: the `vue` Vitest resolves lacks the Vapor functions, so the async probe never overwrites the mock wiring.
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

  it('does not read a namespace on __VUE__: that key is Vue\'s', async () => {
    vi.stubGlobal('__VUE__', mockVue);
    vi.resetModules();
    const chamber = await import('../src/chamber');
    expect(chamber.getVaporAppFn()).not.toBe(mockVue.createVaporApp);
  });

  it('wires the full Vapor surface from globalThis.__VAPOR_CHAMBER_VUE__ at module load', async () => {
    vi.stubGlobal('__VAPOR_CHAMBER_VUE__', mockVue);
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
    vi.stubGlobal('__VUE__', { someDevtoolsField: true });
    vi.resetModules();
    const chamber = await import('../src/chamber');
    expect(chamber.getVaporAppFn()).toBeNull();
  });

  it('ignores __VUE__ === true - Vue\'s own marker, written when an app mounts', async () => {
    // Vue writes `true` there when an app mounts (tests/vue-detection-global-clobber.test.ts).
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

  it('survives the case that breaks __VUE__: Vue\'s marker already written', async () => {
    // An app has mounted (`__VUE__` is `true`) before the library is imported.
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
    // Nothing on either slot.
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

    expect(chamber.vueDetectionHint()).toMatch(/unreachable/);
    expect(chamber.vueDetectionHint()).toMatch(/configureVue\(/);
  });
});
