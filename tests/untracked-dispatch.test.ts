// @vitest-environment node
/**
 * A dispatch is an ACTION, not a read — so nothing it touches should become a
 * reactive dependency of whatever happened to call it.
 *
 * THE BUG. A dispatch made from inside a Vue effect ran the handler with the
 * caller's subscriber still active, so every reactive value the HANDLER read
 * was collected as a dependency of the CALLER's effect. A component
 * dispatching from a `watchEffect` then re-ran whenever state it never
 * mentions changed — silently, and worse the more state the handler touches.
 * Vue hit the same class twice in 3.6.0-rc.3 (#15203 v-show transition hooks,
 * #15204 v-show source in fragment effects) and fixed both by suspending
 * tracking around the callback.
 *
 * WHERE THE FIX LIVES, AND WHY NOT THE CORE. It is applied in `chamber.ts`,
 * the Vue layer, not in `command-bus.ts`. Putting it in the core meant a
 * runtime branch in a module the whitepaper §19 guarantee calls
 * "framework-agnostic — always", and `tests/esm-treeshake.test.ts` objected in
 * the only language it has: a Vue-free Blade consumer bundle grew 35 bytes for
 * a Vue-only concern. Whether Vue is present is settled when the bundle is
 * built, so paying a per-dispatch runtime check for it is the wrong trade.
 *
 * The default therefore covers every path a component actually uses —
 * `useCommand`, `useCommandGroup`, `useSharedCommandState`, `useCommandQuery`
 * — at zero cost to the core and zero bytes to consumers without Vue. The one
 * gap, calling a **raw bus** from inside an effect, has a documented one-line
 * answer: wrap it in the exported `untracked()`.
 *
 * `untracked()` is backed by `@vue/reactivity`'s `pauseTracking`/
 * `resetTracking` — not `vue`, which does not expose them (verified on
 * 3.6.0-rc.3) — and that package resolves to the *same module instance* Vue
 * itself uses; a second copy would toggle unrelated state and silently do
 * nothing.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { createCommandBus, createAsyncCommandBus } from '../src/command-bus';
import {
  untracked,
  setCommandBus,
  resetCommandBus,
  useCommand,
  useCommandGroup,
  useSharedCommandState,
  waitForVueDetection,
} from '../src/chamber';

const VUE = 'vue';
type V = { shallowRef: any; watchEffect: any; nextTick: any; effectScope: any };
let vue: V;

beforeAll(async () => {
  vue = (await import(/* @vite-ignore */ VUE)) as unknown as V;
  // The composables' untracking is wired by the same probe that wires
  // signal() — nothing in these tests reaches past the public surface.
  await waitForVueDetection();
});

afterEach(() => { resetCommandBus(); });

describe('the raw bus leaks — which is what untracked() is for', () => {
  it('BASELINE: a bare bus.dispatch inside an effect DOES leak handler reads', async () => {
    const { shallowRef, watchEffect, nextTick, effectScope } = vue;
    const bus = createCommandBus();
    const unrelated = shallowRef('a');
    bus.register('probe', () => unrelated.value);

    let runs = 0;
    const scope = effectScope();
    scope.run(() => watchEffect(() => { runs++; bus.dispatch('probe', {}); }));
    await nextTick();
    expect(runs).toBe(1);

    unrelated.value = 'b';
    await nextTick();

    // Pinned deliberately: this is the residual gap the docs describe, and the
    // reason `untracked()` is exported rather than being an internal detail.
    expect(runs).toBe(2);
    scope.stop();
  });

  it('untracked() closes it — one line at the call site', async () => {
    const { shallowRef, watchEffect, nextTick, effectScope } = vue;
    const bus = createCommandBus();
    const unrelated = shallowRef('a');
    bus.register('probe', () => unrelated.value);

    let runs = 0;
    const scope = effectScope();
    scope.run(() => watchEffect(() => { runs++; untracked(() => bus.dispatch('probe', {})); }));
    await nextTick();
    expect(runs).toBe(1);

    unrelated.value = 'b';
    await nextTick();
    expect(runs).toBe(1);

    unrelated.value = 'c';
    await nextTick();
    expect(runs).toBe(1);
    scope.stop();
  });

  it('untracked() returns the value and propagates throws', () => {
    expect(untracked(() => 42)).toBe(42);
    expect(() => untracked(() => { throw new Error('boom'); })).toThrow('boom');
    // Tracking must be restored even on the throwing path — if `resetTracking`
    // were skipped, every later read in the process would go uncollected.
    expect(untracked(() => 7)).toBe(7);
  });
});

