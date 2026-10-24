// A composable's busy state is the bus's per-key `pending`, never its own count; rationale at the end.
import { beforeAll, describe, expect, it } from 'vitest';
import { effectScope } from 'vue';
import { useCommand, useCommandQuery, useSharedCommandState, waitForVueDetection } from '../src/chamber';
import { useVaporAsyncCommand } from '../src/chamber-vapor';
import { createAsyncCommandBus, createCommandBus, type BaseBus } from '../src/command-bus';

// A scope releases its handles only once Vue is detected (onScopeDispose).
beforeAll(() => waitForVueDetection());

function deferred<T = unknown>() {
  let resolve!: (x: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

/** Is the bus's command state still held? A fresh holder reads the same key's signal only then. */
function held(bus: BaseBus, flag: object, action: string, target?: unknown): boolean {
  const probe = useSharedCommandState({ bus });
  const same = probe.pending(action, target) === flag;
  probe.dispose();
  return same;
}

describe('useCommand().pending', () => {
  it('two buttons on one useCommand go busy apart: each reads its own key', async () => {
    const bus = createAsyncCommandBus();
    const gates: Record<number, ReturnType<typeof deferred>> = {};
    bus.register('cartAdd', (cmd) => (gates[cmd.target.id] = deferred()).promise);
    const scope = effectScope();
    const cmd = scope.run(() => useCommand({ bus }))!;
    const first = cmd.pending('cartAdd', { id: 1 });
    const second = cmd.pending('cartAdd', { id: 2 });
    const p = cmd.dispatch('cartAdd', { id: 1 });
    expect({ first: first.value, second: second.value }).toEqual({ first: true, second: false });
    await Promise.resolve();
    gates[1].resolve('ok');
    await p;
    expect({ first: first.value, second: second.value }).toEqual({ first: false, second: false });
    scope.stop();
  });

  it('counts a dispatch from any caller, and is released with the scope', () => {
    const bus = createCommandBus();
    let during = false;
    bus.register('save', () => { during = flag.value; });
    const scope = effectScope();
    const cmd = scope.run(() => useCommand({ bus }))!;
    const flag = cmd.pending('save');
    bus.dispatch('save', undefined);
    expect({ during, after: flag.value, held: held(bus, flag, 'save') }).toEqual({ during: true, after: false, held: true });
    scope.stop();
    expect(held(bus, flag, 'save')).toBe(false);
  });

  it('a throw (onMissing: throw) is still a failed result, on both buses (control)', async () => {
    const sync = createCommandBus({ onMissing: 'throw' });
    const scope = effectScope();
    const a = scope.run(() => useCommand({ bus: sync }))!;
    expect(a.dispatch('missing', null)).toMatchObject({ ok: false });
    const async = createAsyncCommandBus({ onMissing: 'throw' });
    const b = scope.run(() => useCommand({ bus: async }))!;
    expect(await b.dispatch('missing', null)).toMatchObject({ ok: false });
    scope.stop();
  });
});

describe('useVaporAsyncCommand().pending', () => {
  it('reads the key of its own dispatch, and is released with the scope', async () => {
    const bus = createAsyncCommandBus();
    const gate = deferred();
    bus.register('orderCreate', () => gate.promise);
    const scope = effectScope();
    const v = scope.run(() => useVaporAsyncCommand(bus))!;
    const creating = v.pending('orderCreate');
    const p = v.dispatch('orderCreate', undefined);
    expect(creating.value).toBe(true);
    gate.resolve('ok');
    expect(await p).toMatchObject({ ok: true, value: 'ok' });
    expect(creating.value).toBe(false);
    scope.stop();
    expect(held(bus, creating, 'orderCreate')).toBe(false);
  });
});

describe('the composables\' shapes', () => {
  it('useCommand and useVaporAsyncCommand hold no busy or error state of their own; useCommandQuery keeps its loading', () => {
    const bus = createAsyncCommandBus();
    const scope = effectScope();
    const shapes = scope.run(() => ({
      command: Object.keys(useCommand({ bus })).sort(),
      vapor: Object.keys(useVaporAsyncCommand(bus)).sort(),
      query: Object.keys(useCommandQuery({ bus })).sort(),
    }));
    scope.stop();
    expect(shapes).toEqual({
      command: ['dispatch', 'dispose', 'emit', 'on', 'pending', 'register'],
      vapor: ['dispatch', 'dispose', 'pending'],
      query: ['data', 'loading', 'query'],
    });
  });
});

/*
 * Why this file exists. `loading` named three facts (capacity C18):
 * useCommand's and useVaporAsyncCommand's own dispatches, the shared state's
 * wrapper, and a key bus-wide. vapor-sfc's CartPanel had two buttons on one
 * useCommand, so both went busy. Plan 1.32 5 removes the per-composable count:
 * a button reads the key it dispatches, `pending(action, target)`, the bus's
 * command state (src/command-state.ts). `lastError` keeps one meaning too,
 * the bus-wide one: a dispatch's own failure is its result. useCommandQuery
 * keeps `loading`, since a query is a read and the command state never counts
 * one. `held()` is the release check: a fresh holder reads the same signal
 * only while the state is held, and the true case is its positive control.
 */
