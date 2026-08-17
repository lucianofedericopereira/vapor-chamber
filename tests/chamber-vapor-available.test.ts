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

// The remaining two wrappers had their "Vapor present" side stubbed in mockVue
// but never actually called, so only their null-return branch was reached —
// which is the half that cannot regress silently, since it now DEV-warns. The
// forwarding half is the half a refactor could quietly break.
describe('defineVaporComponent / defineVaporAsyncComponent — Vapor available', () => {
  it('defineVaporComponent forwards options to Vue and returns its result', async () => {
    const { defineVaporComponent } = await freshChamberVapor();
    const options = { props: { count: Number }, setup: () => () => null };
    const Comp = defineVaporComponent(options) as any;

    expect(Comp).not.toBeNull();
    expect(Comp).toBe(options); // mock is identity — proves pass-through, not re-wrapping
    expect(mockVue.defineVaporComponent).toHaveBeenCalledWith(options);
  });

  it('defineVaporAsyncComponent forwards a loader function', async () => {
    const { defineVaporAsyncComponent } = await freshChamberVapor();
    const loader = () => Promise.resolve({ default: {} });
    const Async = defineVaporAsyncComponent(loader) as any;

    expect(Async).not.toBeNull();
    expect(mockVue.defineVaporAsyncComponent).toHaveBeenCalledWith(loader);
  });

  it('the three wrappers are silent in production, and still return null', async () => {
    // The `if (DEV)` guard added around each devWarnNoVapor() has a false side
    // that vitest never takes on its own — NODE_ENV is not 'production' here,
    // so DEV is always true and the branch is dead in a normal run. Pin it the
    // way tests/dev-flag.test.ts pins DEV itself: force the runtime fallback to
    // false, then assert the warning is gone while the RETURN CONTRACT is not.
    // Silencing a warning must never change what the function gives back.
    vi.stubEnv('NODE_ENV', 'production');
    vi.resetModules();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // No __VUE__ stub here, so the Vapor surface is absent and all three take
      // the null path — the same path that warns in dev.
      const m = await import('../src/chamber-vapor');
      expect(m.defineVaporCustomElement({})).toBeNull();
      expect(m.defineVaporComponent({})).toBeNull();
      expect(m.defineVaporAsyncComponent(() => Promise.resolve({}))).toBeNull();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it('defineVaporAsyncComponent also accepts the options-object form', async () => {
    const { defineVaporAsyncComponent } = await freshChamberVapor();
    // Vue supports both `defineVaporAsyncComponent(loader)` and the
    // `{ loader, loadingComponent, ... }` object; our signature allows both, so
    // the object form should reach Vue unchanged rather than be treated as a fn.
    const opts = { loader: () => Promise.resolve({ default: {} }), delay: 0 };
    const Async = defineVaporAsyncComponent(opts) as any;

    expect(Async).not.toBeNull();
    expect(mockVue.defineVaporAsyncComponent).toHaveBeenCalledWith(opts);
  });
});
