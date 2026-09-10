/**
 * Bench-harness integrity.
 *
 * A bench that does not execute the code named in its label is worse than no
 * bench: it produces a number, the number is stable, and it gets quoted. The
 * whitepaper's rc.6 row quotes two figures from the `origin-marker paths` group
 * in `tests/perf.bench.ts` and concludes NEUTRAL. Both benches drove the
 * history like this:
 *
 *     const bus = createCommandBus();
 *     const history = useCommandHistory({}, bus);   // <- second argument
 *     for (...) bus.dispatch('act', i, { qty: i });
 *
 * `useCommandHistory(options)` takes ONE parameter and always observes the
 * SHARED bus from `getCommandBus()`. The second argument is silently dropped -
 * `tsconfig.typecheck.json` includes only `src/**` plus two named test files,
 * so `tests/` is never type-checked and no compiler objected. The history
 * subscribed to one bus while the loop dispatched on another, so the `onAfter`
 * hook the first bench is named for never fired, and the `past` stack the
 * second bench undoes/redoes was always empty - `undo()`/`redo()` returned
 * immediately without ever reaching the marked-dispatch path.
 *
 * Measured before the fix: `past.length` 0 after 10 dispatches, `undo()`
 * undefined. The benches now install on the shared bus; these assertions pin
 * the contract that makes that the only correct shape.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createCommandBus } from '../src/command-bus';
import { getCommandBus, resetCommandBus, setCommandBus, useCommandHistory } from '../src/chamber';

afterEach(() => resetCommandBus());

describe('useCommandHistory bus selection', () => {
  it('observes the shared bus, so a bench must install its bus there', () => {
    const bus = createCommandBus();
    setCommandBus(bus);
    bus.register('act', (cmd) => cmd.target);
    const history = useCommandHistory({});

    for (let i = 0; i < 10; i++) bus.dispatch('act', i, { qty: i });

    expect(history.past.value).toHaveLength(10);
  });

  it('undo + redo reach the marked-dispatch path on that bus', () => {
    const bus = createCommandBus();
    setCommandBus(bus);
    let runs = 0;
    bus.register('act', (cmd) => {
      runs++;
      return cmd.target;
    });
    const history = useCommandHistory({});

    bus.dispatch('act', 1, { qty: 1 });
    expect(runs).toBe(1);

    expect(history.undo()).toBeDefined();
    expect(history.redo()).toBeDefined();

    // redo re-dispatches through the bus - the path `_withOrigin` marks, and
    // the one the "undo+redo cycle" bench exists to measure.
    expect(runs).toBe(2);
    expect(history.past.value).toHaveLength(1);
  });

  it('an extra bus argument is silently ignored, not honoured', () => {
    const local = createCommandBus();
    local.register('act', (cmd) => cmd.target);

    // The shape the benches used. `useCommandHistory` has one parameter, so
    // this attaches to the shared bus and observes nothing dispatched on
    // `local`. Pinned because nothing else can catch it: tests are not
    // type-checked, and the composable takes no bus option the way
    // `useSharedCommandState({ bus })` does.
    const history = (
      useCommandHistory as (o: object, bus?: unknown) => ReturnType<typeof useCommandHistory>
    )({}, local);

    for (let i = 0; i < 10; i++) local.dispatch('act', i, { qty: i });

    expect(history.past.value).toHaveLength(0);
    expect(getCommandBus()).not.toBe(local);
  });
});
