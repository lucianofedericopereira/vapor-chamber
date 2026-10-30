// @vitest-environment happy-dom
/**
 * The KeepAlive history guard with `vue` unresolvable, as in a production bundle, wired from a copy of the name list in `src/vue.ts`.
 * Why: under a dev server the probe's `import('vue')` supplies the full namespace and hides a name missing from the `configureVue()` list; in a built bundle the registry holds only that list, so a missing `hasInjectionContext` would make `useCommandHistory` / `useCommandError` record commands dispatched into a deactivated KeepAlive view.
 * Shows: with the list plus `createVaporApp` as the whole registry, a command dispatched while the Vapor KeepAlive view is deactivated stays out of `history.past` and recording resumes on reactivation; with `hasInjectionContext` withheld the same command is recorded. The list is a hand copy (`subpathWiring`): `src/vue.ts` itself is not imported, so a drift between them is not detected here.
 * See: src/vue.ts, tests/vapor-sfc-prod-detection.test.ts
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

const WITH_VAPOR = 'vue/dist/vue.runtime-with-vapor.esm-browser.js';

/** A copy of the names `src/vue.ts` passes to `configureVue()`. Keep in sync. */
function subpathWiring(v: any): Record<string, unknown> {
  return {
    ref: v.ref,
    shallowRef: v.shallowRef,
    getCurrentScope: v.getCurrentScope,
    getCurrentInstance: v.getCurrentInstance,
    hasInjectionContext: v.hasInjectionContext,
    onScopeDispose: v.onScopeDispose,
    onActivated: v.onActivated,
    onDeactivated: v.onDeactivated,
  };
}

/** What a browser does with `import('vue')` inside a built bundle. */
function makeBareSpecifierUnresolvable(): void {
  vi.doMock('vue', () => {
    throw new Error("Failed to resolve module specifier 'vue'.");
  });
}

describe('vapor-chamber/vue wiring, under production-bundle conditions', () => {
  afterEach(() => {
    vi.doUnmock('vue');
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('carries everything the KeepAlive guard needs when the probe cannot resolve', async () => {
    makeBareSpecifierUnresolvable();
    vi.resetModules();

    const v: any = await import(/* @vite-ignore */ WITH_VAPOR);
    const chamber: any = await import('../src/chamber');
    const { createCommandBus } = await import('../src/command-bus');

    // The probe cannot resolve `vue`, so the list plus createVaporApp is the whole registry.
    chamber.configureVue({ ...subpathWiring(v), createVaporApp: v.createVaporApp });

    chamber.setCommandBus(createCommandBus());
    const bus = chamber.getCommandBus();
    bus.register('cartAdd', () => 'done');

    let history!: { past: { value: Array<{ target: unknown }> } };
    const Cached = v.defineVaporComponent({
      setup() {
        history = chamber.useCommandHistory();
        return v.template('<div>cached</div>', true)();
      },
    });
    const Other = v.defineVaporComponent({
      setup: () => v.template('<div>other</div>', true)(),
    });

    const show = v.shallowRef(true);
    const Root = v.defineVaporComponent({
      setup() {
        return v.createComponent(v.VaporKeepAlive, null, {
          default: () =>
            v.createIf(
              () => show.value,
              () => v.createComponent(Cached),
              () => v.createComponent(Other),
            ),
        });
      },
    });

    const host = document.createElement('div');
    document.body.appendChild(host);
    const app = v.createVaporApp(Root);
    app.mount(host);

    bus.dispatch('cartAdd', 'a');
    expect(history.past.value.map((c) => c.target)).toEqual(['a']);

    show.value = false;
    await v.nextTick();
    expect(host.textContent).toContain('other');

    // The guard needs `hasInjectionContext`: `getCurrentInstance()` is null in Vapor.
    bus.dispatch('cartAdd', 'b');
    expect(history.past.value.map((c) => c.target)).toEqual(['a']);

    // The command dispatched while away is not replayed.
    show.value = true;
    await v.nextTick();
    bus.dispatch('cartAdd', 'c');
    expect(history.past.value.map((c) => c.target)).toEqual(['a', 'c']);

    app.unmount();
    host.remove();
  });

  it('the guard is genuinely doing the work - dropping one name breaks it', async () => {
    // Control: without it the test above could pass with KeepAlive never deactivating.
    makeBareSpecifierUnresolvable();
    vi.resetModules();

    const v: any = await import(/* @vite-ignore */ WITH_VAPOR);
    const chamber: any = await import('../src/chamber');
    const { createCommandBus } = await import('../src/command-bus');

    const { hasInjectionContext: _dropped, ...withoutHIC } = subpathWiring(v);
    chamber.configureVue({ ...withoutHIC, createVaporApp: v.createVaporApp });

    chamber.setCommandBus(createCommandBus());
    const bus = chamber.getCommandBus();
    bus.register('cartAdd', () => 'done');

    let history!: { past: { value: Array<{ target: unknown }> } };
    const Cached = v.defineVaporComponent({
      setup() {
        history = chamber.useCommandHistory();
        return v.template('<div>cached</div>', true)();
      },
    });
    const Other = v.defineVaporComponent({
      setup: () => v.template('<div>other</div>', true)(),
    });

    const show = v.shallowRef(true);
    const Root = v.defineVaporComponent({
      setup() {
        return v.createComponent(v.VaporKeepAlive, null, {
          default: () =>
            v.createIf(
              () => show.value,
              () => v.createComponent(Cached),
              () => v.createComponent(Other),
            ),
        });
      },
    });

    const host = document.createElement('div');
    document.body.appendChild(host);
    const app = v.createVaporApp(Root);
    app.mount(host);

    bus.dispatch('cartAdd', 'a');
    show.value = false;
    await v.nextTick();
    bus.dispatch('cartAdd', 'b');

    // Without hasInjectionContext the guard is inert, so 'b' is recorded.
    expect(history.past.value.map((c) => c.target)).toEqual(['a', 'b']);

    app.unmount();
    host.remove();
  });
});
