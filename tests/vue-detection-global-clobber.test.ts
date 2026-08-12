// @vitest-environment happy-dom
/**
 * FIXTURE — `globalThis.__VUE__` is a key Vue itself owns and overwrites with
 * a BOOLEAN, and it does so at app-creation time. Measured on vue@3.6.0-rc.3.
 *
 * `src/chamber.ts` §probeVue reads `globalThis.__VUE__` and expects to find
 * **the Vue module namespace** there:
 *
 *     if (globalThis.__VUE__) { const vue = globalThis.__VUE__;
 *                               if (typeof vue.ref === 'function') applyVueModule(vue) }
 *
 * and whitepaper §11.6 + the README tell no-bundler users to put it there by
 * hand, because that synchronous path is the ONLY way Vapor is ever detected
 * without a bundler (the async `import('vue')` fallback is a bare specifier
 * that cannot resolve in a browser).
 *
 * But `__VUE__` is not ours. Vue assigns `target.__VUE__ = true` — a devtools
 * marker — from `prepareApp()` (Vapor) and `baseCreateRenderer()` (vDOM), in
 * both the dev and the production builds. Two writers, two incompatible value
 * types, one key.
 *
 * TWO CORRECTIONS TO THIS FIXTURE'S OWN EARLIER DRAFTS, kept because the
 * method is the point and both were caught by running it rather than by
 * reasoning about it:
 *
 *   1. First draft claimed a later `import()` of Vue clobbers a manually
 *      assigned namespace. It does not — ESM evaluates a module once per
 *      realm, so the second import is a cache hit that re-runs no init.
 *   2. Second draft claimed merely importing Vue sets `__VUE__`. It does not
 *      either — the assignment is lazy, and the tests below show import alone
 *      leaves the key `undefined`.
 *
 * What survives measurement is narrower than either, and worse in a more
 * interesting way: the key flips **when the first app is created**. So the
 * documented recipe (import, assign, then load vapor-chamber) is sound only
 * while vapor-chamber's one-shot probe wins the race against the app's own
 * `mount()`. Once anything mounts, the namespace is gone. A build that
 * imports the library lazily — a code-split chunk, a second island, an MPA
 * page with different script order — probes *after* that point, finds `true`,
 * cannot use it, and falls through to the async import that browsers cannot
 * resolve. `createVaporChamberApp()` then throws "Vue 3.6+ with Vapor mode
 * required" on a page that demonstrably has Vapor, with nothing logged to say
 * why.
 *
 * This is why detection gains a channel the library owns — `configureVue()`
 * and `__VAPOR_CHAMBER_VUE__` in `src/chamber.ts`. `__VUE__` stays supported
 * as a legacy fallback (devtools-hook pages and existing setups rely on it),
 * but it is no longer the only door, and it is no longer asked to hold a
 * value type Vue overwrites on mount.
 */

import { describe, expect, it } from 'vitest';

const WITH_VAPOR = 'vue/dist/vue.runtime-with-vapor.esm-browser.js';

type VaporApi = {
  createVaporApp: (root: unknown) => { mount: (el: unknown) => void; unmount: () => void };
  defineVaporComponent: (c: unknown) => unknown;
  template: (html: string, root?: boolean) => () => Element;
};

describe('globalThis.__VUE__ is Vue-owned, not a namespace slot', () => {
  it('importing Vue does NOT set __VUE__ — the key is untouched until an app is created', async () => {
    const g = globalThis as unknown as Record<string, unknown>;
    const before = g.__VUE__;
    try {
      delete g.__VUE__;
      await import(/* @vite-ignore */ WITH_VAPOR);

      // MEASURED: still absent. This is the window in which the documented
      // no-bundler recipe works — and it is the whole of that window.
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
      // The documented recipe: park the namespace where probeVue looks.
      g.__VUE__ = vue;
      expect(typeof (g.__VUE__ as { ref?: unknown }).ref).toBe('function');

      const Comp = vue.defineVaporComponent({
        setup() { return vue.template('<div>x</div>', true)(); },
      });
      vue.createVaporApp(Comp).mount(document.createElement('div'));

      // MEASURED: mounting the app replaced the namespace with Vue's devtools
      // boolean. Any probe running from here on gets nothing from this channel.
      expect(g.__VUE__).toBe(true);
      expect(typeof (g.__VUE__ as { ref?: unknown }).ref).not.toBe('function');
    } finally {
      if (before === undefined) delete g.__VUE__; else g.__VUE__ = before;
    }
  });

  it('a truthy __VUE__ therefore proves nothing about Vapor availability', async () => {
    const g = globalThis as unknown as Record<string, unknown>;
    const before = g.__VUE__;
    try {
      g.__VUE__ = true; // what a real page looks like once anything has mounted

      // This is precisely the shape of the check in probeVue's sync branch.
      const v = g.__VUE__ as { ref?: unknown; createVaporApp?: unknown };
      const usable = !!v && typeof v.ref === 'function';

      expect(g.__VUE__).toBeTruthy();
      expect(usable).toBe(false);
    } finally {
      if (before === undefined) delete g.__VUE__; else g.__VUE__ = before;
    }
  });

  it('the capability itself is present — only our route to it is lost', async () => {
    const vue = (await import(/* @vite-ignore */ WITH_VAPOR)) as Record<string, unknown>;

    // The counterpart fact, and the reason the failure reads as a library bug
    // to whoever hits it: nothing about Vapor is missing on such a page.
    expect(typeof vue.createVaporApp).toBe('function');
    expect(typeof vue.ref).toBe('function');
  });
});
