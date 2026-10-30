// @vitest-environment happy-dom
/**
 * Vapor detection in a freshly evaluated `src/chamber.ts` after a real Vue app has mounted: the real with-vapor build, a real `createVaporApp().mount()`, nothing stubbed except the owned slot where named.
 * Why: on a no-bundler page, a later chunk or island that loads the library after an app mounted finds `__VUE__ === true` and cannot see Vapor, because the async `import('vue')` cannot resolve there; the owned slot and `configureVue()` must still work in that order.
 * Shows: after a mount the library reports no Vapor and a hint saying Vue is unreachable; under Vitest's resolver the async probe still finds Vue; a namespace in `__VAPOR_CHAMBER_VUE__`, or passed to `configureVue()`, restores the full Vapor surface.
 * See: tests/vue-global-detection.test.ts, tests/vue-detection-global-clobber.test.ts, tests/vapor-sfc-prod-detection.test.ts, docs/whitepaper.md 9.6
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

    expect((globalThis as unknown as Record<string, unknown>).__VUE__).toBe(true);

    expect(typeof vue.createVaporApp).toBe('function');

    // resetModules gives a fresh module evaluation, as a late chunk gets.
    vi.resetModules();
    const chamber = await import('../src/chamber');

    // The async import('vue') probe is deliberately not awaited: on a no-bundler page it cannot resolve.
    expect(chamber.isVaporAvailable()).toBe(false);
    expect(chamber.getVaporAppFn()).toBeNull();

    expect(chamber.vueDetectionHint()).toMatch(/unreachable/);
  });

  it('the bundler case is genuinely unaffected - the async probe still resolves', async () => {
    await mountRealVaporApp();
    vi.resetModules();
    const chamber = await import('../src/chamber');

    // Vitest resolves `import('vue')`, as a dev server does; a production build does not (tests/vapor-sfc-prod-detection.test.ts).
    await chamber.waitForVueDetection();

    // Vue itself was found; the plain `vue` entry this resolves to ships no Vapor runtime.
    expect(chamber.getVueDeepRefFn()).not.toBeNull();
  });

  it('FIXED by the owned slot: same real ordering, detection succeeds', async () => {
    const vue = await mountRealVaporApp();
    expect((globalThis as unknown as Record<string, unknown>).__VUE__).toBe(true);

    // The same real namespace, parked in a slot Vue does not write.
    vi.stubGlobal('__VAPOR_CHAMBER_VUE__', vue);

    vi.resetModules();
    const chamber = await import('../src/chamber');

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
