/**
 * plugins-core coverage - the leftover error-path catches and async rollback
 * branches in logger / history, and an optimistic undo that throws.
 * All reachable with deliberately-throwing handlers/undo/rollback fns + a
 * console.error spy. No Vue, no I/O mocks.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createCommandBus, createAsyncCommandBus, } from '../src/command-bus';
import { history, logger } from '../src/plugins-core';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

// ── logger: failed-dispatch error branch (line 34) ────────────────────────────
describe('plugins-core coverage - logger', () => {
  it('logs the error on a failed dispatch', () => {
    vi.spyOn(console, 'group').mockImplementation(() => {});
    vi.spyOn(console, 'groupCollapsed').mockImplementation(() => {});
    vi.spyOn(console, 'groupEnd').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const bus = createCommandBus();
    bus.use(logger());
    bus.dispatch('missing', {}); // no handler -> result.ok === false

    expect(errSpy).toHaveBeenCalledWith('error:', expect.anything());
  });
});

// ── history: undo handler throws + redo dispatch throws ────────────
describe('plugins-core coverage - history undo/redo errors', () => {
  it('catches a throwing undo handler', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bus = createCommandBus();
    const h = history({ bus });
    bus.register('act', () => 'ok', { undo: () => { throw new Error('undo boom'); } });

    bus.dispatch('act', {});            // recorded in `past`
    expect(() => h.undo()).not.toThrow(); // undo handler throws -> caught

    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('history:failed:move: Undo handler threw'), expect.anything());
  });

  it('catches a throwing redo dispatch', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bus = createCommandBus({ onMissing: 'throw' });
    const h = history({ bus });
    const unreg = bus.register('act', () => 'ok');

    bus.dispatch('act', {}); // recorded
    h.undo();                // past -> future
    unreg();                 // remove handler -> redo's dispatch throws (onMissing:'throw')
    expect(() => h.redo()).not.toThrow();

    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('history:failed:move: Redo dispatch threw'), expect.anything());
  });
});

// ── register({ optimistic }): an undo that throws - sync + async ─────────────
describe('plugins-core coverage - an optimistic undo that throws', () => {
  it('sync: the throwing undo is reported, and the failure returns', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bus = createCommandBus();
    bus.register('act', () => { throw new Error('fail'); }, { undo: () => { throw new Error('undo boom'); }, optimistic: true });

    expect(bus.dispatch('act', {}).ok).toBe(false);

    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('core:failed:undo: the undo of "act" failed'), expect.anything());
  });

  it('async: the throwing undo is reported, and done settles with the failure', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bus = createAsyncCommandBus({ retry: false });
    bus.register('act', async () => { throw new Error('async fail'); }, { undo: () => { throw new Error('undo boom'); }, optimistic: true });

    const r = await bus.dispatch('act', {}); // answers at once
    expect(r.ok).toBe(true);
    expect((await (r.value as { done: Promise<{ ok: boolean }> }).done).ok).toBe(false);

    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('core:failed:undo: the undo of "act" failed'), expect.anything());
  });
});
