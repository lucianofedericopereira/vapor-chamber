// @vitest-environment happy-dom
/**
 * `globalThis.__VUE__` against real Vue: Vue owns the key and overwrites it with the boolean `true` when the first app is created.
 * Why: a Vue namespace parked on `__VUE__` would be replaced by `true` once anything mounts, so a library that probed it would find nothing on a page that has Vapor; detection must use a slot the library owns (`configureVue()`, `__VAPOR_CHAMBER_VUE__`).
 * Shows: importing the with-vapor build leaves `__VUE__` unset; creating and mounting a Vapor app replaces a hand-assigned namespace with `true`; `true` fails a namespace check (`typeof ref === 'function'`); the with-vapor build still exports `createVaporApp` and `ref`.
 * See: src/chamber.ts (configureVue), docs/whitepaper.md 9.6
 */

import { describe, expect, it } from 'vitest';

const WITH_VAPOR = 'vue/dist/vue.runtime-with-vapor.esm-browser.js';

type VaporApi = {
  createVaporApp: (root: unknown) => { mount: (el: unknown) => void; unmount: () => void };
  defineVaporComponent: (c: unknown) => unknown;
  template: (html: string, root?: boolean) => () => Element;
};

describe('globalThis.__VUE__ is Vue-owned, not a namespace slot', () => {
  it('importing Vue does NOT set __VUE__ - the key is untouched until an app is created', async () => {
    const g = globalThis as unknown as Record<string, unknown>;
    const before = g.__VUE__;
    try {
      delete g.__VUE__;
      await import(/* @vite-ignore */ WITH_VAPOR);

      // Vue assigns the key lazily, at app creation.
      expect(g.__VUE__).toBeUndefined();
    } finally {
      if (before === undefined) delete g.__VUE__; else g.__VUE__ = before;
    }
  });

  it('creating a Vapor app overwrites a hand-assigned namespace with `true`', async () => {
    const g = globalThis as unknown as Record<string, unknown>;
    const before = g.__VUE__;
    const vue = (await import(/* @vite-ignore */ WITH_VAPOR)) as unknown as VaporApi;

    try {
      // Park the namespace on Vue's key by hand.
      g.__VUE__ = vue;
      expect(typeof (g.__VUE__ as { ref?: unknown }).ref).toBe('function');

      const Comp = vue.defineVaporComponent({
        setup() { return vue.template('<div>x</div>', true)(); },
      });
      vue.createVaporApp(Comp).mount(document.createElement('div'));

      // Mounting replaces the namespace with Vue's devtools boolean.
      expect(g.__VUE__).toBe(true);
      expect(typeof (g.__VUE__ as { ref?: unknown }).ref).not.toBe('function');
    } finally {
      if (before === undefined) delete g.__VUE__; else g.__VUE__ = before;
    }
  });

  it('the capability itself is present - only our route to it is lost', async () => {
    const vue = (await import(/* @vite-ignore */ WITH_VAPOR)) as Record<string, unknown>;

    expect(typeof vue.createVaporApp).toBe('function');
    expect(typeof vue.ref).toBe('function');
  });
});
