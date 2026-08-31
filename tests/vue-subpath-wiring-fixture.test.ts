// @vitest-environment happy-dom
/**
 * FIXTURE - is the `configureVue()` list in `src/vue.ts` COMPLETE, judged from a
 * production bundle rather than from a dev server?
 *
 * WHY THIS FILE EXISTS. `vapor-chamber/vue` hands the registry a fixed list of
 * named Vue imports. Any registry entry `chamber.ts` reads but that list does
 * not pass is not "missing" in any way the suite can see - because
 * `probeVue()` runs first, and under vitest (a dev-server-shaped environment) a
 * bare `import('vue')` RESOLVES and supplies the full namespace, silently
 * covering the gap. In a built bundle the bare specifier cannot resolve, the
 * probe comes up empty, and the registry contains exactly what the list passed
 * and nothing else.
 *
 * So this is a whole class of defect that is dev-correct and prod-broken, and
 * invisible to every other test in the suite. It is the same asymmetry that
 * motivated `vapor-chamber/vue` in the first place (see that module's header),
 * and `tests/vapor-sfc-prod-detection.test.ts` pins the sibling case for Vue
 * detection itself.
 *
 * WHAT IT FOUND (v1.17.0). `hasInjectionContext` was absent from the list.
 * `tryKeepAliveHooks` gates on it *specifically because* `getCurrentInstance()`
 * returns null inside a Vapor component by design - the rc.4 finding, recorded
 * in whitepaper §9 and ROADMAP. With the entry unset the gate falls back to
 * `getCurrentInstance()` and goes inert, so `useCommandHistory` /
 * `useCommandError` record commands dispatched into a DEACTIVATED KeepAlive
 * view. Measured here before the fix: a command dispatched while the component
 * was deactivated came back in `history.past`. rc.4's guard was correct the
 * whole time; the wiring never delivered what the guard depends on.
 *
 * WHAT IT PINS, and the second assertion is the load-bearing one:
 *
 *   1. Under production-bundle conditions, the KeepAlive guard still suppresses
 *      recording - i.e. the list carries everything the guard needs.
 *   2. The mechanism is the one we think it is: with the probe blocked,
 *      `hasInjectionContext` reaches the registry from the STATIC list. If a
 *      future refactor drops it, #1 fails and this comment says why.
 *
 * The probe is blocked by making `vue` unresolvable, exactly as
 * `tests/vapor-sfc-prod-detection.test.ts` does - that is what reproduces a
 * browser loading a built bundle. Components are built from the with-vapor dist
 * and the chamber is pointed at that same module object, since two
 * separately-imported Vue dists are two disconnected reactivity instances
 * (chamber.ts §probeVue).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

const WITH_VAPOR = 'vue/dist/vue.runtime-with-vapor.esm-browser.js';

/** Exactly the names `src/vue.ts` passes to `configureVue()`. Keep in sync. */
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

    // The static list, plus the one Vapor entry a Vapor app adds on top. No
    // probe will run successfully here, so this is the ENTIRE registry.
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

    // Dispatched into a view the user is not looking at. The guard must keep it
    // out of that view's undo history - and can only do so if the registry got
    // `hasInjectionContext`, because `getCurrentInstance()` is null in Vapor.
    bus.dispatch('cartAdd', 'b');
    expect(history.past.value.map((c) => c.target)).toEqual(['a']);

    // Recording resumes on reactivation, and the away command is not replayed.
    show.value = true;
    await v.nextTick();
    bus.dispatch('cartAdd', 'c');
    expect(history.past.value.map((c) => c.target)).toEqual(['a', 'c']);

    app.unmount();
    host.remove();
  });

  it('the guard is genuinely doing the work - dropping one name breaks it', async () => {
    // The control. Without this, assertion #1 above could pass for reasons
    // having nothing to do with the wiring (e.g. KeepAlive not deactivating at
    // all), and the fixture would be measuring nothing. Re-running the same
    // scenario with `hasInjectionContext` withheld must FAIL to suppress.
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

    // The pre-v1.17.0 behaviour, kept as evidence rather than described in prose.
    expect(history.past.value.map((c) => c.target)).toEqual(['a', 'b']);

    app.unmount();
    host.remove();
  });
});
