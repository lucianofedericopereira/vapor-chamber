/**
 * chamber.ts composables on their failure paths: useCommand, useSharedCommandState, useCommandHistory.
 * Why: a failing or throwing dispatch must end as a failed result or a recorded error, never a stuck pending flag or an exception out of undo/redo.
 * Shows: a sync throw and an async failure are failed results with nothing pending; the shared state records both; a throwing undo or redo is caught.
 */
import { describe, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  useCommand,
  useSharedCommandState,
  useCommandHistory,
  setCommandBus,
  resetCommandBus,
  getCommandBus,
} from '../src/chamber';
import { createCommandBus, createAsyncCommandBus } from '../src/command-bus';
import { it } from '../src/vitest';

afterEach(() => resetCommandBus());

describe('runCommand (via useCommand)', () => {
  it('a synchronously-thrown dispatch is a failed result, nothing left pending', () => {
    setCommandBus(createCommandBus({ onMissing: 'throw' })); // dispatch throws on miss
    const { dispatch, pending } = useCommand();
    const key = pending('missing', {});
    const r = dispatch('missing', {}) as any;
    expect(r).toFailWith('core:missing:handler');
    expect(key.value).toBe(false);
  });

  it('async success: the result, nothing left pending', async () => {
    const bus = createAsyncCommandBus();
    bus.register('ok', async () => 'done');
    const { dispatch, pending } = useCommand({ bus });
    const key = pending('ok', {});
    const r = await dispatch('ok', {});
    expect(r.ok).toBe(true);
    expect(key.value).toBe(false);
  });

  it("async failed result is the result, and lands in the bus's errors", async ({ asyncBus: bus }) => {
    bus.register('boom', async () => { throw new Error('handler failed'); });
    const shared = useSharedCommandState({ bus });
    const { dispatch } = useCommand({ bus });
    const r = await dispatch('boom', {});
    expect(r.ok).toBe(false);
    expect(shared.lastError.value).toBeInstanceOf(Error);
    shared.dispose();
  });
});

describe('useSharedCommandState - error recording', () => {
  beforeEach(() => setCommandBus(createCommandBus({ onMissing: 'throw' })));

  it('records a dispatch that throws (onMissing: throw) and leaves nothing pending', () => {
    const shared = useSharedCommandState();
    void shared.anyPending;
    expect(() => getCommandBus().dispatch('missing', {})).toThrow();
    expect(shared.errors.value.map((e) => (e as { code?: string }).code)).toEqual(['core:missing:handler']);
    expect(shared.lastError.value).toBeInstanceOf(Error);
    expect(shared.anyPending.value).toBe(false);
    shared.dispose();
  });

  it('async failed result is recorded', async ({ asyncBus: bus }) => {
    bus.register('boom', async () => { throw new Error('x'); });
    const shared = useSharedCommandState({ bus });
    void shared.anyPending;
    const r = await bus.dispatch('boom', {});
    expect(r.ok).toBe(false);
    expect(shared.errors.value.length).toBe(1);
    expect(shared.anyPending.value).toBe(false);
    shared.dispose();
  });
});

describe('useCommandHistory - undo/redo error handling', () => {
  it('catches a throwing undo handler (does not propagate)', ({ bus }) => {
    setCommandBus(bus);
    using _err = vi.spyOn(console, 'error').mockImplementation(() => {});
    bus.register('act', () => 1, { undo: () => { throw new Error('undo blew up'); } });

    const history = useCommandHistory({});
    bus.dispatch('act', {});                 // tracked
    expect(() => history.undo()).not.toThrow(); // throwing undo handler is caught
  });

  it('catches a throwing redo dispatch (does not propagate)', () => {
    const bus = createCommandBus({ onMissing: 'throw' });
    setCommandBus(bus);
    using _err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const unregister = bus.register('act', () => 1);

    const history = useCommandHistory({});
    bus.dispatch('act', {});   // tracked
    history.undo();            // moves to future
    unregister();             // remove handler -> redo's dispatch will throw (onMissing:'throw')

    expect(() => history.redo()).not.toThrow(); // redo's bus.dispatch throw is caught
  });
});
