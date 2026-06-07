/**
 * Covers the error/async branches in chamber.ts composables that the happy-path
 * tests miss: runDispatch (sync-throw + async success/error), useSharedCommandState
 * error recording, and undo/redo handler error handling.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  useCommand,
  useSharedCommandState,
  useCommandHistory,
  setCommandBus,
  resetCommandBus,
} from '../src/chamber';
import { createCommandBus, createAsyncCommandBus } from '../src/command-bus';

afterEach(() => resetCommandBus());

describe('runDispatch (via useCommand)', () => {
  it('captures a synchronously-thrown dispatch into lastError', () => {
    setCommandBus(createCommandBus({ onMissing: 'throw' })); // dispatch throws on miss
    const { dispatch, loading, lastError } = useCommand();
    const r = dispatch('missing', {}) as any;
    expect(r.ok).toBe(false);
    expect(loading.value).toBe(false);
    expect(lastError.value).toBeInstanceOf(Error);
  });

  it('async success clears loading and leaves no error', async () => {
    setCommandBus(createAsyncCommandBus());
    const bus = createAsyncCommandBus();
    setCommandBus(bus);
    bus.register('ok', async () => 'done');
    const { dispatch, loading, lastError } = useCommand();
    const r = await (dispatch('ok', {}) as Promise<any>);
    expect(r.ok).toBe(true);
    expect(loading.value).toBe(false);
    expect(lastError.value).toBeNull();
  });

  it('async failed result is recorded in lastError', async () => {
    const bus = createAsyncCommandBus();
    setCommandBus(bus);
    bus.register('boom', async () => { throw new Error('handler failed'); });
    const { dispatch, loading, lastError } = useCommand();
    const r = await (dispatch('boom', {}) as Promise<any>);
    expect(r.ok).toBe(false);
    expect(loading.value).toBe(false);
    expect(lastError.value).toBeInstanceOf(Error);
  });
});

describe('useSharedCommandState — error recording', () => {
  beforeEach(() => setCommandBus(createCommandBus({ onMissing: 'throw' })));

  it('records a synchronously-thrown dispatch and decrements in-flight', () => {
    const shared = useSharedCommandState();
    const r = shared.dispatch('missing', {}) as any;
    expect(r.ok).toBe(false);
    expect(shared.errorCount.value).toBeGreaterThan(0);
    expect(shared.lastError.value).toBeInstanceOf(Error);
    expect(shared.inFlight.value).toBe(0);     // decrement ran in the catch
    expect(shared.isAnyLoading.value).toBe(false);
  });

  it('async failed result is recorded', async () => {
    const bus = createAsyncCommandBus();
    setCommandBus(bus);
    bus.register('boom', async () => { throw new Error('x'); });
    const shared = useSharedCommandState();
    const r = await (shared.dispatch('boom', {}) as Promise<any>);
    expect(r.ok).toBe(false);
    expect(shared.errorCount.value).toBe(1);
    expect(shared.inFlight.value).toBe(0);
  });
});

describe('useCommandHistory — undo/redo error handling', () => {
  it('catches a throwing undo handler (does not propagate)', () => {
    const bus = createCommandBus();
    setCommandBus(bus);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    bus.register('act', () => 1, { undo: () => { throw new Error('undo blew up'); } });

    const history = useCommandHistory({});
    bus.dispatch('act', {});                 // tracked
    expect(() => history.undo()).not.toThrow(); // throwing undo handler is caught
    err.mockRestore();
  });

  it('catches a throwing redo dispatch (does not propagate)', () => {
    const bus = createCommandBus({ onMissing: 'throw' });
    setCommandBus(bus);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const unregister = bus.register('act', () => 1);

    const history = useCommandHistory({});
    bus.dispatch('act', {});   // tracked
    history.undo();            // moves to future
    unregister();             // remove handler → redo's dispatch will throw (onMissing:'throw')

    expect(() => history.redo()).not.toThrow(); // redo's bus.dispatch throw is caught
    err.mockRestore();
  });
});
