// @vitest-environment happy-dom
/**
 * A Vue app importing the composables from the package root only, under production-bundle conditions.
 * Why: the root reaches Vue through `probeVue()`, a sync read of two global slots then a bare `import('vue')`. In a built bundle the bare specifier cannot resolve and `__VUE__` holds Vue's own `true`, so `applyVueModule()` never runs: composables would silently return a plain `{ value }`, arm no cleanup and skip the KeepAlive guard. The warning must therefore not be dev-gated (production is the only place this state exists), must fire once, and must name the remedy. Production conditions: `vue` made unresolvable, a fresh module registry, `src/chamber` and `src/command-bus` imported directly with no src/vue and no configureVue.
 * Shows: without configureVue, `pending()` is not a Vue ref, a listener from `on()` outlives `app.unmount()`, and one warning names the remedy; with the namespace handed over, a real ref, cleanup on unmount and no warning; no warning on a page where Vue made no app; useCommandQuery warns; an IIFE build omits the subpath advice; the DEV probe-path hint needs a window, and on a server with NODE_ENV=production the probe still resolves a real ref.
 * See: tests/vue-detection-global-clobber.test.ts, tests/vue-subpath-wiring-fixture.test.ts
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

  // Import order of a real bundle: the library evaluates first (its probe sees no Vue), then the app is created (Vue writes `__VUE__ = true`), then setup() runs.
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
        second = chamber.useCommandHistory();
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

    expect(v.isRef(api.pending('probe'))).toBe(false);
    expect(v.isRef(second.past)).toBe(false);
    bus.register('noop', () => 'ok');
    app.unmount();
    host.remove();
    bus.dispatch('ping', null);
    expect(seen).toEqual(['ping']); // the listener outlived the component

    // One warning for two composables, and for any number after.
    const msgs = rootOnlyWarnings(warn);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatch(/vapor-chamber\/vue/);
    expect(msgs[0]).toMatch(/\/vapor/);
    expect(msgs[0]).toMatch(/configureVue\(Vue\)/);
  });

  it('CONTROL: the namespace handed over - real ref, cleanup on unmount, no warning', async () => {
    const { v, bus, api, seen, warn, app, host } = await mountRootOnly(true);

    expect(v.isRef(api.pending('probe'))).toBe(true);
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
    // `__VC_IIFE__` is a build-time define; with none (vitest) the `typeof` guard reads the global, so setting it models the IIFE build.
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

// The hint tells a page its bundle cannot resolve `import('vue')`; on a server Node resolves it, so the advice would be wrong. Removing `window` models the server.
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
    const c = chamber.useCommand();
    const loading = c.pending('probe');
    c.dispose();
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
