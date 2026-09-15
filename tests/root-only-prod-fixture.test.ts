// @vitest-environment happy-dom
/**
 * FIXTURE - a Vue app that imports the composables from the package ROOT only,
 * under production-bundle conditions.
 *
 * WHY THIS FILE EXISTS. The root reaches Vue through `probeVue()`: a sync read
 * of two global slots, then a bare `import('vue')`. In a built bundle the bare
 * specifier cannot resolve, and `__VUE__` holds Vue's own boolean `true` (set
 * by `createVaporApp()` / `createApp()`, production builds included - see
 * tests/vue-detection-global-clobber.test.ts). So nothing ever calls
 * `applyVueModule()`: `configureSignal()` never runs, `onScopeDispose` and
 * `hasInjectionContext` stay unset, and every composable silently hands back
 * a plain `{ value }`, arms no cleanup, and skips the KeepAlive guard.
 *
 * Nothing in the suite pinned this. `tests/vue-subpath-wiring-fixture.test.ts`
 * calls `configureVue()`; `tests/untracked-production.test.ts` covers
 * `untracked()` only; every other composable test lets vitest resolve `vue`,
 * which is the dev-server asymmetry that hides the failure. The docs led users
 * straight into it: the README Vapor samples imported `useCommand` from the root.
 *
 * WHAT IT PINS:
 *   1. The degradation itself, so it is evidence rather than prose: `loading`
 *      is not a Vue ref, and a listener from `on()` outlives `app.unmount()`.
 *   2. The fix: a warning, NOT dev-gated (production is the only place this
 *      state exists), fired exactly once, naming the remedy.
 *   3. The control: the same app with the namespace handed over gets a real
 *      ref, cleanup on unmount, and no warning.
 *
 * Production conditions are reproduced the way the wiring fixture does it:
 * `vue` made unresolvable, a fresh module registry, `src/` imported directly.
 * Only src/chamber and src/command-bus are imported - no src/vue, no
 * configureVue - because that is exactly the consumer this is about.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const WITH_VAPOR = 'vue/dist/vue.runtime-with-vapor.esm-browser.js';

/** What a browser does with `import('vue')` inside a built bundle. */
function makeBareSpecifierUnresolvable(): void {
  vi.doMock('vue', () => {
    throw new Error("Failed to resolve module specifier 'vue'.");
  });
}

const g = globalThis as unknown as Record<string, unknown>;
const ROOT_ONLY = /without reactivity, cleanup or KeepAlive/;

function rootOnlyWarnings(warn: { mock: { calls: unknown[][] } }): string[] {
  return warn.mock.calls.map((c) => String(c[0])).filter((m) => ROOT_ONLY.test(m));
}

