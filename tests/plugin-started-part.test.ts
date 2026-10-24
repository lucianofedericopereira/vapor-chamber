/** A plugin's `started` and `settled` parts share the bus's facts slot with the command state. The long note is at the end. */
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

/*
 * Plan 1.32 step 8b (log 36.105). A plugin's `started(cmd)` and
 * `settled(cmd, result)` parts are the bus's facts, not hooks: the bus calls
 * them where it tells the command state a command started and settled, so a
 * part hears every outcome wherever the plugin is installed, a rule's refusal
 * included. A query starts too (`Facts.queried`), which the command state does
 * not count, so a read never shows pending while a part still times it. The
 * slot is one field: null while nothing observes, the command state's own
 * observer while it observes alone (the tracked rows run the code they ran),
 * and one composed observer otherwise (`_composeFacts`). Each part runs inside
 * its plugin's scope and its own try: a throw is logged with the plugin's id.
 */
