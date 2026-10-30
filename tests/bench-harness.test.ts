/**
 * The bench harness: the row ids of tests/perf.bench.ts, and the bus useCommandHistory observes.
 * Why: a bench that does not run the code its label names still yields a stable number that gets quoted.
 * Shows: the ids are the pinned list, unique and dotted, a rename is caught; history observes the shared bus without `bus`, undo and redo reach the marked path, an extra argument is ignored.
 * See: tests/composables-bus-option.test.ts.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it as plainIt } from 'vitest';
import { createCommandBus } from '../src/command-bus';
import { getCommandBus, resetCommandBus, setCommandBus, useCommandHistory } from '../src/chamber';
import { it } from '../src/vitest';

afterEach(() => resetCommandBus());

/** Stable across releases, so one release's bench compares with the next by id. */
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

    // redo re-dispatches through the bus: the path `_withOrigin` marks, which the undo+redo bench measures.
    expect(runs).toBe(2);
    expect(history.past.value).toHaveLength(1);
  });

  it('an extra bus argument is silently ignored, not honoured', () => {
    const local = createCommandBus();
    local.register('act', (cmd) => cmd.target);

    // A second argument is dropped (the bus goes in the options); the cast gets it past the type checker.
    const history = (
      useCommandHistory as (o: object, bus?: unknown) => ReturnType<typeof useCommandHistory>
    )({}, local);

    for (let i = 0; i < 10; i++) local.dispatch('act', i, { qty: i });

    expect(history.past.value).toHaveLength(0);
    expect(getCommandBus()).not.toBe(local);
  });
});
