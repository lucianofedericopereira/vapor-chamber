// @vitest-environment happy-dom
/**
 * Vue detection in a production bundle, where neither detection channel is available: the owned global slot is unprimed and a bare `import('vue')` does not resolve.
 * Why: a built page has no priming (`vaporChamberHMR` is `apply: 'serve'`) and a browser cannot resolve a bare specifier without an import map, so `createVaporChamberApp()` would throw "Vue 3.6+ with Vapor mode required" unless the app calls `configureVue()`. Vitest resolves `vue`, so the rejection must be arranged to reproduce a browser.
 * Shows: with no priming and an unresolvable `vue`, detection stays empty, `createVaporChamberApp({})` throws and the hint names `configureVue(`; after `configureVue()` with the with-vapor namespace Vapor is available synchronously and a real app mounts; when `vue` resolves to the with-vapor build detection succeeds only after waiting; the HMR plugin's `apply` is `'serve'`.
 * See: tests/vue-detection-real-ordering.test.ts, src/vite-hmr.ts
 */

import { describe, expect, it, vi, afterEach } from 'vitest';

const WITH_VAPOR = 'vue/dist/vue.runtime-with-vapor.esm-browser.js';

/** What a browser does with `import('vue')` inside a built bundle. */
function makeBareSpecifierUnresolvable(): void {
  vi.doMock('vue', () => {
    throw new Error(
      "Failed to resolve module specifier 'vue'. Relative references must start with either '/', './', or '../'.",
    );
  });
}

type VaporApi = {
  createVaporApp: (root: unknown) => { mount: (el: unknown) => void; unmount: () => void };
  defineVaporComponent: (c: unknown) => unknown;
  template: (html: string, root?: boolean) => () => Element;
};

describe('production bundle: both detection channels are absent', () => {
  afterEach(() => {
    vi.doUnmock('vue');
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('REGRESSION: no priming + unresolvable bare import -> createVaporChamberApp throws', async () => {
    // Sync channel: empty because `vaporChamberHMR` never ran.
    expect((globalThis as Record<string, unknown>).__VAPOR_CHAMBER_VUE__).toBeUndefined();

    makeBareSpecifierUnresolvable();
    vi.resetModules();

    const chamber = await import('../src/chamber');
    const vapor = await import('../src/chamber-vapor');

    // The rejection is swallowed by design (Vue is optional), so waiting completes and detection stays empty.
    await chamber.waitForVueDetection();
    expect(chamber.isVaporAvailable()).toBe(false);

    expect(() => vapor.createVaporChamberApp({})).toThrow(
      /Vue 3\.6\+ with Vapor mode required/,
    );
    expect(chamber.vueDetectionHint()).toMatch(/configureVue\(/);
  });

  it('FIXED by configureVue(): same bundle conditions, real with-vapor namespace', async () => {
    makeBareSpecifierUnresolvable();
    vi.resetModules();

    const chamber = await import('../src/chamber');
    const vapor = await import('../src/chamber-vapor');
    await chamber.waitForVueDetection();
    expect(chamber.isVaporAvailable()).toBe(false);

    // In an app this namespace arrives through the Vite alias, so it is the instance the compiled SFCs use.
    const vue = (await import(/* @vite-ignore */ WITH_VAPOR)) as unknown as VaporApi;
    chamber.configureVue(vue as unknown as object);

    expect(chamber.isVaporAvailable()).toBe(true);
    expect(chamber.getVaporAppFn()).toBe(vue.createVaporApp);

    const Comp = vue.defineVaporComponent({
      setup() { return vue.template('<div>mounted</div>', true)(); },
    });
    const host = document.createElement('div');
    const app = vapor.createVaporChamberApp(Comp as object) as { mount: (el: Element) => void; unmount: () => void };
    app.mount(host);
    expect(host.textContent).toContain('mounted');
    app.unmount();
  });

  it('CONTROL: when `vue` resolves to the aliased with-vapor build, detection recovers', async () => {
    // Dev-server shape: the alias makes the async channel resolve to a namespace with Vapor. Without this control the failure above could come from an unaliased `vue` having no Vapor.
    vi.doMock('vue', async () => await import(/* @vite-ignore */ WITH_VAPOR));
    vi.resetModules();

    const chamber = await import('../src/chamber');
    await chamber.waitForVueDetection();

    expect(chamber.isVaporAvailable()).toBe(true);

    // A fresh module has not detected yet: detection is async, so only `configureVue()` makes it synchronous.
    vi.resetModules();
    const fresh = await import('../src/chamber');
    expect(fresh.isVaporAvailable()).toBe(false);
  });

  it('the HMR plugin cannot be the production fix - it is serve-only by design', async () => {
    const { vaporChamberHMR } = await import('../src/vite-hmr');
    const plugin = vaporChamberHMR({ verbose: false }) as unknown as { apply?: string };

    expect(plugin.apply).toBe('serve');
  });
});
