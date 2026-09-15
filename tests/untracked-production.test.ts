/**
 * FIXTURE - untracked() in a production bundle.
 *
 * `untracked()` reaches Vue's tracking primitives through a bare
 * `import('@vue/reactivity')`. That resolves under a dev server and resolves in
 * vitest, which is why the suite never saw the problem: in a BUILT browser
 * bundle there is no import map, the specifier has nothing to resolve against,
 * and the rejection lands in an empty catch. `untracked()` then quietly becomes
 * a pass-through, so a `dispatch()` inside a reactive effect leaks the
 * handler's reads into that effect - a component re-rendering on state it never
 * mentions, with no error anywhere.
 *
 * Same root cause as the Vapor-detection gap in
 * `tests/vapor-sfc-prod-detection.test.ts`: a specifier resolved at runtime
 * that only a dev server can resolve.
 *
 * The fix is to resolve it at BUILD time instead - `vapor-chamber/vue`
 * statically imports the primitives and hands them to the core.
 */

import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';

/** What a browser does with `import('@vue/reactivity')` in a built bundle. */
function makeBareSpecifierUnresolvable(): void {
  vi.doMock('@vue/reactivity', () => {
    throw new Error("Failed to resolve module specifier '@vue/reactivity'.");
  });
}

/**
 * `vue` that resolves but yields nothing usable.
 *
 * The named exports have to EXIST or vitest rejects the static imports in
 * src/vue.ts; being `undefined` is what makes `applyVueModule()` skip every
 * assignment, leaving `_vueDeepRefFn` null so the probe's `wireUntracked()`
 * returns before its dynamic import. Net effect: the probe cannot wire
 * `untracked()`, while the subpath's real `@vue/reactivity` import still can.
 *
 * THE KEY SET IS DERIVED, NOT TRANSCRIBED. This used to be a hand-written list
 * of eight names mirroring `src/vue.ts`'s imports, which made it a staleness
 * trap: adding a name there and not here fails with vitest's "No X export is
 * defined on the vue mock" - a mock-maintenance error wearing the costume of a
 * product bug. v1.17.0's `hasInjectionContext` addition tripped exactly that.
 *
 * Taking the keys from the real module removes the duplication at the source.
 * Every name `src/vue.ts` can legally import must exist on real `vue` anyway, so
 * a derived key set is complete by construction and cannot drift. The VALUES are
 * all `undefined`, which is what makes `applyVueModule()` skip every assignment.
 */
function makeVueYieldNothing(): void {
  vi.doMock('vue', async (importOriginal) => {
    const actual = (await importOriginal()) as Record<string, unknown>;
    return Object.fromEntries(Object.keys(actual).map((k) => [k, undefined]));
  });
}

