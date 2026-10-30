/**
 * A plugin's `started` and `settled` parts, which share the bus's facts slot with the command state.
 * Why: a part must hear every outcome wherever the plugin is installed, a rule's refusal and a query included, while the command state still counts no query as pending and a throwing part never stops the command.
 * Shows: on the sync, async and test buses a recorder hears dispatch, query and refusal in order, stays inside its scope, hears nothing after its remover runs, and a throwing part is logged under its plugin id while the command succeeds; the command state sees only the dispatch pending; the facts slot returns to the state's own observer once the plugin is removed and to null once the state is disposed.
 * See: log s36.105.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type BaseBus, type Command, type PluginParts, createAsyncCommandBus, createCommandBus } from '../src/command-bus';
import { commandState } from '../src/command-state';
import { createTestBus } from '../src/testing';
import { validator } from '../src/plugins-core';

type Kind = 'sync' | 'async' | 'test';
const KINDS: Kind[] = ['sync', 'async', 'test'];
function busOf(kind: Kind): BaseBus {
  const bus: BaseBus = kind === 'sync' ? createCommandBus() : kind === 'async' ? createAsyncCommandBus({ retry: false }) : createTestBus({ passthroughHandlers: true });
  bus.register('save', () => 1);
  bus.register('load', () => 2);
  return bus;
}

/** A plugin that records what it hears, as `started:action` and `settled:action:ok`. */
function recorder(log: string[], scope: Partial<PluginParts> = {}): PluginParts {
  return {
    id: 'recorder',
    ...scope,
    started: (cmd: Command) => { log.push(`started:${cmd.action}`); },
    settled: (cmd, result) => { log.push(`settled:${cmd.action}:${result.ok}`); },
  };
}

afterEach(() => { vi.restoreAllMocks(); });

describe('a plugin started part', () => {
  for (const kind of KINDS) {
    it(`hears a dispatch and a query start and settle (${kind})`, async () => {
      const log: string[] = [];
      const bus = busOf(kind);
      bus.use(recorder(log));
      await bus.dispatch('save', null);
      await bus.query('load', null);
      expect(log).toEqual(['started:save', 'settled:save:true', 'started:load', 'settled:load:true']);
    });

    it(`hears a rule's refusal start and settle (${kind})`, async () => {
      const log: string[] = [];
      const bus = busOf(kind);
      bus.use(recorder(log));
      bus.use(validator({ save: () => 'bad' }));
      await bus.dispatch('save', null);
      expect(log).toEqual(['started:save', 'settled:save:false']);
    });

    it(`stays inside its scope (${kind})`, async () => {
      const log: string[] = [];
      const bus = busOf(kind);
      bus.use(recorder(log, { actions: ['save'] }));
      await bus.dispatch('load', null);
      await bus.dispatch('save', null);
      expect(log).toEqual(['started:save', 'settled:save:true']);
    });

    it(`shares the slot with the command state, which counts no query (${kind})`, async () => {
      const log: string[] = [];
      const bus = busOf(kind);
      const state = commandState(bus);
      const seen: boolean[] = [];
      state.subscribe(() => { seen.push(state.anyPending.value); });
      void state.anyPending.value;
      bus.use(recorder(log));
      await bus.query('load', null);
      expect(seen).toEqual([]);
      await bus.dispatch('save', null);
      expect(seen).toEqual([true, false]);
      expect(log).toEqual(['started:load', 'settled:load:true', 'started:save', 'settled:save:true']);
      state.dispose();
    });

    it(`a part that throws is logged and the command goes on (${kind})`, async () => {
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      const bus = busOf(kind);
      const after: string[] = [];
      bus.use({ id: 'boom', started: () => { throw new Error('start'); }, settled: () => { throw new Error('settle'); } });
      bus.use(recorder(after));
      const r = await bus.dispatch('save', null);
      expect(r.ok).toBe(true);
      expect(after).toEqual(['started:save', 'settled:save:true']);
      expect(errors.mock.calls.map((c) => String(c[0]).split('\n')[0])).toEqual([
        '[vapor-chamber] [ FAIL ] boom:failed:plugin: its started part threw on "save"',
        '[vapor-chamber] [ FAIL ] boom:failed:plugin: its settled part threw on "save"',
      ]);
    });

    it(`control: taken out, it hears nothing more (${kind})`, async () => {
      const log: string[] = [];
      const bus = busOf(kind);
      const off = bus.use(recorder(log));
      off();
      await bus.dispatch('save', null);
      expect(log).toEqual([]);
    });
  }

  it('control: a command state alone keeps its own observer in the slot', () => {
    const bus = createCommandBus();
    const state = commandState(bus);
    const s = (bus as unknown as Record<symbol, { facts: unknown }>)[Object.getOwnPropertySymbols(bus).find((k) => k.description === 'vapor-chamber:inspect')!];
    const alone = s.facts;
    const off = bus.use(recorder([]));
    expect(s.facts).not.toBe(alone);
    off();
    expect(s.facts).toBe(alone);
    state.dispose();
    expect(s.facts).toBe(null);
  });
});
