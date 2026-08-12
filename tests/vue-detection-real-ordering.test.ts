// @vitest-environment happy-dom
/**
 * FIXTURE — is the detection failure an artefact of how the other tests probe,
 * or does it happen with the real Vue build and the real `chamber.ts`?
 *
 * Worth asking, because the two neighbouring suites each prove only half:
 *   - `tests/vue-global-detection.test.ts` stubs globals and hands the probe a
 *     MOCK namespace. It measures OUR logic's response to a shape, not Vue.
 *   - `tests/vue-detection-global-clobber.test.ts` uses the real build and
 *     measures VUE's behaviour (`__VUE__` becomes `true` on app creation), but
 *     never runs `chamber.ts` against it.
 *
 * Neither on its own shows an end-to-end failure. This file closes that gap:
 * real `vue.runtime-with-vapor.esm-browser.js`, a real `createVaporApp().mount()`,
 * and a real, freshly-evaluated `src/chamber.ts` — nothing stubbed, nothing
 * mocked. The only thing arranged is the ORDER, which is the variable under
 * test.
 *
 * The order being reproduced is the documented no-bundler page from whitepaper
 * §11.6, in the arrangement where the library is not the first thing to load:
 * a Vue app mounts, and only then does a later chunk / island / deferred
 * script pull in vapor-chamber. In a bundler this is harmless because the
 * async `import('vue')` fallback resolves; on a no-bundler page that fallback
 * is a bare specifier the browser cannot resolve at all, so the synchronous
 * global is the only channel left — and by then it holds `true`.
 */

import { describe, expect, it, vi, afterEach } from 'vitest';

const WITH_VAPOR = 'vue/dist/vue.runtime-with-vapor.esm-browser.js';

type VaporApi = {
  createVaporApp: (root: unknown) => { mount: (el: unknown) => void; unmount: () => void };
  defineVaporComponent: (c: unknown) => unknown;
  template: (html: string, root?: boolean) => () => Element;
};

async function mountRealVaporApp(): Promise<VaporApi> {
  const vue = (await import(/* @vite-ignore */ WITH_VAPOR)) as unknown as VaporApi;
  const Comp = vue.defineVaporComponent({
    setup() { return vue.template('<div>x</div>', true)(); },
  });
  vue.createVaporApp(Comp).mount(document.createElement('div'));
  return vue;
}

describe('real ordering: app mounts first, library loads second', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('REAL FAILURE: after a real mount, a fresh chamber.ts cannot see Vapor via __VUE__', async () => {
    const vue = await mountRealVaporApp();

    // Real Vue really did this — no stub involved.
    expect((globalThis as unknown as Record<string, unknown>).__VUE__).toBe(true);

    // The page genuinely has Vapor sitting right there.
    expect(typeof vue.createVaporApp).toBe('function');

    // Now the library loads, for the first time, into that page. `vi.resetModules`
    // is not simulating anything about detection — it is how a fresh module
    // evaluation is obtained in-process, which is what a late chunk does.
    vi.resetModules();
    const chamber = await import('../src/chamber');

    // MEASURED, end to end: detection comes up empty. Not a mock artefact —
    // the boolean on the left was written by Vue, and the probe on the right
    // is the shipping one.
    //
    // (The async `import('vue')` fallback is what saves the bundler case, and
    // it is deliberately NOT awaited here: on a no-bundler page it is a bare
    // specifier that cannot resolve, so this synchronous outcome is the whole
    // outcome. `waitForVueDetection()` is asserted separately below to keep
    // the distinction honest.)
    expect(chamber.isVaporAvailable()).toBe(false);
    expect(chamber.getVaporAppFn()).toBeNull();

    // And the failure is legible rather than silent, which is the other half
    // of the fix: the hint names the cause and the one-line remedy.
    expect(chamber.vueDetectionHint()).toMatch(/unreachable/);
  });

  it('the bundler case is genuinely unaffected — the async probe still resolves', async () => {
    await mountRealVaporApp();
    vi.resetModules();
    const chamber = await import('../src/chamber');

    // Under a bundler (which is what vitest is here), `import('vue')` resolves,
    // so detection recovers a tick later.
    //
    // CORRECTION: this comment used to read "the bundler case is genuinely
    // unaffected". Narrow that to **the dev server**. In a production build the
    // bare specifier does not resolve either, and the built `vapor-sfc` example
    // was throwing on a page with Vapor bundled into it. Pinned separately in
    // `tests/vapor-sfc-prod-detection.test.ts`. Vitest resolves `vue`, which is
    // precisely why this suite could not see that half.
    await chamber.waitForVueDetection();

    // The plain `vue` entry ships no Vapor runtime (whitepaper §11.6), so Vapor
    // specifically stays false even here — but Vue itself was found.
    expect(chamber.getVueDeepRefFn()).not.toBeNull();
  });

  it('FIXED by the owned slot: same real ordering, detection succeeds', async () => {
    const vue = await mountRealVaporApp();
    expect((globalThis as unknown as Record<string, unknown>).__VUE__).toBe(true);

    // The one line the fix asks a no-bundler page for. Same real namespace,
    // parked in a slot Vue does not write.
    vi.stubGlobal('__VAPOR_CHAMBER_VUE__', vue);

    vi.resetModules();
    const chamber = await import('../src/chamber');

    // MEASURED: full Vapor surface, synchronously, on the page that failed above.
    expect(chamber.isVaporAvailable()).toBe(true);
    expect(chamber.getVaporAppFn()).toBe(vue.createVaporApp);
  });

  it('FIXED by configureVue(): no globals at all, same real ordering', async () => {
    const vue = await mountRealVaporApp();

    vi.resetModules();
    const chamber = await import('../src/chamber');
    expect(chamber.isVaporAvailable()).toBe(false);

    chamber.configureVue(vue as unknown as object);

    expect(chamber.isVaporAvailable()).toBe(true);
    expect(chamber.getVaporAppFn()).toBe(vue.createVaporApp);
  });
});
