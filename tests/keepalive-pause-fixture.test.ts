// @vitest-environment happy-dom
/**
 * What a paused Vue effect scope suppresses and does not suppress, with a bare `effectScope()` standing in for KeepAlive deactivation.
 * Why: Vue pauses reactive effects owned by a deactivated scope, but a `bus.onAfter` hook is a plain
 * callback in the bus's own array, owned by no scope. The `tryKeepAliveHooks` guard in
 * `useCommandHistory` / `useCommandError` is therefore not double-suppression, and a command
 * dispatched while a cached view is deactivated would otherwise land in its undo history.
 * Shows: pause() suppresses a scope-owned watcher until resume(), a plain callback registered inside
 * the scope still runs while paused, and a stopped scope does not stop such a callback either.
 * See: vuejs/core#15237, docs/router.md, tests/keepalive-input-scope-fixture.test.ts
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
  it('DOES suppress a watcher owned by the scope - this is what #15237 fixed', async () => {
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

    scope.pause();
    source.value = 2;
    await nextTick();

    // Vue's pausing covers scope-owned reactive work, not what tryKeepAliveHooks guards.
    expect(runs).toEqual([1]);

    scope.resume();
    await nextTick();
    expect(runs).toEqual([1, 2]);

    scope.stop();
  });

  it('does NOT suppress a plain callback invoked directly - the shape bus.onAfter has', async () => {
    const { effectScope, shallowRef } = await vue();

    // Stand-in for the bus's hook array: held outside any scope, called synchronously by the dispatcher.
    const hooks: Array<(action: string) => void> = [];
    const recorded: string[] = [];

    const scope = effectScope();
    const state = shallowRef<string[]>([]);

    scope.run(() => {
      // Like useCommandHistory: the signal write is reactive, the callback performing it is not.
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

    // Pausing the scope does not stop the hook, so the guard's own `paused` flag is the only suppression.
    expect(recorded).toEqual(['cartAdd', 'cartRemove']);
    expect(state.value).toEqual(['cartAdd', 'cartRemove']);

    scope.stop();
  });

  it('a stopped scope still does not stop the callback - only unsubscribing does', async () => {
    const { effectScope } = await vue();

    const hooks: Array<() => void> = [];
    let calls = 0;

    const scope = effectScope();
    scope.run(() => { hooks.push(() => { calls++; }); });

    scope.stop();
    for (const h of hooks) h();

    expect(calls).toBe(1);
  });
});
