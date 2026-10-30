// @vitest-environment happy-dom
/**
 * `tryKeepAliveHooks` against a real VaporKeepAlive and a real cached Vapor component.
 * Why: a command dispatched while a cached view is deactivated must not enter that view's undo
 * history, and recording must resume on reactivation. The guard must also stay needed: a plain
 * `bus.onAfter` callback is owned by no scope, so Vue's pausing never reaches it. If it ever did,
 * the guard would become double-suppression and docs/router.md's delete-it note would be right.
 * The guard probes `hasInjectionContext()`, since a Vapor component is not stored in VDOM's
 * `currentInstance`.
 * Shows: history holds only the commands dispatched while active, an unguarded hook fires while
 * deactivated, and the component is deactivated and reactivated, never unmounted.
 * See: tests/keepalive-pause-fixture.test.ts, docs/router.md
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { configureVue, getCommandBus, setCommandBus, useCommandHistory } from '../src/chamber';
import { createCommandBus } from '../src/command-bus';

const WITH_VAPOR = 'vue/dist/vue.runtime-with-vapor.esm-browser.js';

/** Raw runtime-vapor surface - deliberately untyped; this file builds a component tree by hand. */
type VaporApi = any;

async function vapor(): Promise<VaporApi> {
  return (await import(/* @vite-ignore */ WITH_VAPOR)) as unknown as VaporApi;
}

describe('tryKeepAliveHooks under a real VaporKeepAlive (rc.4)', () => {
  beforeEach(() => {
    setCommandBus(createCommandBus());
  });

  it('guards history while deactivated, and the unguarded hook still fires', async () => {
    const v = await vapor();
    // The chamber must use the same Vue module the components are built from, or onDeactivated registers on an instance it never sees.
    configureVue(v);

    const bus = getCommandBus();
    bus.register('cartAdd', () => 'done');

    /** Fired by an onAfter hook the cached component registers WITHOUT a guard. */
    const unguarded: string[] = [];
    let history!: ReturnType<typeof useCommandHistory>;

    const Cached = v.defineVaporComponent({
      setup() {
        history = useCommandHistory();
        // The control: same registration site, same lifetime, no pause flag.
        bus.onAfter((cmd: { action: string }) => {
          unguarded.push(cmd.action);
        });
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

    expect(host.textContent).toContain('cached');

    bus.dispatch('cartAdd', 'a');
    expect(history.past.value.map((c) => c.action)).toEqual(['cartAdd']);
    expect(unguarded).toEqual(['cartAdd']);

    show.value = false;
    await v.nextTick();
    expect(host.textContent).toContain('other');

    bus.dispatch('cartAdd', 'b');

    // The guard holds: a command dispatched in a hidden view stays out of its undo history.
    expect(history.past.value.map((c) => c.target)).toEqual(['a']);

    // A bus hook is a plain callback owned by no scope, so Vue's pausing cannot suppress it.
    expect(unguarded).toEqual(['cartAdd', 'cartAdd']);

    show.value = true;
    await v.nextTick();
    expect(host.textContent).toContain('cached');

    bus.dispatch('cartAdd', 'c');

    // Recording resumes on activation; the command dispatched while away is not replayed.
    expect(history.past.value.map((c) => c.target)).toEqual(['a', 'c']);

    app.unmount();
    host.remove();
  });

  it('the cached component is deactivated, not unmounted - the premise of the above', async () => {
    const v = await vapor();
    configureVue(v);

    const calls: string[] = [];
    const Cached = v.defineVaporComponent({
      setup() {
        v.onDeactivated(() => calls.push('deactivated'));
        v.onActivated(() => calls.push('activated'));
        v.onUnmounted(() => calls.push('unmounted'));
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

    show.value = false;
    await v.nextTick();
    show.value = true;
    await v.nextTick();

    // A re-created component would re-register a fresh hook and make the guard question moot.
    expect(calls).toEqual(['activated', 'deactivated', 'activated']);

    app.unmount();
    host.remove();
  });
});