describe('composables untrack by default', () => {
  it('useCommand().dispatch does not leak handler reads', async () => {
    const { shallowRef, watchEffect, nextTick, effectScope } = vue;
    const bus = createCommandBus();
    setCommandBus(bus);
    const unrelated = shallowRef('a');
    bus.register('probe', () => unrelated.value);

    let runs = 0;
    const scope = effectScope();
    scope.run(() => {
      const { dispatch } = useCommand();
      watchEffect(() => { runs++; dispatch('probe' as never, {} as never); });
    });
    await nextTick();
    expect(runs).toBe(1);

    unrelated.value = 'b';
    await nextTick();
    expect(runs).toBe(1);
    scope.stop();
  });

  it('useCommandGroup().dispatch / query / emit do not leak', async () => {
    const { shallowRef, watchEffect, nextTick, effectScope } = vue;
    const bus = createCommandBus();
    setCommandBus(bus);
    const unrelated = shallowRef('a');
    bus.register('cartAdd', () => unrelated.value);
    bus.register('cartRead', () => unrelated.value);
    bus.on('cartPing', () => { void unrelated.value; });

    let runs = 0;
    const scope = effectScope();
    scope.run(() => {
      const cart = useCommandGroup('cart');
      watchEffect(() => {
        runs++;
        cart.dispatch('add', {});
        cart.query('read', {});
        cart.emit('ping', {});
      });
    });
    await nextTick();
    expect(runs).toBe(1);

    unrelated.value = 'b';
    await nextTick();
    expect(runs).toBe(1);
    scope.stop();
  });

  it('useSharedCommandState().dispatch does not leak', async () => {
    const { shallowRef, watchEffect, nextTick, effectScope } = vue;
    const bus = createCommandBus();
    setCommandBus(bus);
    const unrelated = shallowRef('a');
    bus.register('probe', () => unrelated.value);

    let runs = 0;
    const scope = effectScope();
    scope.run(() => {
      const { dispatch } = useSharedCommandState({ bus });
      watchEffect(() => { runs++; dispatch('probe', {}); });
    });
    await nextTick();
    expect(runs).toBe(1);

    unrelated.value = 'b';
    await nextTick();
    expect(runs).toBe(1);
    scope.stop();
  });

  it('the caller keeps its OWN dependencies — untracking is scoped to the dispatch', async () => {
    const { shallowRef, watchEffect, nextTick, effectScope } = vue;
    const bus = createCommandBus();
    setCommandBus(bus);
    const handlerState = shallowRef('a');
    const callerState = shallowRef(0);
    bus.register('probe', () => handlerState.value);

    let runs = 0;
    const scope = effectScope();
    scope.run(() => {
      const { dispatch } = useCommand();
      watchEffect(() => { runs++; void callerState.value; dispatch('probe' as never, {} as never); });
    });
    await nextTick();
    expect(runs).toBe(1);

    // A fix that swallowed the caller's own reads would be worse than the bug.
    callerState.value = 1;
    await nextTick();
    expect(runs).toBe(2);

    handlerState.value = 'b';
    await nextTick();
    expect(runs).toBe(2);
    scope.stop();
  });

  it('handler WRITES still notify — suspending collection must not suspend propagation', async () => {
    const { shallowRef, watchEffect, nextTick, effectScope } = vue;
    const bus = createCommandBus();
    setCommandBus(bus);
    const state = shallowRef(0);
    bus.register('bump', () => { state.value = state.value + 1; return state.value; });

    let observed = -1;
    let runs = 0;
    const scope = effectScope();
    scope.run(() => watchEffect(() => { runs++; observed = state.value; }));
    await nextTick();

    // This is the shape useCommandState relies on. If untracking broke it,
    // reducer-driven state would stop reaching the UI entirely.
    const scope2 = vue.effectScope();
    scope2.run(() => { const { dispatch } = useCommand(); dispatch('bump' as never, {} as never); });
    await nextTick();
    expect(observed).toBe(1);
    expect(runs).toBe(2);
    scope2.stop();
    scope.stop();
  });

  it('async composable dispatch: the synchronous entry is the whole exposure', async () => {
    const { shallowRef, watchEffect, nextTick, effectScope } = vue;
    const bus = createAsyncCommandBus();
    setCommandBus(bus);
    const unrelated = shallowRef('a');
    bus.register('probe', async () => unrelated.value);

    let runs = 0;
    const scope = effectScope();
    scope.run(() => {
      const { dispatch } = useCommand();
      watchEffect(() => { runs++; void dispatch('probe' as never, {} as never); });
    });
    await nextTick();
    expect(runs).toBe(1);

    unrelated.value = 'b';
    await nextTick();
    await nextTick();

    // By the time an async dispatch resumes in a microtask the caller's effect
    // has finished, so there is no active subscriber left to leak into.
    expect(runs).toBe(1);
    scope.stop();
  });
});
