/**
 * One rule for dispatches made inside an undo handler or a redo: they are
 * rollback steps, carry meta.origin 'undo' or 'redo', and history does not
 * record them - on both buses, in the plugin and in the composable.
 *
 * Before: the history() plugin held a `_replaying` flag around the undo
 * handler and the redo dispatch. The flag held only while the recorder ran
 * INSIDE the dispatch - the sync bus; on the async bus the recorder runs when
 * the dispatch settles, after the flag was cleared, so a compensating
 * dispatch made by an undo handler was recorded and wiped the redo stack.
 * useCommandHistory suppressed the redo dispatch itself (origin 'redo', a
 * one-shot slot) and nothing an undo handler dispatched, on either bus. Now
 * `_withOriginScope` stamps every dispatch made synchronously inside the
 * window - stampMeta runs in the synchronous prologue of every dispatch, so
 * the scope holds on the async bus too - and both recorders skip 'undo' and
 * 'redo'. The limit is the flag's old limit: a dispatch an ASYNC undo handler
 * makes after an await is outside the window.
 */
import { describe, expect, afterEach } from 'vitest';
import { createCommandBus, createAsyncCommandBus, _withOriginScope, type Command, type CommandBus } from '../src/command-bus';
import { history } from '../src/plugins-core';
import { useCommandHistory, setCommandBus, resetCommandBus } from '../src/chamber';
import { it } from '../src/vitest';

const tick = () => new Promise((r) => setTimeout(r, 0));
const actions = (cmds: Command[]) => cmds.map((c) => c.action);

describe('history() plugin: dispatches inside an undo handler or a redo are not recorded', () => {
  it('sync bus: an undo handler that dispatches two compensations', ({ bus }) => {
    const h = history({ bus });
    bus.use(h);
    bus.register('comp', () => 'compensated');
    bus.register('act', () => 'done', { undo: () => { bus.dispatch('comp', 1); bus.dispatch('comp', 2); } });
    bus.dispatch('act', 1);
    expect(actions(h.getState().past)).toEqual(['act']);

    h.undo();

    const s = h.getState();
    expect(s.past).toEqual([]);
    expect(actions(s.future)).toEqual(['act']);
    expect(s.canRedo).toBe(true);
  });

  it('async bus: the same, where the flag used to be cleared before the recorder ran', async ({ asyncBus: bus }) => {
    const h = history({ bus: bus as unknown as CommandBus });
    bus.use(h as any);
    bus.register('comp', async () => 'compensated');
    bus.register('act', async () => 'done', { undo: () => { bus.dispatch('comp', 1); bus.dispatch('comp', 2); } });
    await bus.dispatch('act', 1);
    expect(actions(h.getState().past)).toEqual(['act']);

    h.undo();
    await tick();

    const s = h.getState();
    expect(s.past).toEqual([]);
    expect(actions(s.future)).toEqual(['act']);
  });

  it('a redone handler whose own dispatches are nested: recorded once, as the redo', async () => {
    for (const make of [createCommandBus, createAsyncCommandBus] as const) {
      const bus: any = make();
      const h = history({ bus });
      bus.use(h);
      let nested = false;
      bus.register('child', () => 'c');
      bus.register('act', () => { if (nested) bus.dispatch('child', 1); return 'a'; }, { undo: () => {} });
      await bus.dispatch('act', 1);
      h.undo();
      nested = true;
      h.redo();
      await tick();
      expect(actions(h.getState().past)).toEqual(['act']);
      expect(h.getState().future).toEqual([]);
    }
  });

  it('listeners see the origin: undo for the compensations, redo for the replay', ({ bus }) => {
    const h = history({ bus });
    bus.use(h);
    const seen: Array<[string, unknown]> = [];
    bus.on('*', (cmd) => { seen.push([cmd.action, cmd.meta?.origin]); });
    bus.register('comp', () => 'c');
    bus.register('act', () => 'a', { undo: () => { bus.dispatch('comp', 1); } });
    bus.dispatch('act', 1);
    h.undo();
    h.redo();
    expect(seen).toEqual([['act', undefined], ['comp', 'undo'], ['act', 'redo']]);
  });
});

describe('useCommandHistory: the same rule', () => {
  afterEach(() => { resetCommandBus(); });

  for (const [kind, make] of [['sync', createCommandBus], ['async', createAsyncCommandBus]] as const) {
    it(`${kind} bus: an undo handler's compensations are not recorded`, async () => {
      const bus: any = make();
      setCommandBus(bus);
      bus.register('comp', () => 'compensated');
      bus.register('act', () => 'done', { undo: () => { bus.dispatch('comp', 1); bus.dispatch('comp', 2); } });
      const { past, future, undo } = useCommandHistory();
      await bus.dispatch('act', 1);
      await tick();
      expect(actions(past.value)).toEqual(['act']);

      undo();
      await tick();

      expect(past.value).toEqual([]);
      expect(actions(future.value)).toEqual(['act']);
    });
  }
});

describe('_withOriginScope', () => {
  it('marks every dispatch made synchronously inside the callback and restores the outer scope', ({ bus }) => {
    const seen: unknown[] = [];
    bus.register('t', (c) => { seen.push(c.meta?.origin); return 1; });
    _withOriginScope('undo', () => {
      bus.dispatch('t', 1);
      _withOriginScope('redo', () => bus.dispatch('t', 2));
      bus.dispatch('t', 3);
    });
    bus.dispatch('t', 4);
    expect(seen).toEqual(['undo', 'redo', 'undo', undefined]);
  });

  it('restores the scope when the callback throws', ({ bus }) => {
    const seen: unknown[] = [];
    bus.register('t', (c) => { seen.push(c.meta?.origin); return 1; });
    expect(() => _withOriginScope('undo', () => { throw new Error('x'); })).toThrow('x');
    bus.dispatch('t', 1);
    expect(seen).toEqual([undefined]);
  });
});
