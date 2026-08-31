/**
 * FIXTURE - `vapor-chamber/vapor` wires a REAL Vapor registry, statically.
 *
 * Runs under the aliased project (`vitest.vapor.config.ts`), where `vue`
 * resolves to the with-vapor dist - which is what a real Vapor app's bundler
 * resolves it to, and the only configuration in which `src/vapor.ts`'s static
 * imports have anything to import.
 *
 * WHAT IT PINS, and the first assertion is the load-bearing one:
 *
 *   1. The registry is seeded at MODULE-EVALUATION time, so the wiring is the
 *      static import rather than the runtime probe. This is the entire reason
 *      the subpath exists: the probe is a bare dynamic `import()` that resolves
 *      under a dev server and CANNOT resolve in a production bundle, which is
 *      how `createVaporChamberApp()` came to throw "No Vue detected" on a page
 *      with Vapor bundled into it (`tests/vapor-sfc-prod-detection.test.ts`).
 *      A static import has no such failure mode - but proving that it is what
 *      ran needs the observation to happen before any dynamic import could have
 *      settled, which is why it is taken in a helper module's body rather than
 *      here. See `vapor-subpath-at-module-scope.ts`.
 *
 *   2. The consumer-facing contract: `createVaporChamberApp` mounts a real
 *      Vapor app with NO `configureVue()` call anywhere in user code. That one
 *      line is what this entry removes, and it is the thing a reader of the
 *      README will actually check.
 *
 * Note the deliberate absence of `configureVue` in this file. Every other Vapor
 * fixture in this repo calls it (see `tests/keepalive-input-scope-fixture.test.ts`,
 * which must, because it hands the chamber a dist it imported itself). If that
 * call ever becomes necessary here, the subpath has stopped doing its job.
 */

import { describe, expect, it } from 'vitest';

describe('vapor-chamber/vapor under a real with-vapor Vue', () => {
  it('seeds the registry during module evaluation, before any probe could settle', async () => {
    const { vaporReadyAtModuleScope } = await import('./vapor-subpath-at-module-scope');
    expect(vaporReadyAtModuleScope).toBe(true);
  });

  it('mounts a real Vapor app with no configureVue() call in user code', async () => {
    const { createVaporChamberApp, defineVaporComponent } = await import('../../src/vapor');
    const v = (await import('vue')) as any;

    const App = defineVaporComponent({
      setup: () => v.template('<div id="mounted">vapor</div>', true)(),
    });
    // The wrappers' documented null path must be unreachable here - the
    // registry was seeded above, so this is a real component, not `null`.
    expect(App).not.toBeNull();

    const host = document.createElement('div');
    document.body.appendChild(host);

    const app = createVaporChamberApp(App as object);
    expect(app).not.toBeNull();
    (app as { mount: (el: Element) => void }).mount(host);

    expect(host.textContent).toContain('vapor');

    (app as { unmount: () => void }).unmount();
    host.remove();
  });

  it('the KeepAlive guard works through this entry, with nothing hand-wired', async () => {
    // v1.17.0 found `hasInjectionContext` missing from the /vue wiring list,
    // which silently disabled this guard in production bundles
    // (`tests/vue-subpath-wiring-fixture.test.ts`). Since /vapor re-exports and
    // evaluates /vue, that name arrives through this entry too - and this is
    // the assertion that notices if it ever stops.
    const { useCommandHistory } = await import('../../src/vapor');
    // Bus accessors come from the ROOT, not from this entry - deliberately.
    // `/vapor` mirrors `/vue`'s scope: the Vue-dependent surface, because that
    // is the surface whose import must double as the wiring. `getCommandBus` is
    // framework-agnostic and the root carries it with no Vue in the tree, so
    // duplicating it here would widen the entry for no benefit. Documented in
    // `src/vapor.ts` §"WHAT IT DOES NOT RE-EXPORT".
    const { setCommandBus, getCommandBus } = await import('../../src/chamber');
    const { createCommandBus } = await import('../../src/command-bus');
    const v = (await import('vue')) as any;

    setCommandBus(createCommandBus());
    const bus = getCommandBus();
    bus.register('cartAdd', () => 'done');

    let history!: { past: { value: Array<{ target: unknown }> } };
    const Cached = v.defineVaporComponent({
      setup() {
        history = useCommandHistory() as never;
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

    // 'b' was dispatched into a deactivated view; the guard must keep it out.
    expect(history.past.value.map((c) => c.target)).toEqual(['a']);

    app.unmount();
    host.remove();
  });
});
