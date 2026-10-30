/**
 * src/chamber-vapor.ts with Vapor present: each wrapper forwards to Vue's own function and returns its result.
 * Why: coverage: Node's `import('vue')` lacks the Vapor exports, so only a `__VAPOR_CHAMBER_VUE__` stub set before the probe reaches these branches.
 * Shows: createVaporChamberApp returns Vue's app with rootProps; custom elements with and without extraOptions; components and both async forms pass through; production is silent.
 * See: tests/chamber-vapor.test.ts, tests/vue-global-detection.test.ts.
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
  vi.stubGlobal('__VAPOR_CHAMBER_VUE__', mockVue);
  vi.resetModules();
  return import('../src/chamber-vapor');
}

describe('createVaporChamberApp - Vapor available', () => {
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

describe('defineVaporCustomElement - Vapor available', () => {
  const options = { props: {}, setup() { return () => null; } };

  it('calls fn(options) - no extraOptions branch', async () => {
    const { defineVaporCustomElement } = await freshChamberVapor();
    const El = defineVaporCustomElement(options) as any;

    expect(El).not.toBeNull();
    expect(mockVue.defineVaporCustomElement).toHaveBeenCalledWith(options);
    expect(El.extraOptions).toBeUndefined();
  });

  it('calls fn(options, extraOptions) - extraOptions branch', async () => {
    const { defineVaporCustomElement } = await freshChamberVapor();
    const extra = { shadowRoot: false };
    const El = defineVaporCustomElement(options, extra) as any;

    expect(El).not.toBeNull();
    expect(mockVue.defineVaporCustomElement).toHaveBeenCalledWith(options, extra);
  });
});

// The forwarding half is the one a refactor could quietly break; the null half already warns in DEV.
describe('defineVaporComponent / defineVaporAsyncComponent - Vapor available', () => {
  it('defineVaporComponent forwards options to Vue and returns its result', async () => {
    const { defineVaporComponent } = await freshChamberVapor();
    const options = { props: { count: Number }, setup: () => () => null };
    const Comp = defineVaporComponent(options) as any;

    expect(Comp).not.toBeNull();
    expect(Comp).toBe(options); // mock is identity - proves pass-through, not re-wrapping
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
    // NODE_ENV is never 'production' in vitest, so force it: the warning goes, the null return must not.
    vi.stubEnv('NODE_ENV', 'production');
    vi.resetModules();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // No global stub, so Vapor is absent and all three take the null path.
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
    // Vue takes a loader or an options object; the object must reach Vue unchanged, not be called.
    const opts = { loader: () => Promise.resolve({ default: {} }), delay: 0 };
    const Async = defineVaporAsyncComponent(opts) as any;

    expect(Async).not.toBeNull();
    expect(mockVue.defineVaporAsyncComponent).toHaveBeenCalledWith(opts);
  });
});
