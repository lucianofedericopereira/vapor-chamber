/**
 * Supplemental coverage for src/plugins-core.ts.
 *
 *  - logger badges outside a browser: the node arm of the %c styling
 *    split.
 *  - history(): undo/redo on empty stacks, self-registered trigger
 *    actions with a bus, and the DEV warning without one.
 *  - optimistic(): action with no configured handler, and an async
 *    failure whose apply() returned no rollback.
 *  - optimisticUndo(): async rollback where the undo handler itself throws -
 *    the onRollbackError arm - plus onRollback notification.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createCommandBus, createAsyncCommandBus } from '../src/index';
import { logger, history, optimistic, optimisticUndo } from '../src/plugins-core';

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// logger - badges in a non-browser environment
// ---------------------------------------------------------------------------

describe('logger badges (node arm)', () => {
  it('prints plain-text badges when window is absent', () => {
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
// history - empty stacks + trigger actions
// ---------------------------------------------------------------------------

describe('history', () => {
  it('undo/redo on empty stacks return undefined without side effects', () => {
    const h = history();
    expect(h.undo()).toBeUndefined();
    expect(h.redo()).toBeUndefined();
    expect(h.getState().canUndo).toBe(false);
    expect(h.getState().canRedo).toBe(false);
  });

  it('registers undo/redo trigger actions on the bus', () => {
    const bus = createCommandBus();
    const calls: string[] = [];
    bus.register('act', () => { calls.push('do'); return 1; }, { undo: () => { calls.push('undo'); } });

    const h = history({ bus, undoAction: 'historyUndo', redoAction: 'historyRedo' });
    bus.use(h);

    bus.dispatch('act', {});
    expect(h.getState().canUndo).toBe(true);

    // Dispatching the trigger actions drives the api - that's the wiring 213-214 adds.
    bus.dispatch('historyUndo', {});
    expect(calls).toEqual(['do', 'undo']);
    expect(h.getState().canRedo).toBe(true);

    bus.dispatch('historyRedo', {});
    expect(calls).toEqual(['do', 'undo', 'do']);
  });

  it('warns in dev when trigger actions are configured without a bus', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    history({ undoAction: 'historyUndo' });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('require the `bus` option');
  });
});

// ---------------------------------------------------------------------------
// optimistic - passthrough + async no-rollback failure
// ---------------------------------------------------------------------------

describe('optimistic', () => {
  it('passes unconfigured actions straight through', () => {
    const bus = createCommandBus();
    bus.use(optimistic({ save: { apply: () => null } }));
    bus.register('other', () => 42);

    expect(bus.dispatch('other', {})).toEqual({ ok: true, value: 42 });
  });

  it('tolerates an async failure when apply() returned no rollback', async () => {
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
// optimisticUndo - rollback error arms
// ---------------------------------------------------------------------------

describe('optimisticUndo async rollback', () => {
  it('reports a throwing undo handler via onRollbackError and still notifies onRollback', async () => {
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

// ---------------------------------------------------------------------------
// The optional-shape arms: one trigger without the other, a rollback with no
// observer, and the production half of the missing-bus warning.
// ---------------------------------------------------------------------------

describe('history/optimistic - optional-shape arms', () => {
  it('registers only the trigger that was configured', () => {
    // The wiring test above supplies BOTH undoAction and redoAction, so each
    // `if` only ever ran its true arm. Configuring one alone is the ordinary
    // case for an app that exposes undo but not redo.
    const bus = createCommandBus();
    const calls: string[] = [];
    bus.register('act', () => { calls.push('do'); return 1; }, { undo: () => { calls.push('undo'); } });

    const h = history({ bus, undoAction: 'historyUndo' }); // no redoAction
    bus.use(h);

    bus.dispatch('act', {});
    bus.dispatch('historyUndo', {});
    expect(calls).toEqual(['do', 'undo']);
    // The trigger that was never configured is not a registered command.
    expect(bus.getHandler?.('historyRedo') ?? null).toBeNull();

    // ...and the mirror: redo only.
    const bus2 = createCommandBus();
    const calls2: string[] = [];
    bus2.register('act', () => { calls2.push('do'); return 1; }, { undo: () => { calls2.push('undo'); } });
    const h2 = history({ bus: bus2, redoAction: 'historyRedo' }); // no undoAction
    bus2.use(h2);
    bus2.dispatch('act', {});
    h2.undo();
    bus2.dispatch('historyRedo', {});
    expect(calls2).toEqual(['do', 'undo', 'do']);
  });

  it('rolls back without an onRollback observer configured', () => {
    // `if (onRollback)` - the false arm. Every rollback test supplies the
    // callback; the default configuration has none and must still roll back.
    const bus = createCommandBus();
    const applied: string[] = [];
    bus.register('save', () => { throw new Error('server said no'); });
    bus.use(
      optimistic({
        save: {
          apply: () => {
            applied.push('apply');
            return () => { applied.push('rollback'); };
          },
        },
      }),
    );

    const result = bus.dispatch('save', { id: 1 });
    expect(result.ok).toBe(false);
    expect(applied).toEqual(['apply', 'rollback']); // rolled back, no observer needed
  });

  it('does not warn about a missing bus in production', async () => {
    // The `if (DEV)` false arm of the trigger-without-bus warning.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('NODE_ENV', 'production');
    vi.resetModules();
    const { history: prodHistory } = await import('../src/plugins-core');

    const h = prodHistory({ undoAction: 'historyUndo' }); // no bus
    expect(warn).not.toHaveBeenCalled();
    // Still a usable history object - just without the triggers.
    expect(h.getState().canUndo).toBe(false);

    warn.mockRestore();
    vi.unstubAllEnvs();
    vi.resetModules();
  });
});

// ---------------------------------------------------------------------------
// Cheap remaining arms: browser badge colour, the async rollback without an
// observer, and the sync optimistic SUCCESS path.
// ---------------------------------------------------------------------------

describe('logger badges in a browser-ish environment', () => {
  it('uses the FAIL colour for a failed command', () => {
    // The `ok ? '#2a6' : '#c33'` ternary. The browser branch is only taken when
    // `window` exists, and the file's other logger tests run without one - so
    // the failure colour had never been produced. logger() writes through
    // console.groupCollapsed, so that is what gets spied.
    vi.stubGlobal('window', {});
    const calls: unknown[][] = [];
    vi.spyOn(console, 'groupCollapsed').mockImplementation((...args: unknown[]) => { calls.push(args); });
    vi.spyOn(console, 'groupEnd').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const bus = createCommandBus();
    bus.register('fine', () => 'ok');
    bus.register('boom', () => { throw new Error('nope'); });
    bus.use(logger({ badges: true }));

    bus.dispatch('fine', {});
    bus.dispatch('boom', {});

    const styles = calls.map((c) => String(c[1] ?? ''));
    expect(styles.some((s) => s.includes('#2a6'))).toBe(true); // OK green
    expect(styles.some((s) => s.includes('#c33'))).toBe(true); // FAIL red
    vi.unstubAllGlobals();
  });
});

describe('optimisticUndo - arms the rollback tests skip', () => {
  it('rolls back on an ASYNC bus with no onRollback observer', async () => {
    // `if (onRollback)` in the ASYNC arm. These paths belong to
    // optimisticUndo (which reads the UNDO handler off the bus), not
    // optimistic - and every existing test supplies the callback, so the
    // default no-observer configuration never ran.
    const bus = createAsyncCommandBus();
    const undone: string[] = [];
    bus.register('save', async () => { throw new Error('server said no'); }, {
      undo: () => { undone.push('undo'); },
    });
    bus.use(optimisticUndo(bus, ['save'], { predict: () => ({ optimistic: true }) })); // no onRollback

    const result: any = await bus.dispatch('save', { id: 1 });
    expect(result.ok).toBe(true); // predicted value returned immediately
    expect(result.value).toEqual({ optimistic: true });

    await new Promise((r) => setTimeout(r, 0)); // background rollback settles
    expect(undone).toEqual(['undo']);
  });

  it('does not roll back when the SYNC handler succeeds', () => {
    // `if (!result.ok)` - the else. Every optimisticUndo test drives a
    // failure, so the ordinary happy path (handler succeeds, undo never
    // called) was asserted nowhere.
    const bus = createCommandBus();
    const undone: string[] = [];
    bus.register('save', () => 'server-value', { undo: () => { undone.push('undo'); } });
    bus.use(optimisticUndo(bus, ['save']));

    const result = bus.dispatch('save', { id: 1 });

    expect(result.ok).toBe(true);
    expect(result.value).toBe('server-value'); // real value, not a prediction
    expect(undone).toEqual([]); // undo never ran
  });
});
