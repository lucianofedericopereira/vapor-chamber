/**
 * useCommandHistory: a synchronous subscriber that throws on one of its signals during an undo or redo (real Vue effects).
 * Why: the history would read "undone" over an application that was not, and a redo would apply the command twice, if the stacks stayed moved and the four signals were left half written.
 * Shows: a throw on the move is an undo or redo that did not land: nothing escapes, the handler does not run, the error is logged, all four signals match the application, and the history works once the subscriber is stopped; with no throwing subscriber the order of subscriber and handler runs is pinned.
 * See: log s35.18, log s35.23 e, src/settled.ts.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { effect, isRef } from 'vue';
import { resetCommandBus, setCommandBus, useCommandHistory, waitForVueDetection } from '../src/chamber';
import { createCommandBus } from '../src/command-bus';

const boom = new Error('subscriber threw');
let events: string[] = [];

/** A counter on a fresh bus: `inc` adds one, its undo handler takes it back. */
function setup() {
  const bus = createCommandBus();
  setCommandBus(bus);
  const app = { value: 0, undone: 0 };
  bus.register(
    'inc',
    () => {
      events.push('handler');
      return ++app.value;
    },
    {
      undo: () => {
        events.push('undoHandler');
        app.undone++;
        app.value--;
      },
    },
  );
  const h = useCommandHistory({});
  const state = () => ({
    value: app.value,
    past: h.past.value.length,
    future: h.future.value.length,
    canUndo: h.canUndo.value,
    canRedo: h.canRedo.value,
  });
  return { bus, app, h, state };
}

/** Call something that may throw; keep what it returned and what escaped. */
function attempt<T>(run: () => T): { returned: T | undefined; escaped: unknown } {
  try {
    return { returned: run(), escaped: undefined };
  } catch (e) {
    return { returned: undefined, escaped: e };
  }
}

describe('useCommandHistory: a throwing sync subscriber during undo and redo', () => {
  beforeAll(async () => {
    await waitForVueDetection();
  });
  afterEach(() => {
    resetCommandBus();
    vi.restoreAllMocks();
    events = [];
  });

  it('undo, subscriber on `past`: the undo does not land, nothing escapes, the signals agree', () => {
    const { bus, app, h, state } = setup();
    // Control: the signal is Vue's, so the effect below is a real subscriber.
    expect(isRef(h.past)).toBe(true);
    bus.dispatch('inc' as never, {} as never);
    expect(state()).toEqual({ value: 1, past: 1, future: 0, canUndo: true, canRedo: false });
    let threw = 0;
    let armed = false;
    const runner = effect(() => {
      if (h.past.value.length === 0 && armed) {
        threw++;
        throw boom;
      }
    });
    armed = true;
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { returned, escaped } = attempt(() => h.undo());

    // Control: the subscriber ran on the move and threw.
    expect(threw).toBe(1);
    expect(escaped).toBeUndefined();
    expect(returned?.action).toBe('inc');
    expect(app.undone).toBe(0);
    expect(state()).toEqual({ value: 1, past: 1, future: 0, canUndo: true, canRedo: false });
    // The subscriber's error is reported the way a throwing undo handler's is.
    expect(logged.mock.calls).toEqual([[expect.stringMatching(/^\[vapor-chamber\] \[ FAIL \] history:failed:move: Undo handler threw for "inc"/), boom]]);

    runner.effect.stop();
    h.undo();
    expect(state()).toEqual({ value: 0, past: 0, future: 1, canUndo: false, canRedo: true });
  });

  it('redo, subscriber on `future`: the redo does not land, nothing escapes, the signals agree', () => {
    const { bus, h, state } = setup();
    bus.dispatch('inc' as never, {} as never);
    h.undo();
    expect(state()).toEqual({ value: 0, past: 0, future: 1, canUndo: false, canRedo: true });
    let threw = 0;
    let armed = false;
    const runner = effect(() => {
      if (h.future.value.length === 0 && armed) {
        threw++;
        throw boom;
      }
    });
    armed = true;
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { escaped } = attempt(() => h.redo());

    expect(threw).toBe(1);
    expect(escaped).toBeUndefined();
    expect(state()).toEqual({ value: 0, past: 0, future: 1, canUndo: false, canRedo: true });
    expect(logged.mock.calls).toEqual([[expect.stringMatching(/^\[vapor-chamber\] \[ FAIL \] history:failed:move: Redo dispatch threw for "inc"/), boom]]);

    runner.effect.stop();
    h.redo();
    expect(state()).toEqual({ value: 1, past: 1, future: 0, canUndo: true, canRedo: false });
  });

  it('control, no throwing subscriber: what subscribers and handlers see, in order, is unchanged', () => {
    const { bus, h } = setup();
    const runners = [
      effect(() => void events.push(`past:${h.past.value.length}`)),
      effect(() => void events.push(`future:${h.future.value.length}`)),
      effect(() => void events.push(`canUndo:${h.canUndo.value}`)),
      effect(() => void events.push(`canRedo:${h.canRedo.value}`)),
    ];
    events.length = 0;

    bus.dispatch('inc' as never, {} as never);
    expect(events).toEqual(['handler', 'past:1', 'canUndo:true']);
    events.length = 0;

    h.undo();
    expect(events).toEqual(['past:0', 'future:1', 'canUndo:false', 'canRedo:true', 'undoHandler']);
    events.length = 0;

    h.redo();
    expect(events).toEqual(['past:1', 'future:0', 'canUndo:true', 'canRedo:false', 'handler']);
    for (const r of runners) r.effect.stop();
  });
});
