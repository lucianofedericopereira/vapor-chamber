/**
 * The error paths of logger and history, and an optimistic undo that throws, on the sync and async buses.
 * Why: a failed dispatch must be logged, and a throwing undo or redo must be reported through the console rather than escape into the caller. Also the only file reaching the `core:failed:undo` report, so the 100% floor needs it.
 * Shows: logger prints `error:` for a dispatch with no handler, history.undo() and history.redo() swallow a throwing undo handler or redo dispatch and report `history:failed:move`, and a throwing optimistic undo is reported as `core:failed:undo` while the dispatch still returns its failure (sync) or its `done` settles with it (async).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createCommandBus, createAsyncCommandBus, } from '../src/command-bus';
import { history, logger } from '../src/plugins-core';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('plugins-core coverage - logger', () => {
  it('logs the error on a failed dispatch', () => {
    vi.spyOn(console, 'group').mockImplementation(() => {});
    vi.spyOn(console, 'groupCollapsed').mockImplementation(() => {});
    vi.spyOn(console, 'groupEnd').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const bus = createCommandBus();
    bus.use(logger());
    bus.dispatch('missing', {}); // no handler: a failed result

    expect(errSpy).toHaveBeenCalledWith('error:', expect.anything());
  });
});

describe('plugins-core coverage - history undo/redo errors', () => {
  it('catches a throwing undo handler', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bus = createCommandBus();
    const h = history({ bus });
    bus.register('act', () => 'ok', { undo: () => { throw new Error('undo boom'); } });

    bus.dispatch('act', {});
    expect(() => h.undo()).not.toThrow();

    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('history:failed:move: Undo handler threw'), expect.anything());
  });

  it('catches a throwing redo dispatch', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bus = createCommandBus({ onMissing: 'throw' });
    const h = history({ bus });
    const unreg = bus.register('act', () => 'ok');

    bus.dispatch('act', {});
    h.undo();
    unreg(); // redo's dispatch now throws (onMissing: 'throw')
    expect(() => h.redo()).not.toThrow();

    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('history:failed:move: Redo dispatch threw'), expect.anything());
  });
});

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

    const r = await bus.dispatch('act', {}); // optimistic: answers at once
    expect(r.ok).toBe(true);
    expect((await (r.value as { done: Promise<{ ok: boolean }> }).done).ok).toBe(false);

    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('core:failed:undo: the undo of "act" failed'), expect.anything());
  });
});
