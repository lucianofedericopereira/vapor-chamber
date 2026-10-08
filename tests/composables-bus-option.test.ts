// Every bus composable runs on the bus it is given, sync or async; rationale at the end.
import { describe, expect, afterEach } from 'vitest';
import { effectScope } from 'vue';
import * as root from '../src/index';
import {
  createAsyncCommandBus,
  createCommandBus,
  defineVaporCommand,
  getCommandBus,
  resetCommandBus,
  useCommand,
  useCommandError,
  useCommandGroup,
  useCommandHistory,
  useCommandQuery,
  useCommandState,
  useSharedCommandState,
  useTransitionCommand,
  useVaporAsyncCommand,
  type BaseBus,
} from '../src/index';
import * as reactive from '../src/reactive';
import { useDeepCommandState } from '../src/reactive';
import { it } from '../src/vitest';

afterEach(() => resetCommandBus());

/** Uses one composable on `bus` and answers whether it reached that bus. */
type Case = (bus: BaseBus) => Promise<boolean>;

const cases: Record<string, Case> = {
  async useCommand(bus) {
    const c = useCommand({ bus });
    c.register('a', () => 1);
    return (await c.dispatch('a', null)).ok && bus.hasHandler('a');
  },
  async useCommandState(bus) {
    const { state } = useCommandState(0, { a: (s) => s + 1 }, { bus });
    await bus.dispatch('a', null);
    return state.value === 1;
  },
  async useDeepCommandState(bus) {
    const { state } = useDeepCommandState({ n: 0 }, { a: (s) => ({ n: s.n + 1 }) }, { bus });
    await bus.dispatch('a', null);
    return state.value.n === 1;
  },
  async useCommandHistory(bus) {
    const h = useCommandHistory({ bus });
    bus.register('a', () => 1, { undo: () => undefined });
    await bus.dispatch('a', null);
    return h.past.value.length === 1;
  },
  async useCommandQuery(bus) {
    const q = useCommandQuery({ bus });
    bus.register('a', () => 7);
    await q.query('a', null);
    return q.data.value === 7;
  },
  async useCommandGroup(bus) {
    const g = useCommandGroup('g', { bus });
    g.register('a', () => 1);
    return (await g.dispatch('a', null)).ok && bus.hasHandler('gA');
  },
  async useCommandError(bus) {
    const e = useCommandError({ bus });
    bus.register('a', () => { throw new Error('x'); });
    await bus.dispatch('a', null);
    return e.latestError.value?.message === 'x';
  },
  async useSharedCommandState(bus) {
    const s = useSharedCommandState({ bus });
    bus.register('a', () => 1);
    return (await s.dispatch('a', null)).ok;
  },
  async defineVaporCommand(bus) {
    const d = defineVaporCommand('a', () => 1, { bus });
    return (await d.dispatch(null)).ok && bus.hasHandler('a');
  },
  async useVaporAsyncCommand(bus) {
    const v = useVaporAsyncCommand(bus as never);
    bus.register('a', () => 1);
    return (await v.dispatch('a', null)).ok;
  },
  async useTransitionCommand(bus) {
    const t = useTransitionCommand({ bus, namespace: 'm' });
    let heard = false;
    bus.register('mBeforeEnter', () => { heard = true; });
    t.onBeforeEnter({} as Element);
    await Promise.resolve();
    return heard;
  },
};

const kinds: Record<string, () => BaseBus> = {
  sync: () => createCommandBus(),
  async: () => createAsyncCommandBus(),
};

describe('the bus option', () => {
  it('covers every composable of the root and vapor-chamber/reactive', () => {
    const names = [...Object.keys(root), ...Object.keys(reactive)];
    const exported = names.filter((n) => /^use[A-Z]/.test(n) || /^define\w*Command$/.test(n));
    expect(exported.sort()).toEqual(Object.keys(cases).sort());
  });

  it('defineVaporCommand: an undo registered with the bus in its options runs', async () => {
    const own = createCommandBus();
    const undone: unknown[] = [];
    const scope = effectScope();
    await scope.run(async () => {
      const h = useCommandHistory({ bus: own });
      const d = defineVaporCommand('a', () => 1, { bus: own, undo: (cmd) => { undone.push(cmd.target); } });
      d.dispatch('t');
      await h.undo();
    });
    scope.stop();
    expect(undone).toEqual(['t']);
  });

  it('useCommandHistory undoes and redoes on the async bus it is given', async () => {
    const own = createAsyncCommandBus();
    const runs: string[] = [];
    const scope = effectScope();
    const h = scope.run(() => useCommandHistory({ bus: own }))!;
    own.register('a', async (cmd) => { runs.push(`do ${cmd.target}`); }, { undo: (cmd) => { runs.push(`undo ${cmd.target}`); } });
    await own.dispatch('a', 1);
    expect(h.undo()?.target).toBe(1);
    await new Promise((r) => setTimeout(r, 0));
    expect([h.canUndo.value, h.canRedo.value]).toEqual([false, true]);
    expect(h.redo()?.target).toBe(1);
    await new Promise((r) => setTimeout(r, 0));
    scope.stop();
    expect(runs).toEqual(['do 1', 'undo 1', 'do 1']);
    expect([h.canUndo.value, h.canRedo.value]).toEqual([true, false]);
  });

  for (const [kind, make] of Object.entries(kinds)) {
    for (const [name, use] of Object.entries(cases)) {
      it(`${name} runs on the ${kind} bus it is given, not the shared one`, async () => {
        const shared = getCommandBus();
        const heard: string[] = [];
        shared.on('*', (cmd) => { heard.push(cmd.action); });
        const own = make();
        const scope = effectScope();
        const reached = await scope.run(() => use(own))!;
        scope.stop();
        expect(reached).toBe(true);
        expect(shared.registeredActions()).toEqual([]);
        expect(heard).toEqual([]);
      });
    }
  }
});

/*
 * Why this file exists. src/shared-bus.ts tells concurrent SSR servers to
 * create a bus per request and pass it explicitly, because the shared bus is
 * one module global per process. Until 1.29.0 only useSharedCommandState,
 * useVaporAsyncCommand and useTransitionCommand took a bus. The other six
 * composables and defineVaporCommand always used the shared one, so that
 * advice could not be followed (log s35.221).
 *
 * The first test is the guard. It lists every `use*` and `define*Command`
 * export of the package root and of vapor-chamber/reactive, and requires a
 * case here for each, so a new composable without the option fails this file.
 * Router composables are not listed: they take the router, not a bus.
 *
 * Each case runs on both bus kinds. setCommandBus() accepts either, and its
 * docblock says the composables handle an async bus. Before this file nothing
 * checked that per composable.
 */
