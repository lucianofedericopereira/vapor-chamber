// @vitest-environment happy-dom
/**
 * FIXTURE — `tryKeepAliveHooks` against a REAL VaporKeepAlive, vue@3.6.0-rc.4.
 *
 * WHY THIS FILE EXISTS, given we already have one. rc.3 gave us
 * `tests/keepalive-pause-fixture.test.ts`, which measured a bare
 * `effectScope().pause()` as a stand-in for KeepAlive deactivation and
 * concluded the guard in `useCommandHistory` / `useCommandError` is NOT
 * double-suppression. rc.4's #15293 (cd8b8da) rewrites precisely the machinery
 * that stand-in was standing in for:
 *
 *   rc.3  deactivate() paused the KeepAlive BRANCH scope, which owned the
 *         cached component's raw prop/slot commit effects.
 *   rc.4  those commit effects move into a new per-instance `inputScope`
 *         (`VaporComponentInstance.inputScope`), and `activate()`/`deactivate()`
 *         resume/pause THAT scope. The branch scope pause now, in Vue's own
 *         revised comment, "only pauses branch-owned effects".
 *
 * So the pausing got NARROWER and moved to a different owner. A stand-in built
 * on generic scope semantics can no longer, by itself, settle the question —
 * it measures a mechanism Vue no longer uses on this path. Rather than argue
 * the conclusion still holds, this file measures the real thing: a real
 * `VaporKeepAlive`, a real cached Vapor component, and the real shipped
 * `useCommandHistory`, on rc.4.
 *
 * WHAT MEASURING IT ACTUALLY FOUND. The rc.3 conclusion survives — but the
 * guard it defended was never running under Vapor. `tryKeepAliveHooks` gated
 * itself on `getCurrentInstance()`, which reads VDOM's `currentInstance`; a
 * Vapor component is not stored there, so the guard returned early in every
 * Vapor component and `useCommandHistory` / `useCommandError` recorded
 * commands dispatched while deactivated. The stand-in fixture could not see
 * this, because a bare `effectScope()` never exercised our guard at all.
 * Verified pre-existing, not an rc.4 regression: with the old guard restored
 * this file fails identically on rc.3 and rc.4. Fixed in `chamber.ts` by
 * probing `hasInjectionContext()` instead.
 *
 * WHAT IT PINS. Two facts, and the second is the load-bearing one:
 *
 *   1. Our guard works on rc.4 — a command dispatched while the component is
 *      deactivated does not enter that component's undo history, and recording
 *      resumes on reactivation.
 *   2. An UNGUARDED `bus.onAfter` hook registered by the same cached component
 *      still fires while that component is deactivated. That is the fact the
 *      whole argument rests on: if rc.4's finer-grained pausing had begun
 *      reaching plain bus callbacks, the guard WOULD now be double-suppression
 *      and `docs/router.md`'s old delete-it instruction would finally be right.
 *      It does not, so it is not, and #2 is what would break first if a future
 *      release changed that.
 *
 * Everything is imported from the single with-vapor browser build, and the
 * chamber is pointed at that same module object via `configureVue()` — two
 * separately-imported Vue dists are two disconnected reactivity instances
 * (chamber.ts §probeVue), so skipping that would silently measure nothing:
 * `onDeactivated` would register on an instance our chamber never sees.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { configureVue, getCommandBus, setCommandBus, useCommandHistory } from '../src/chamber';
import { createCommandBus } from '../src/command-bus';

const WITH_VAPOR = 'vue/dist/vue.runtime-with-vapor.esm-browser.js';

/** Raw runtime-vapor surface — deliberately untyped; this file builds a component tree by hand. */
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
    // Same module object the components below are built from — otherwise our
    // onDeactivated lands on a different reactivity instance and no-ops.
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

    // --- active -------------------------------------------------------------
    bus.dispatch('cartAdd', 'a');
    expect(history.past.value.map((c) => c.action)).toEqual(['cartAdd']);
    expect(unguarded).toEqual(['cartAdd']);

    // --- deactivated (cached, not unmounted) --------------------------------
    show.value = false;
    await v.nextTick();
    expect(host.textContent).toContain('other');

    bus.dispatch('cartAdd', 'b');

    // FACT 1 — the guard holds on rc.4. `b` was dispatched in a view the user
    // was not looking at; it must not land in that view's undo history.
    expect(history.past.value.map((c) => c.target)).toEqual(['a']);

    // FACT 2 — and it is doing real work: the identically-scoped UNGUARDED
    // hook did fire. rc.4 pauses the instance's `inputScope` (prop/slot commit
    // effects); a bus hook is a plain callback in the bus's own array, owned by
    // no scope and scheduled by no scheduler, so nothing upstream can suppress
    // it. If this assertion ever flips, the guard has become redundant and
    // docs/router.md's original delete-it note becomes correct.
    expect(unguarded).toEqual(['cartAdd', 'cartAdd']);

    // --- reactivated --------------------------------------------------------
    show.value = true;
    await v.nextTick();
    expect(host.textContent).toContain('cached');

    bus.dispatch('cartAdd', 'c');

    // Recording resumes — onActivated cleared the flag. The command dispatched
    // while away stays absent; it is not replayed on activation.
    expect(history.past.value.map((c) => c.target)).toEqual(['a', 'c']);

    app.unmount();
    host.remove();
  });

  it('the cached component is deactivated, not unmounted — the premise of the above', async () => {
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

    // If KeepAlive had merely unmounted and re-created the component, the whole
    // question above would be moot (a new instance re-registers a fresh hook).
    // It does not: one activation cycle, no unmount.
    expect(calls).toEqual(['activated', 'deactivated', 'activated']);

    app.unmount();
    host.remove();
  });
});