describe('untracked() under production-bundle conditions', () => {
  // A PAGE, every case: the probe-path hint needs a `window`, since a server
  // resolves the probe in production too (tests/root-only-prod-fixture.test.ts).
  // Stubbed for the cases that expect silence as well, so they stay quiet for
  // their own reason rather than for want of a window.
  beforeEach(() => {
    vi.stubGlobal('window', globalThis);
  });

  afterEach(() => {
    vi.doUnmock('@vue/reactivity');
    vi.doUnmock('vue');
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('REGRESSION: probe fails -> pass-through, silently', async () => {
    makeBareSpecifierUnresolvable();
    vi.resetModules();

    const chamber = await import('../src/chamber');
    // Vue itself resolves (vitest), so the library believes Vue is present -
    // this is the "Vue is here but untracked is dead" state, not "no Vue".
    await chamber.waitForVueDetection();

    let ran = 0;
    expect(chamber.untracked(() => { ran++; return 'value'; })).toBe('value');
    expect(ran).toBe(1); // still runs the callback - degradation, not breakage
  });

  it('DEV diagnostic fires on the PROBE PATH, while the probe is still working', async () => {
    // The trigger that matters. An earlier version of this diagnostic keyed off
    // observed failure, which made it near-dead code: probe failure is only
    // reachable in a production bundle, where DEV is false and nothing can be
    // logged. Keying it to "Vue arrived at runtime rather than at build time"
    // makes it fire under the dev server - the one place a developer can still
    // see it and change one import.
    //
    // No mocking: `vue` resolves, the probe SUCCEEDS, untracked() genuinely
    // suspends. The warning fires anyway, because this bundle will not survive
    // being built.
    vi.resetModules();
    const chamber = await import('../src/chamber');
    await chamber.waitForVueDetection();

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    chamber.untracked(() => 0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/build time/);
    expect(warn.mock.calls[0][0]).toMatch(/vapor-chamber\/vue/);

    // One-shot: untracked() is on the dispatch path and every composable routes
    // through it, so per-call would be a flood.
    chamber.untracked(() => 0);
    chamber.untracked(() => 0);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('DEV diagnostic also fires at the FIRST COMPOSABLE CALL, before any dispatch', async () => {
    // A component that only registers handlers or listens never dispatches,
    // and it loses reactivity, cleanup and the KeepAlive guard in production
    // just the same. So the warning cannot wait for untracked().
    vi.resetModules();
    const chamber = await import('../src/chamber');
    const { createCommandBus } = await import('../src/command-bus');
    await chamber.waitForVueDetection();
    chamber.setCommandBus(createCommandBus());

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { effectScope } = await import('vue');
    const scope = effectScope();
    scope.run(() => chamber.useCommand()); // no dispatch anywhere
    scope.stop();

    const msgs = warn.mock.calls.map((c) => String(c[0])).filter((m) => /build time/.test(m));
    expect(msgs).toHaveLength(1);
    // Names all three consequences a root-only consumer loses, not only untracked().
    expect(msgs[0]).toMatch(/reactivity/);
    expect(msgs[0]).toMatch(/cleanup/);
    expect(msgs[0]).toMatch(/KeepAlive/);
    expect(msgs[0]).toMatch(/vapor-chamber\/vue/);
  });

  it('after a hand configureVue(), it claims only what is really lost: untracked()', async () => {
    // configureVue() wires reactivity, cleanup and the KeepAlive guard in a
    // production bundle too; only the tracking primitives are missing (they
    // are not on the `vue` entry). The warning must not overclaim.
    vi.resetModules();
    const chamber = await import('../src/chamber');
    await chamber.waitForVueDetection();
    chamber.configureVue(await import('vue'));

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    chamber.untracked(() => 0);
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = String(warn.mock.calls[0][0]);
    expect(msg).toMatch(/untracked\(\) degrades/);
    expect(msg).not.toMatch(/KeepAlive/);
  });

  it('importing the subpath silences it - that is the whole signal', async () => {
    vi.resetModules();
    const chamber = await import('../src/chamber');
    await import('../src/vue'); // build-time wiring present
    await chamber.waitForVueDetection();

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    chamber.untracked(() => 0);
    expect(warn).not.toHaveBeenCalled();
  });

  it('FIXED by enableVueReactivity(): real suspend/resume with the probe dead', async () => {
    // Mocking `@vue/reactivity` is not an option here: it would break the
    // STATIC import in src/vue.ts too, and that is not what a production bundle
    // does - there the static import was resolved at build time and only the
    // runtime specifier fails. Module mocks cannot tell the two apart.
    //
    // So the probe is disabled from the other end. `vue` resolves to an EMPTY
    // module, so `applyVueModule()` finds nothing, `_vueDeepRefFn` stays null,
    // and the probe's `wireUntracked()` returns before it reaches its dynamic
    // import. The subpath's own static imports still resolve for real, which
    // makes it the only thing that can possibly wire `untracked()`.
    makeVueYieldNothing();
    vi.resetModules();

    const chamber = await import('../src/chamber');
    await chamber.waitForVueDetection();

    const { enableVueReactivity } = await import('../src/vue');
    enableVueReactivity();

    // MEASURED against real Vue reactivity, not a stub: a read performed inside
    // untracked() must NOT become a dependency of the surrounding effect.
    const { ref, effect } = await import('@vue/reactivity');
    const tracked = ref(0);
    const untrackedRef = ref(0);
    let runs = 0;

    effect(() => {
      runs++;
      void tracked.value;
      chamber.untracked(() => void untrackedRef.value);
    });
    expect(runs).toBe(1);

    untrackedRef.value++;      // read inside untracked() - must not re-run
    expect(runs).toBe(1);

    tracked.value++;           // ordinary dependency - must re-run
    expect(runs).toBe(2);
  });

  it('IMPORT ALONE wires it - no enableVueReactivity() call, probe dead', async () => {
    // The point of the subpath: there is nothing to forget. Importing a
    // composable from `vapor-chamber/vue` evaluates the module, and the module
    // body IS the wiring. Probe disabled the same way as above (unresolvable
    // `vue`), so nothing else can be doing this.
    makeVueYieldNothing();
    vi.resetModules();

    const chamber = await import('../src/chamber');
    await chamber.waitForVueDetection();

    // No enableVueReactivity(). Just take the composable surface.
    const { untracked } = await import('../src/vue');

    const { ref, effect } = await import('@vue/reactivity');
    const tracked = ref(0);
    const hidden = ref(0);
    let runs = 0;

    effect(() => {
      runs++;
      void tracked.value;
      untracked(() => void hidden.value);
    });
    expect(runs).toBe(1);

    hidden.value++;
    expect(runs).toBe(1); // suspended - the import did the wiring

    tracked.value++;
    expect(runs).toBe(2);

    // And it is the SAME function the root exports, not a second copy - a mixed
    // codebase must not end up with two of anything.
    expect(untracked).toBe(chamber.untracked);
  });

  it('no warning when Vue is simply absent - that pass-through is correct', async () => {
    makeBareSpecifierUnresolvable();
    vi.doMock('vue', () => { throw new Error("Failed to resolve module specifier 'vue'."); });
    vi.resetModules();

    const chamber = await import('../src/chamber');
    await chamber.waitForVueDetection();

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(chamber.untracked(() => 'x')).toBe('x');
    expect(warn).not.toHaveBeenCalled();
  });
});
