// @vitest-environment node
/**
 * A dispatch made inside a Vue effect does not make the handler's reactive reads dependencies of the calling effect; the composables untrack by default and a raw bus needs untracked().
 * Why: a dispatch is an action, not a read; if the handler's reads were collected, a component dispatching from a watchEffect would re-run whenever state it never mentions changes.
 * Shows: a bare bus.dispatch in an effect leaks (pinned as the documented gap); untracked() stops the leak, returns the value and rethrows; useCommand, useCommandGroup, defineVaporCommand and useVaporAsyncCommand do not leak; the caller keeps its own dependencies; handler writes still notify; an async dispatch does not leak.
 * See: docs/whitepaper.md section 16, tests/esm-treeshake.test.ts, vuejs/core#15203, vuejs/core#15204
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { createCommandBus, createAsyncCommandBus } from '../src/command-bus';
import {
  untracked,
  setCommandBus,
  resetCommandBus,
  useCommand,
  useCommandGroup,
  waitForVueDetection,
} from '../src/chamber';
import { defineVaporCommand, useVaporAsyncCommand } from '../src/chamber-vapor';

const VUE = 'vue';
type V = { shallowRef: any; watchEffect: any; nextTick: any; effectScope: any };
let vue: V;

beforeAll(async () => {
  vue = (await import(/* @vite-ignore */ VUE)) as unknown as V;
  // The composables' untracking is wired by the same probe that wires signal().
  await waitForVueDetection();
});

afterEach(() => { resetCommandBus(); });

describe('the raw bus leaks - which is what untracked() is for', () => {
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

    // Pinned: the documented gap that `untracked()` is exported to close.
    expect(runs).toBe(2);
    scope.stop();
  });

  it('untracked() closes it - one line at the call site', async () => {
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
    // Only checks untracked() still runs after a throw; tracking state itself is not observed.
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


  it('the caller keeps its OWN dependencies - untracking is scoped to the dispatch', async () => {
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

    // Untracking must not swallow the caller's own reads.
    callerState.value = 1;
    await nextTick();
    expect(runs).toBe(2);

    handlerState.value = 'b';
    await nextTick();
    expect(runs).toBe(2);
    scope.stop();
  });

  it('handler WRITES still notify - suspending collection must not suspend propagation', async () => {
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

    // Reducer-driven state reaches the UI only if handler writes still propagate.
    const scope2 = vue.effectScope();
    scope2.run(() => { const { dispatch } = useCommand(); dispatch('bump' as never, {} as never); });
    await nextTick();
    expect(observed).toBe(1);
    expect(runs).toBe(2);
    scope2.stop();
    scope.stop();
  });

  it('defineVaporCommand().dispatch does not leak handler reads', async () => {
    const { shallowRef, watchEffect, nextTick, effectScope } = vue;
    const bus = createCommandBus();
    setCommandBus(bus);
    const unrelated = shallowRef('a');

    let runs = 0;
    const scope = effectScope();
    scope.run(() => {
      const { dispatch } = defineVaporCommand('probe', () => unrelated.value);
      watchEffect(() => { runs++; dispatch({}); });
    });
    await nextTick();
    expect(runs).toBe(1);

    unrelated.value = 'b';
    await nextTick();
    expect(runs).toBe(1);
    scope.stop();
  });

  it('useVaporAsyncCommand().dispatch does not leak handler reads', async () => {
    const { shallowRef, watchEffect, nextTick, effectScope } = vue;
    const bus = createAsyncCommandBus();
    setCommandBus(bus);
    const unrelated = shallowRef('a');
    // Read before the first await: only the synchronous entry can leak.
    bus.register('probe', async () => unrelated.value);

    let runs = 0;
    const scope = effectScope();
    scope.run(() => {
      const { dispatch } = useVaporAsyncCommand();
      watchEffect(() => { runs++; void dispatch('probe', {}); });
    });
    await nextTick();
    expect(runs).toBe(1);

    unrelated.value = 'b';
    await nextTick();
    await nextTick();
    expect(runs).toBe(1);
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

    // An async dispatch resumes in a microtask after the caller's effect finished, so no subscriber is active.
    expect(runs).toBe(1);
    scope.stop();
  });
});
