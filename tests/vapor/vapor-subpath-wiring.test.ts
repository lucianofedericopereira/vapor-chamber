/**
 * `vapor-chamber/vapor` (src/vapor.ts) wires a real Vapor registry by static import, under the with-vapor `vue` alias.
 * Why: the runtime probe is a bare dynamic `import()` that cannot resolve in a production bundle, so without the static wiring `createVaporChamberApp()` would throw "No Vue detected" in a built Vapor app.
 * Shows: the registry is seeded during module evaluation, a Vapor app mounts with no `configureVue()` call, root props follow Vue's raw-props contract, and the KeepAlive guard keeps a dispatch into a deactivated view out of command history.
 * See: tests/vapor-sfc-prod-detection.test.ts, tests/vapor/vapor-subpath-at-module-scope.ts, tests/vue-subpath-wiring-fixture.test.ts
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
    // The wrappers' null path (no registry) must be unreachable here.
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

  // Vue's raw-props contract, unchanged and the opposite of a widget property (tests/vapor/widget-shape.test.ts): a function root prop is a getter, so a callback is wrapped.
  it('root props: a function is a getter, so a callback is passed as () => fn', async () => {
    const { createVaporChamberApp, defineVaporComponent } = await import('../../src/vapor');
    const v = (await import('vue')) as any;

    let calls = 0;
    const onSave = () => {
      calls++;
    };
    const seen: Record<string, unknown> = {};
    const App = defineVaporComponent({
      props: { plain: String, label: String, onSave: Function },
      setup(props: Record<string, unknown>) {
        seen.plain = props.plain;
        seen.label = props.label;
        seen.onSave = props.onSave;
        return v.template('<i>root</i>', true)();
      },
    });

    const host = document.createElement('div');
    document.body.appendChild(host);
    const app = createVaporChamberApp(App as object, {
      plain: 'as given',
      label: () => 'from the getter',
      onSave: () => onSave,
    });
    (app as { mount: (el: Element) => void }).mount(host);

    expect(seen.plain).toBe('as given');
    expect(seen.label).toBe('from the getter');
    expect(seen.onSave).toBe(onSave);
    expect(calls).toBe(0);

    (app as { unmount: () => void }).unmount();
    host.remove();
  });

  it('the KeepAlive guard works through this entry, with nothing hand-wired', async () => {
    // /vapor evaluates /vue, so `hasInjectionContext` (which the guard needs in production bundles) must arrive through this entry too.
    const { useCommandHistory } = await import('../../src/vapor');
    // Bus accessors come from the root: /vapor re-exports only the Vue-dependent surface.
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
