/**
 * untracked() under production-bundle conditions: the runtime probe's bare import('@vue/reactivity') can fail, a DEV diagnostic points at vapor-chamber/vue, and importing that subpath wires the tracking primitives at build time.
 * Why: in a built browser bundle the bare specifier cannot resolve, so untracked() would quietly become a pass-through; a dispatch inside an effect would then leak the handler's reads and a component would re-render on state it never mentions, with no error.
 * Shows: with the probe failing untracked() still runs its callback; the diagnostic fires once on the probe path and at the first composable call, names what is lost, claims only untracked() after configureVue(), and stays silent after importing the subpath or when Vue is absent; enableVueReactivity() and a bare import of the subpath each give real suspend and resume on @vue/reactivity with the probe disabled.
 * See: tests/vapor-sfc-prod-detection.test.ts, tests/root-only-prod-fixture.test.ts
 */

import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';

/** What a browser does with `import('@vue/reactivity')` in a built bundle. */
function makeBareSpecifierUnresolvable(): void {
  vi.doMock('@vue/reactivity', () => {
    throw new Error("Failed to resolve module specifier '@vue/reactivity'.");
  });
}

/**
 * `vue` that resolves but yields nothing usable: applyVueModule() skips every assignment, so the probe cannot wire untracked() while the subpath's real @vue/reactivity import still can.
 * The keys come from the real module because vitest rejects a static import of a name missing from the mock; the values are all undefined.
 */
function makeVueYieldNothing(): void {
  vi.doMock('vue', async (importOriginal) => {
    const actual = (await importOriginal()) as Record<string, unknown>;
    return Object.fromEntries(Object.keys(actual).map((k) => [k, undefined]));
  });
}

describe('untracked() under production-bundle conditions', () => {
  // The probe-path hint needs a window (a server resolves the probe in production); stubbed in every case so silent cases are silent for their own reason.
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
    // Vue itself resolves, so this is "Vue present, probe dead", not "no Vue".
    await chamber.waitForVueDetection();

    let ran = 0;
    expect(chamber.untracked(() => { ran++; return 'value'; })).toBe('value');
    expect(ran).toBe(1); // still runs the callback - degradation, not breakage
  });

  it('DEV diagnostic fires on the PROBE PATH, while the probe is still working', async () => {
    // The warning keys off Vue arriving at runtime, not off probe failure: failure only happens in production, where DEV is false and nothing logs.
    // No mocking: the probe succeeds and the warning still fires.
    vi.resetModules();
    const chamber = await import('../src/chamber');
    await chamber.waitForVueDetection();

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    chamber.untracked(() => 0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/build time/);
    expect(warn.mock.calls[0][0]).toMatch(/vapor-chamber\/vue/);

    // One-shot: untracked() is on the dispatch path, so a per-call warning would flood.
    chamber.untracked(() => 0);
    chamber.untracked(() => 0);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('DEV diagnostic also fires at the FIRST COMPOSABLE CALL, before any dispatch', async () => {
    // A component that never dispatches loses reactivity, cleanup and the KeepAlive guard too, so the warning cannot wait for untracked().
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
    // Names all three losses of a root-only consumer, not only untracked().
    expect(msgs[0]).toMatch(/reactivity/);
    expect(msgs[0]).toMatch(/cleanup/);
    expect(msgs[0]).toMatch(/KeepAlive/);
    expect(msgs[0]).toMatch(/vapor-chamber\/vue/);
  });

  it('after a hand configureVue(), it claims only what is really lost: untracked()', async () => {
    // configureVue() wires everything but the tracking primitives (not on the `vue` entry), so the warning must not overclaim.
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
    // Mocking @vue/reactivity would also break the static import in src/vue.ts, so the probe is disabled via an empty `vue` instead.
    makeVueYieldNothing();
    vi.resetModules();

    const chamber = await import('../src/chamber');
    await chamber.waitForVueDetection();

    const { enableVueReactivity } = await import('../src/vue');
    enableVueReactivity();

    // Real @vue/reactivity, not a stub: a read inside untracked() must not become a dependency of the effect.
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
    // Importing from vapor-chamber/vue evaluates the module body, which is the wiring; the probe is disabled as above.
    makeVueYieldNothing();
    vi.resetModules();

    const chamber = await import('../src/chamber');
    await chamber.waitForVueDetection();

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

    // The subpath re-exports the root's function, not a second copy.
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
