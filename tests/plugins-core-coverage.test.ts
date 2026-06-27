/**
 * plugins-core coverage — the leftover error-path catches and async rollback
 * branches in logger / history / debounce / optimistic / optimisticUndo.
 * All reachable with deliberately-throwing handlers/undo/rollback fns + a
 * console.error spy (and fake timers for debounce). No Vue, no I/O mocks.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createCommandBus, createAsyncCommandBus, type CommandBus } from '../src/command-bus';
import { logger, history, debounce, optimistic, optimisticUndo } from '../src/plugins-core';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

// ── logger: failed-dispatch error branch (line 34) ────────────────────────────
describe('plugins-core coverage — logger', () => {
  it('logs the error on a failed dispatch', () => {
    vi.spyOn(console, 'group').mockImplementation(() => {});
    vi.spyOn(console, 'groupCollapsed').mockImplementation(() => {});
    vi.spyOn(console, 'groupEnd').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const bus = createCommandBus();
    bus.use(logger());
    bus.dispatch('missing', {}); // no handler → result.ok === false

    expect(errSpy).toHaveBeenCalledWith('error:', expect.anything());
  });
});

// ── history: undo handler throws (136) + redo dispatch throws (151) ────────────
describe('plugins-core coverage — history undo/redo errors', () => {
  it('catches a throwing undo handler', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bus = createCommandBus();
    const h = history({ bus });
    bus.use(h);
    bus.register('act', () => 'ok', { undo: () => { throw new Error('undo boom'); } });

    bus.dispatch('act', {});            // recorded in `past`
    expect(() => h.undo()).not.toThrow(); // undo handler throws → caught

    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('Undo handler error'), expect.anything());
  });

  it('catches a throwing redo dispatch', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bus = createCommandBus({ onMissing: 'throw' });
    const h = history({ bus });
    bus.use(h);
    const unreg = bus.register('act', () => 'ok');

    bus.dispatch('act', {}); // recorded
    h.undo();                // past → future
    unreg();                 // remove handler → redo's dispatch throws (onMissing:'throw')
    expect(() => h.redo()).not.toThrow();

    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('Redo dispatch error'), expect.anything());
  });
});

// ── debounce: debounced execution throws (214) ────────────────────────────────
describe('plugins-core coverage — debounce', () => {
  it('catches a throwing debounced execution', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.useFakeTimers();
    const bus = createCommandBus();
    bus.use(debounce(['act'], 100), { priority: 10 });                       // outer: defers next()
    bus.use((_cmd, _next) => { throw new Error('downstream boom'); }, { priority: 1 }); // inner throws when the timer fires
    bus.register('act', () => 'ok');

    bus.dispatch('act', {});       // schedules the debounce timer, stores `next`
    vi.advanceTimersByTime(100);   // timer fires → currentNext() → inner plugin throws → caught

    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('Debounced execution error'), expect.anything());
  });
});

// ── optimistic: rollback throws — sync (321) + async (310-315) ─────────────────
describe('plugins-core coverage — optimistic rollback errors', () => {
  it('catches a throwing sync rollback', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bus = createCommandBus();
    bus.use(optimistic({ act: { apply: () => () => { throw new Error('rollback boom'); } } }));
    bus.register('act', () => { throw new Error('handler fail'); });

    bus.dispatch('act', {}); // handler fails → rollback() throws → caught

    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('Rollback error'), expect.anything());
  });

  it('catches a throwing async rollback', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bus = createAsyncCommandBus();
    bus.use(optimistic({ act: { apply: () => () => { throw new Error('async rollback boom'); } } }));
    bus.register('act', async () => { throw new Error('async fail'); });

    await bus.dispatch('act', {}); // async fail → .then → rollback throws → caught

    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('Rollback error'), expect.anything());
  });
});

// ── optimisticUndo: undo throws — sync (418) + async + onRollback (401-406) ────
describe('plugins-core coverage — optimisticUndo rollback errors', () => {
  it('sync: catches a throwing undo and console.errors with no onRollbackError', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bus = createCommandBus();
    bus.register('act', () => { throw new Error('fail'); }, { undo: () => { throw new Error('undo boom'); } });
    bus.use(optimisticUndo(bus, ['act'])); // no onRollbackError → falls to console.error

    bus.dispatch('act', {});

    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('Undo rollback error'), expect.anything());
  });

  it('async: catches a throwing undo in the background and fires onRollback', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onRollback = vi.fn();
    const bus = createAsyncCommandBus();
    bus.register('act', async () => { throw new Error('async fail'); }, { undo: () => { throw new Error('undo boom'); } });
    bus.use(optimisticUndo(bus as unknown as CommandBus, ['act'], { onRollback }));

    const r = await bus.dispatch('act', {}); // returns the predicted result immediately
    expect(r.ok).toBe(true);

    await new Promise(resolve => setTimeout(resolve, 0)); // let the background rollback run

    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('Undo rollback error'), expect.anything());
    expect(onRollback).toHaveBeenCalled();
  });
});
