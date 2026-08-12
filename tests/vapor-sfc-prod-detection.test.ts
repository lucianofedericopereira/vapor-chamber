// @vitest-environment happy-dom
/**
 * FIXTURE — the production-build gap.
 *
 * `tests/vue-detection-real-ordering.test.ts` proved the no-bundler failure and
 * recorded, in a comment, that "the bundler case is genuinely unaffected". That
 * was measured under **vitest**, which is a dev-server-shaped environment: a
 * bare `import('vue')` resolves there. It does not resolve in a *built* bundle.
 *
 * Loading `examples/vapor-sfc/dist/` over plain HTTP showed the consequence:
 * a blank page and an uncaught *"Vue 3.6+ with Vapor mode required. No Vue
 * detected."* — while `vue.runtime-with-vapor` sat bundled inside that same
 * 94 KB file. Dev worked; production did not. Both channels are missing at once:
 *
 *   1. SYNC — reads the owned global slot. Under Vite the only thing that primes
 *      it is `vaporChamberHMR()`'s companion module, and that plugin is
 *      `apply: 'serve'` (deliberately — see `src/vite-hmr.ts`), so a build has
 *      no priming at all.
 *   2. ASYNC — a bare `import('vue')`. A browser cannot resolve a bare specifier
 *      from a built bundle with no import map; it rejects into an empty catch.
 *
 * So `createVaporChamberApp()` at module scope — the shape every example and doc
 * snippet used — was relying on a channel that only exists in dev.
 *
 * What this file pins is the second channel's absence, which is the half the
 * existing suite structurally could not see: vitest resolves `vue`, so the
 * rejection has to be arranged explicitly to reproduce a browser's behaviour.
 * The first channel needs no arrangement — a fresh module registry simply has
 * no global slot, exactly like a built page.
 *
 * Verified to fail against the pre-fix `examples/vapor-sfc/src/main.ts`.
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

  it('REGRESSION: no priming + unresolvable bare import → createVaporChamberApp throws', async () => {
    // Channel 1 is empty with no arrangement whatsoever. This is not a stub of
    // the build — it IS the build's state, because `vaporChamberHMR` never ran.
    expect((globalThis as Record<string, unknown>).__VAPOR_CHAMBER_VUE__).toBeUndefined();

    // Channel 2, reproduced: the browser's actual behaviour, which vitest
    // otherwise papers over by resolving the specifier.
    makeBareSpecifierUnresolvable();
    vi.resetModules();

    const chamber = await import('../src/chamber');
    const vapor = await import('../src/chamber-vapor');

    // The rejection is swallowed by design (Vue is optional), so waiting on the
    // probe completes normally and detection is still empty afterwards. That
    // silence is why the built example failed with no diagnostic of its own.
    await chamber.waitForVueDetection();
    expect(chamber.isVaporAvailable()).toBe(false);

    // MEASURED: the exact throw the built page produced.
    expect(() => vapor.createVaporChamberApp({})).toThrow(
      /Vue 3\.6\+ with Vapor mode required/,
    );
    // …and the hint names the one-line remedy rather than leaving it a mystery.
    expect(chamber.vueDetectionHint()).toMatch(/configureVue\(/);
  });

  it('FIXED by configureVue(): same bundle conditions, real with-vapor namespace', async () => {
    makeBareSpecifierUnresolvable();
    vi.resetModules();

    const chamber = await import('../src/chamber');
    const vapor = await import('../src/chamber-vapor');
    await chamber.waitForVueDetection();
    expect(chamber.isVaporAvailable()).toBe(false);

    // The one line `examples/vapor-sfc/src/main.ts` now carries. In the real
    // example this namespace arrives through the `vite.config.ts` alias, so it
    // is the same instance the compiled SFCs use — not a second Vue dist.
    const vue = (await import(/* @vite-ignore */ WITH_VAPOR)) as unknown as VaporApi;
    chamber.configureVue(vue as unknown as object);

    // Synchronously available, with the async channel still broken.
    expect(chamber.isVaporAvailable()).toBe(true);
    expect(chamber.getVaporAppFn()).toBe(vue.createVaporApp);

    // End to end: a real Vapor app really mounts under these conditions.
    const Comp = vue.defineVaporComponent({
      setup() { return vue.template('<div>mounted</div>', true)(); },
    });
    const host = document.createElement('div');
    const app = vapor.createVaporChamberApp<{ mount: (el: Element) => void; unmount: () => void }>(
      Comp as object,
    );
    app.mount(host);
    expect(host.textContent).toContain('mounted');
    app.unmount();
  });

  it('CONTROL: when `vue` resolves to the aliased with-vapor build, detection recovers', async () => {
    // This is the dev server, and it is the whole reason the bug hid. Vite
    // serves the alias, so the async channel resolves to a namespace that DOES
    // carry Vapor — the same alias `examples/vapor-sfc/vite.config.ts` sets.
    //
    // Without this control the regression above proves less than it appears to:
    // an unaliased `vue` has no Vapor either, so it would throw for a second,
    // unrelated reason. Pinning the aliased case is what isolates "the specifier
    // cannot resolve" as the actual cause.
    vi.doMock('vue', async () => await import(/* @vite-ignore */ WITH_VAPOR));
    vi.resetModules();

    const chamber = await import('../src/chamber');
    await chamber.waitForVueDetection();

    expect(chamber.isVaporAvailable()).toBe(true);

    // Still only true one tick late — synchronous module-scope calls remain
    // unsafe even here, which is why `configureVue()` is the wiring and not
    // merely a fallback.
    vi.resetModules();
    const fresh = await import('../src/chamber');
    expect(fresh.isVaporAvailable()).toBe(false);
  });

  it('the HMR plugin cannot be the production fix — it is serve-only by design', async () => {
    const { vaporChamberHMR } = await import('../src/vite-hmr');
    const plugin = vaporChamberHMR({ verbose: false }) as unknown as { apply?: string };

    // Pins the causal link rather than the coincidence: if this ever becomes
    // build-capable, the priming story changes and this fixture should be
    // revisited alongside it.
    expect(plugin.apply).toBe('serve');
  });
});
