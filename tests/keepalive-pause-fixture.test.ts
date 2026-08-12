// @vitest-environment happy-dom
/**
 * FIXTURE — what Vue's KeepAlive scope-pausing (#15237) does and does NOT
 * suppress, measured on vue@3.6.0-rc.3.
 *
 * WHY. `docs/router.md` carries this note about `tryKeepAliveHooks` in
 * `src/chamber.ts`:
 *
 *   "it hand-solves what #15237 proposes doing natively, so if that lands the
 *    manual pause/resume becomes double-suppression and should be removed in
 *    the same release."
 *
 * #15237 has since landed (closed 2026-08-10; scope pausing propagated through
 * EffectScope/ReactiveEffect, suppressing queued watcher and render jobs while
 * a KeepAlive branch is deactivated). Taken at face value, the note is a
 * standing instruction to delete the guard in `useCommandHistory` and
 * `useCommandError`.
 *
 * It is wrong, and this fixture is why. Vue pauses REACTIVE EFFECTS owned by
 * the deactivated scope. `tryKeepAliveHooks` guards a `bus.onAfter` hook —
 * a plain callback the command bus invokes synchronously inside `dispatch`,
 * held in the bus's own hook array, owned by no scope and scheduled by no
 * scheduler. Nothing upstream can suppress it, because upstream cannot see it.
 *
 * The two mechanisms also answer different questions:
 *   Vue's       — "should this cached component re-render / re-run watchers
 *                  while it is off-screen?"   (a rendering concern)
 *   ours        — "should a command dispatched while this component is
 *                  deactivated be RECORDED into its undo history?"
 *                  (a domain concern — the history would otherwise fill with
 *                  commands the user never performed in that view)
 *
 * So the guard is not redundant and is not double-suppression. The note is
 * corrected rather than obeyed; this file is the evidence, so the question
 * does not get re-litigated from a changelog line next release.
 */

import { describe, expect, it } from 'vitest';

const WITH_VAPOR = 'vue/dist/vue.runtime-with-vapor.esm-browser.js';

type Api = {
  effectScope: () => {
    run: <T>(fn: () => T) => T;
    pause: () => void;
    resume: () => void;
    stop: () => void;
  };
  shallowRef: <T>(v: T) => { value: T };
  watch: (src: () => unknown, cb: (v: unknown) => void, opts?: Record<string, unknown>) => void;
  nextTick: () => Promise<void>;
};

async function vue(): Promise<Api> {
  return (await import(/* @vite-ignore */ WITH_VAPOR)) as unknown as Api;
}

describe('what a paused effect scope suppresses (rc.3)', () => {
  it('DOES suppress a watcher owned by the scope — this is what #15237 fixed', async () => {
    const { effectScope, shallowRef, watch, nextTick } = await vue();

    const source = shallowRef(0);
    const runs: number[] = [];

    const scope = effectScope();
    scope.run(() => {
      watch(() => source.value, (v) => { runs.push(v as number); });
    });

    source.value = 1;
    await nextTick();
    expect(runs).toEqual([1]);

    // Deactivation, as KeepAlive now performs it.
    scope.pause();
    source.value = 2;
    await nextTick();

    // MEASURED: the watcher does not run while paused. This is exactly the
    // class of work Vue took over — and it is not the class of work
    // tryKeepAliveHooks guards.
    expect(runs).toEqual([1]);

    scope.resume();
    await nextTick();
    expect(runs).toEqual([1, 2]);

    scope.stop();
  });

  it('does NOT suppress a plain callback invoked directly — the shape bus.onAfter has', async () => {
    const { effectScope, shallowRef } = await vue();

    // Stand-in for the bus's hook array: a callback held outside any scope and
    // called synchronously by the dispatcher, exactly as command-bus.ts does.
    const hooks: Array<(action: string) => void> = [];
    const recorded: string[] = [];

    const scope = effectScope();
    const state = shallowRef<string[]>([]);

    scope.run(() => {
      // What useCommandHistory does: register an onAfter hook that WRITES a
      // signal. The write is reactive; the callback that performs it is not.
      hooks.push((action) => {
        recorded.push(action);
        state.value = [...state.value, action];
      });
    });

    const dispatch = (action: string) => { for (const h of hooks) h(action); };

    dispatch('cartAdd');
    expect(recorded).toEqual(['cartAdd']);

    scope.pause();
    dispatch('cartRemove');

    // MEASURED and load-bearing: pausing the scope did NOT stop the hook.
    // Without our own `paused` flag, a command dispatched while the component
    // is deactivated still lands in its undo history. `tryKeepAliveHooks` is
    // therefore doing real, non-duplicated work.
    expect(recorded).toEqual(['cartAdd', 'cartRemove']);
    expect(state.value).toEqual(['cartAdd', 'cartRemove']);

    scope.stop();
  });

  it('a stopped scope still does not stop the callback — only unsubscribing does', async () => {
    const { effectScope } = await vue();

    const hooks: Array<() => void> = [];
    let calls = 0;

    const scope = effectScope();
    scope.run(() => { hooks.push(() => { calls++; }); });

    scope.stop();
    for (const h of hooks) h();

    // The corollary: teardown is ours too. `onScopeDispose` fires and our
    // `dispose()` calls the bus unsubscribe — the scope ending is not by
    // itself what detaches the hook.
    expect(calls).toBe(1);
  });
});