describe('root-only Vue consumer under production-bundle conditions', () => {
  let savedVue: unknown;
  beforeEach(() => {
    savedVue = g.__VUE__;
    delete g.__VUE__;
  });
  afterEach(() => {
    if (savedVue === undefined) delete g.__VUE__; else g.__VUE__ = savedVue;
    delete g.__VC_IIFE__;
    vi.doUnmock('vue');
    vi.restoreAllMocks();
    vi.resetModules();
  });

  /**
   * Import order of a real bundle: the library module evaluates first (its
   * probe sees no Vue), then the app is created - which is when Vue writes
   * `__VUE__ = true` - then setup() runs the composables.
   */
  async function mountRootOnly(configure: boolean) {
    makeBareSpecifierUnresolvable();
    vi.resetModules();

    const chamber: any = await import('../src/chamber');
    const { createCommandBus } = await import('../src/command-bus');
    await chamber.waitForVueDetection(); // the probe rejects into its catch

    const v: any = await import(/* @vite-ignore */ WITH_VAPOR);
    if (configure) chamber.configureVue(v);

    chamber.setCommandBus(createCommandBus());
    const bus = chamber.getCommandBus();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    let api: any;
    let second: any;
    let vueFlagInSetup: unknown;
    const seen: string[] = [];
    const Root = v.defineVaporComponent({
      setup() {
        vueFlagInSetup = g.__VUE__;
        api = chamber.useCommand();
        api.on('ping', (cmd: any) => { seen.push(cmd.action); });
        second = chamber.useCommandState(0, { ping: (s: number) => s + 1 });
        return v.template('<div>root</div>', true)();
      },
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const app = v.createVaporApp(Root);
    app.mount(host);
    return { v, bus, api, second, seen, warn, vueFlagInSetup, app, host };
  }

  it('degrades silently without the fix, and the fix makes it loud - exactly once', async () => {
    const { v, bus, api, second, seen, warn, vueFlagInSetup, app, host } = await mountRootOnly(false);

    // The state the warning keys off, produced by Vue itself, not arranged.
    expect(vueFlagInSetup).toBe(true);

    // 1. The degradation, measured against the same dist the app runs on.
    expect(v.isRef(api.loading)).toBe(false);
    expect(v.isRef(second.state)).toBe(false);
    bus.register('noop', () => 'ok');
    app.unmount();
    host.remove();
    bus.dispatch('ping', null);
    expect(seen).toEqual(['ping']); // the listener outlived the component

    // 2. The fix: one warning for two composables (and any number after).
    const msgs = rootOnlyWarnings(warn);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatch(/vapor-chamber\/vue/);
    expect(msgs[0]).toMatch(/\/vapor/);
    expect(msgs[0]).toMatch(/configureVue\(Vue\)/);
  });

  it('CONTROL: the namespace handed over - real ref, cleanup on unmount, no warning', async () => {
    const { v, bus, api, seen, warn, app, host } = await mountRootOnly(true);

    expect(v.isRef(api.loading)).toBe(true);
    app.unmount();
    host.remove();
    bus.dispatch('ping', null);
    expect(seen).toEqual([]); // disposed with the component's scope
    expect(rootOnlyWarnings(warn)).toHaveLength(0);
  });

  it('no warning when Vue has not created an app - a non-Vue page stays quiet', async () => {
    makeBareSpecifierUnresolvable();
    vi.resetModules();
    const chamber: any = await import('../src/chamber');
    const { createCommandBus } = await import('../src/command-bus');
    await chamber.waitForVueDetection();
    chamber.setCommandBus(createCommandBus());
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    chamber.useCommand().dispose();
    expect(g.__VUE__).toBeUndefined();
    expect(rootOnlyWarnings(warn)).toHaveLength(0);
  });

  it('useCommandQuery warns too - it arms no cleanup, so it never reaches tryAutoCleanup', async () => {
    makeBareSpecifierUnresolvable();
    vi.resetModules();
    const chamber: any = await import('../src/chamber');
    const { createCommandBus } = await import('../src/command-bus');
    await chamber.waitForVueDetection();
    chamber.setCommandBus(createCommandBus());
    g.__VUE__ = true; // what the page looks like once any app has mounted
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    chamber.useCommandQuery();
    chamber.useCommandQuery();
    expect(rootOnlyWarnings(warn)).toHaveLength(1);
  });

  it('IIFE builds drop the subpath advice: a <script> page can only configureVue(Vue)', async () => {
    // `__VC_IIFE__` is a build-time define; with no define (vitest) the
    // `typeof` guard reads the global, so setting it models the IIFE build.
    g.__VC_IIFE__ = true;
    makeBareSpecifierUnresolvable();
    vi.resetModules();
    const chamber: any = await import('../src/chamber');
    const { createCommandBus } = await import('../src/command-bus');
    chamber.setCommandBus(createCommandBus());
    g.__VUE__ = true; // what the page looks like once any app has mounted
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    chamber.useCommand().dispose();
    const msgs = rootOnlyWarnings(warn);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).not.toMatch(/vapor-chamber\/vue/);
    expect(msgs[0]).toMatch(/configureVue\(Vue\)/);
  });
});

/**
 * SSR: the DEV probe-path hint needs a `window`.
 *
 * The hint tells a PAGE that its production bundle cannot resolve the bare
 * `import('vue')`. On a server that is false - Node resolves it from
 * node_modules in production too. Measured on Node with the package
 * externalized (dist/index.js): under NODE_ENV=production a root composable
 * gets a real Vue ref and nothing degrades, so the advice would be wrong
 * there. vitest resolves `vue` here exactly as Node does; `window` is removed
 * to model the server.
 */
describe('probe-path hint on a server (no window)', () => {
  const HINT = /detected at runtime rather than at build time/;

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  async function probePath(): Promise<{ hints: string[]; loadingIsRef: boolean }> {
    vi.resetModules();
    const chamber: any = await import('../src/chamber');
    await chamber.waitForVueDetection();
    const { isRef } = await import('vue');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { loading, dispose } = chamber.useCommand();
    dispose();
    const hints = warn.mock.calls.map((c) => String(c[0])).filter((m) => HINT.test(m));
    return { hints, loadingIsRef: isRef(loading) };
  }

  it('control: a page on the probe path gets the hint once', async () => {
    expect((await probePath()).hints).toHaveLength(1);
  });

  it('no window: no hint', async () => {
    vi.stubGlobal('window', undefined);
    expect((await probePath()).hints).toHaveLength(0);
  });

  it('the premise: with no window and NODE_ENV=production the probe still resolves - a real ref', async () => {
    vi.stubGlobal('window', undefined);
    vi.stubEnv('NODE_ENV', 'production');
    const { hints, loadingIsRef } = await probePath();
    expect(loadingIsRef).toBe(true);
    expect(hints).toHaveLength(0);
  });
});
