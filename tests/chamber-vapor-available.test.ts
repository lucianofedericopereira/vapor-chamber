/**
 * Covers src/chamber-vapor.ts's SUCCESS paths — createVaporChamberApp's return
 * (not just its throw) and defineVaporCustomElement's extraOptions ternary.
 *
 * tests/chamber-vapor.test.ts exercises the "Vapor not available" throw path
 * exclusively. That's not a timing gap to await past: Node's plain
 * `import('vue')` does not expose createVaporApp / defineVaporCustomElement /
 * vaporInteropPlugin as main-entry exports at all in this environment (only a
 * bundler-resolved build does) — confirmed directly, `waitForVueDetection()`
 * changes nothing. tests/vue-global-detection.test.ts already established the
 * fix for exactly this: stub `globalThis.__VUE__` with a mock Vue object
 * before chamber.ts's module-load probe runs, so its SYNCHRONOUS `__VUE__`
 * branch (not the async ESM import) wires up the Vapor surface. This file
 * follows the same pattern to reach chamber-vapor.ts's success paths.
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
  createVaporApp: vi.fn((rootComponent: object, rootProps?: object) => ({
    mount: vi.fn(),
    rootComponent,
    rootProps,
  })),
  vaporInteropPlugin: { __isInterop: true },
  defineVaporCustomElement: vi.fn((options: object, extraOptions?: object) => ({
    __isCustomElement: true,
    options,
    extraOptions,
  })),
  defineVaporComponent: vi.fn((o: any) => o),
  defineVaporAsyncComponent: vi.fn((l: any) => l),
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function freshChamberVapor() {
  vi.stubGlobal('__VUE__', mockVue);
  vi.resetModules();
  return import('../src/chamber-vapor');
}

describe('createVaporChamberApp — Vapor available', () => {
  it('returns the app instance from Vue\'s createVaporApp(), not a throw', async () => {
    const { createVaporChamberApp } = await freshChamberVapor();
    const rootComponent = { setup() { return () => null; } };
    const app = createVaporChamberApp(rootComponent) as any;

    expect(mockVue.createVaporApp).toHaveBeenCalledWith(rootComponent, undefined);
    expect(app.mount).toBeTypeOf('function');
  });

  it('forwards rootProps through to createVaporApp', async () => {
    const { createVaporChamberApp } = await freshChamberVapor();
    const rootComponent = { props: { msg: String } };
    createVaporChamberApp(rootComponent, { msg: 'hi' });

    expect(mockVue.createVaporApp).toHaveBeenCalledWith(rootComponent, { msg: 'hi' });
  });
});

describe('defineVaporCustomElement — Vapor available', () => {
  const options = { props: {}, setup() { return () => null; } };

  it('calls fn(options) — no extraOptions branch', async () => {
    const { defineVaporCustomElement } = await freshChamberVapor();
    const El = defineVaporCustomElement(options) as any;

    expect(El).not.toBeNull();
    expect(mockVue.defineVaporCustomElement).toHaveBeenCalledWith(options);
    expect(El.extraOptions).toBeUndefined();
  });

  it('calls fn(options, extraOptions) — extraOptions branch', async () => {
    const { defineVaporCustomElement } = await freshChamberVapor();
    const extra = { shadowRoot: false };
    const El = defineVaporCustomElement(options, extra) as any;

    expect(El).not.toBeNull();
    expect(mockVue.defineVaporCustomElement).toHaveBeenCalledWith(options, extra);
  });
});
