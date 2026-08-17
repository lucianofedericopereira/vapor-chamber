/**
 * Supplemental coverage for src/plugins-core.ts.
 *
 *  - logger badges outside a browser (48-49): the node arm of the %c styling
 *    split.
 *  - history(): undo/redo on empty stacks (166, 183), self-registered trigger
 *    actions with a bus (213-214), and the DEV warning without one (208-210).
 *  - optimistic(): action with no configured handler (340), and an async
 *    failure whose apply() returned no rollback (346-348).
 *  - optimisticUndo(): async rollback where the undo handler itself throws —
 *    the onRollbackError arm (440) — plus onRollback notification (443).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createCommandBus, createAsyncCommandBus } from '../src/index';
import { logger, history, optimistic, optimisticUndo } from '../src/plugins-core';

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// logger — badges in a non-browser environment (47-49)
// ---------------------------------------------------------------------------

describe('logger badges (node arm)', () => {
  it('prints plain-text badges when window is absent (49)', () => {
    const group = vi.spyOn(console, 'groupCollapsed').mockImplementation(() => {});
    vi.spyOn(console, 'groupEnd').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const bus = createCommandBus();
    bus.use(logger({ badges: true }));
    bus.register('ok', () => 1);
    bus.register('down', () => { throw new Error('x'); });

    bus.dispatch('ok', {});
    bus.dispatch('down', {});

    const labels = group.mock.calls.map(c => String(c[0]));
    expect(labels[0]).toBe('[  OK  ] ⚡ ok');
    expect(labels[1]).toBe('[ FAIL ] ⚡ down');
    // Node arm: no %c styling directives.
    expect(labels.every(l => !l.includes('%c'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// history — empty stacks + trigger actions (164-216)
// ---------------------------------------------------------------------------

describe('history', () => {
  it('undo/redo on empty stacks return undefined without side effects (166, 183)', () => {
    const h = history();
    expect(h.undo()).toBeUndefined();
    expect(h.redo()).toBeUndefined();
    expect(h.getState().canUndo).toBe(false);
    expect(h.getState().canRedo).toBe(false);
  });

  it('registers undo/redo trigger actions on the bus (213-214)', () => {
    const bus = createCommandBus();
    const calls: string[] = [];
    bus.register('act', () => { calls.push('do'); return 1; }, { undo: () => { calls.push('undo'); } });

    const h = history({ bus, undoAction: 'historyUndo', redoAction: 'historyRedo' });
    bus.use(h);

    bus.dispatch('act', {});
    expect(h.getState().canUndo).toBe(true);

    // Dispatching the trigger actions drives the api — that's the wiring 213-214 adds.
    bus.dispatch('historyUndo', {});
    expect(calls).toEqual(['do', 'undo']);
    expect(h.getState().canRedo).toBe(true);

    bus.dispatch('historyRedo', {});
    expect(calls).toEqual(['do', 'undo', 'do']);
  });

  it('warns in dev when trigger actions are configured without a bus (208-210)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    history({ undoAction: 'historyUndo' });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('require the `bus` option');
  });
});

// ---------------------------------------------------------------------------
// optimistic — passthrough + async no-rollback failure (338-352)
// ---------------------------------------------------------------------------

describe('optimistic', () => {
  it('passes unconfigured actions straight through (340)', () => {
    const bus = createCommandBus();
    bus.use(optimistic({ save: { apply: () => null } }));
    bus.register('other', () => 42);

    expect(bus.dispatch('other', {})).toEqual({ ok: true, value: 42 });
  });

  it('tolerates an async failure when apply() returned no rollback (346-348)', async () => {
    const bus = createAsyncCommandBus();
    const apply = vi.fn(() => null); // nothing to roll back
    bus.use(optimistic({ save: { apply } }));
    bus.register('save', async () => { throw new Error('backend down'); });

    const result = await bus.dispatch('save', {});
    expect(result.ok).toBe(false);
    expect(apply).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// optimisticUndo — rollback error arms (436-447)
// ---------------------------------------------------------------------------

describe('optimisticUndo async rollback', () => {
  it('reports a throwing undo handler via onRollbackError and still notifies onRollback (440, 443)', async () => {
    const bus = createAsyncCommandBus();
    const onRollback = vi.fn();
    const onRollbackError = vi.fn();
    bus.register('pay', async () => { throw new Error('declined'); }, {
      undo: () => { throw new Error('undo also failed'); },
    });
    bus.use(optimisticUndo(bus as any, ['pay'], {
      predict: () => 'optimistic-value',
      onRollback,
      onRollbackError,
    }));

    // The caller gets the predicted value immediately...
    const result = await bus.dispatch('pay', {});
    expect(result).toEqual({ ok: true, value: 'optimistic-value' });

    // ...while the background monitor sees the failure and rolls back.
    await vi.waitFor(() => expect(onRollback).toHaveBeenCalledTimes(1));
    expect(onRollbackError).toHaveBeenCalledTimes(1);
    const [cmd, undoErr, origErr] = onRollbackError.mock.calls[0]!;
    expect(cmd.action).toBe('pay');
    expect((undoErr as Error).message).toBe('undo also failed');
    expect((origErr as Error).message).toBe('declined');
  });
});
