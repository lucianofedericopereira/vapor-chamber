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
 * `useCommandHistory(options)` takes ONE parameter. Without a `bus` option
 * (added in 1.29.0) it observes the SHARED bus from `getCommandBus()`. The
 * second argument was silently dropped, and no compiler objected: `tests/` was
 * not type-checked then (tsconfig.tests.json does it now). The history
 * subscribed to one bus while the loop dispatched on another, so the `onAfter`
 * hook the first bench is named for never fired, and the `past` stack the
 * second bench undoes/redoes was always empty - `undo()`/`redo()` returned
 * immediately without ever reaching the marked-dispatch path.
 *
 * Measured before the fix: `past.length` 0 after 10 dispatches, `undo()`
 * undefined. The benches now pass their bus as `useCommandHistory({ bus })`;
 * these assertions pin why a bus given any other way is not the one observed.
 *
 * The bench rows are stable ids, the same in every release, so the bench of
 * one release compares with the next by id: the list is pinned below.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it as plainIt } from 'vitest';
import { createCommandBus } from '../src/command-bus';
import { getCommandBus, resetCommandBus, setCommandBus, useCommandHistory } from '../src/chamber';
import { it } from '../src/vitest';

afterEach(() => resetCommandBus());

const IDS = [
  'history.dispatch', 'history.undoredo', 'origin.wrapped',
  'dispatch.sync.bare', 'dispatch.sync.parts3', 'query.sync.bare', 'query.sync.stepped', 'emit.listeners3',
  'dispatch.sync.wildcard', 'dispatch.batch100',
  'uid.counter', 'uid.uuid',
  'dispatch.async.bare', 'dispatch.async.parts3', 'dispatch.async.hook',
  'create.bus.sync', 'create.bus.async', 'create.store.undo', 'create.usecommand', 'create.usecommandhistory',
  'emit.none', 'emit.none.peer.mitt',
  'fanout.emit', 'fanout.peer.mitt', 'fanout.peer.eventemitter3', 'fanout.peer.tiny-emitter', 'fanout.peer.rxjs', 'fanout.map',
  'hot.fastlane.compiled', 'hot.floor', 'hot.peer.mitt', 'hot.dispatch',
  'lanefanout.live', 'lanefanout.snapshot', 'lanefanout.emit', 'lanefanout.peer.mitt', 'lanefanout.peer.eventemitter3',
  'compare.dispatch', 'compare.peer.mitt',
  'fanout50.dispatch', 'fanout50.emit',
  'persist.small', 'persist.items50',
  'transition.hooks9', 'transition.move', 'transition.enterleave', 'transition.dispatch',
  'stamp.path', 'stamp.query',
  'directive.direct', 'directive.delegate',
  'store.immediate.append10', 'store.immediate.append100', 'store.coalesced.append10', 'store.coalesced.append100',
  'store.immediate.count100', 'store.coalesced.count100',
  'signal.plain', 'signal.alien', 'signal.vue', 'signal.vue.watch', 'scope.empty', 'scope.signal',
  'signal.store.count100', 'signal.store.coalesced100',
];

/** The row ids of a bench source, in file order: each `bench('<id>'` at the start of a line. */
const idsOf = (src: string) => [...src.matchAll(/^\s*bench\('([^']+)'/gm)].map((m) => m[1]);
const SRC = readFileSync(resolve(__dirname, 'perf.bench.ts'), 'utf8');

describe('bench row ids', () => {
  plainIt('are the pinned list, each once, each a dotted lower-case id', () => {
    expect(idsOf(SRC)).toEqual(IDS);
    expect(new Set(IDS).size).toBe(IDS.length);
    for (const id of IDS) expect(id).toMatch(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/);
  });

  plainIt('positive control: a renamed row, or one written as a template, is caught', () => {
    expect(idsOf(SRC.replace("bench('dispatch.sync.bare'", "bench('dispatch.sync.plain'"))).not.toEqual(IDS);
    expect(idsOf(SRC.replace("bench('uid.uuid'", 'bench(`uid.uuid`'))).not.toEqual(IDS);
  });
});

describe('useCommandHistory bus selection', () => {
  it('observes the shared bus when given no bus option', ({ bus }) => {
    setCommandBus(bus);
    bus.register('act', (cmd) => cmd.target);
    const history = useCommandHistory({});

    for (let i = 0; i < 10; i++) bus.dispatch('act', i, { qty: i });

    expect(history.past.value).toHaveLength(10);
  });

  it('undo + redo reach the marked-dispatch path on that bus', ({ bus }) => {
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
    // `local`. The bus goes in the options, `useCommandHistory({ bus })`
    // (tests/composables-bus-option.test.ts). The type checker now rejects a
    // second argument, hence the cast that reproduces the old call.
    const history = (
      useCommandHistory as (o: object, bus?: unknown) => ReturnType<typeof useCommandHistory>
    )({}, local);

    for (let i = 0; i < 10; i++) local.dispatch('act', i, { qty: i });

    expect(history.past.value).toHaveLength(0);
    expect(getCommandBus()).not.toBe(local);
  });
});
