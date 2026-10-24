/**
 * vapor-chamber - Performance benchmarks
 *
 * Run with: npx vitest bench tests/perf.bench.ts
 * Or:       npm run test -- --bench tests/perf.bench.ts
 *
 * These are not CI tests - they measure throughput on the developer's machine.
 *
 * Every row times the work its id names and nothing else. Buses, stores,
 * composables and peers are built in the group's setup, outside the timed
 * function, and a row that changes state resets it in its own beforeEach,
 * which tinybench runs outside the timing. Building is timed only in the
 * `create.*` rows. Each row's name is a stable id that never changes between
 * releases (tests/bench-harness.test.ts pins the list), with the old label as
 * the comment above it.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { BenchFnOptions } from 'vitest';
import { effectScope, onScopeDispose, ref, watchEffect } from 'vue';
import { createCommandBus, createAsyncCommandBus, configureUid, _resetUid, _withOrigin } from '../src/command-bus';
import { defineChamberStore as defineCoreStore } from '../src/store/core';
import { createFastLane } from '../src/fast-lane';
import { useCommand, useCommandHistory } from '../src/chamber';
import { createTransitionBridge } from '../src/transitions';
import { createDirectivePlugin } from '../src/directives';
import { stampActiveLinks } from '@router/dom';
import { signal, waitForVueDetection } from '../src/chamber';
import { defineChamberStore } from '../src/store';
import { alienSignalAdapter } from '../src/alien-signals';
import { signal as _alienSignal } from 'alien-signals';
import { saveTo } from '../src/store-persist';

const _alienFactory = alienSignalAdapter(_alienSignal as any);

// Vitest 5 made `bench` a test-context fixture: benches register inside a test
// and run through `bench.compare()`. Each describe below shadows `bench` with a
// collector whose registrations run as ONE compare, so a group's rows come from
// the same run - which is what scripts/bench-ratios-reporter.mjs relies on when
// it divides two of them. The reporter matches the ids exactly.
type Fn = () => unknown;
function benchGroup(): (id: string, a: Fn | BenchFnOptions, b?: Fn) => void {
  const defs: Array<{ id: string; opts: BenchFnOptions; fn: Fn }> = [];
  it('compare', async ({ bench }) => {
    await bench.compare(...defs.map((d) => bench(d.id, d.opts, d.fn)));
  });
  return (id, a, b) => {
    defs.push(typeof a === 'function' ? { id, opts: {}, fn: a } : { id, opts: a, fn: b as Fn });
  };
}

// ---------------------------------------------------------------------------
// Origin-marker paths - where the `_withOrigin` slot replaced per-site work.
//
// The core benches above install no chamber and no sync plugin, so they never
// exercised the code the slot deleted:
//   - chamber's onAfter hook ran a 4-field `expectedRedo` identity compare on
//     EVERY dispatch while a history was installed;
//   - the three marker sites each allocated `{ ...payload, __origin }` per
//     marked dispatch (every cross-tab receive, MCP call, and redo).
// ---------------------------------------------------------------------------

// The histories take their bus as `{ bus }`: without it `useCommandHistory`
// observes the shared bus (tests/bench-harness.test.ts). Each iteration starts
// from an empty history, as one built per iteration did.
describe('origin-marker paths', () => {
  const bench = benchGroup();
  const histBus = createCommandBus();
  histBus.register('act', (cmd) => cmd.target);
  const undoBus = createCommandBus();
  undoBus.register('act', (cmd) => cmd.target);
  const originBus = createCommandBus();
  originBus.register('act', (cmd) => cmd.target);
  let history!: ReturnType<typeof useCommandHistory>;
  let undoHistory!: ReturnType<typeof useCommandHistory>;
  beforeAll(async () => {
    await waitForVueDetection();
    history = useCommandHistory({ bus: histBus });
    undoHistory = useCommandHistory({ bus: undoBus });
  });
  afterAll(() => {
    history.dispose();
    undoHistory.dispose();
  });

  // dispatch with useCommandHistory installed - 10k (onAfter hook cost)
  bench('history.dispatch', { beforeEach: () => history.clear() }, () => {
    for (let i = 0; i < 10_000; i++) histBus.dispatch('act', i, { qty: i });
  });

  // undo+redo cycle x 2k (marked-dispatch path)
  bench('history.undoredo', { beforeEach: () => undoHistory.clear() }, () => {
    for (let i = 0; i < 2_000; i++) {
      undoBus.dispatch('act', i, { qty: i });
      undoHistory.undo();
      undoHistory.redo();
    }
  });

  // _withOrigin-wrapped dispatch - 10k
  bench('origin.wrapped', () => {
    for (let i = 0; i < 10_000; i++) {
      _withOrigin('sync', () => originBus.dispatch('act', i, { qty: i }));
    }
  });
});

describe('core dispatch throughput', () => {
  const bench = benchGroup();
  const bare = createCommandBus();
  bare.register('test', (cmd) => cmd.target);
  const parts = createCommandBus();
  // Three plugins, each a part the bus places: an observer, a recorder, a work step.
  parts.use({ started: () => {} });
  parts.use({ settled: () => {} });
  parts.use({ begin: () => undefined });
  parts.on('*', () => {});
  parts.register('test', (cmd) => cmd.target);
  const queries = createCommandBus();
  queries.register('getUser', (cmd) => ({ id: cmd.target }));
  const stepped = createCommandBus();
  stepped.register('getUser', (cmd) => ({ id: cmd.target }));
  stepped.use({ begin: () => undefined }); // a step: the stepped path
  stepped.onAfter(() => {});
  const emits = createCommandBus();
  emits.on('test', () => {});
  emits.on('test', () => {});
  emits.on('test', () => {});
  const wildcard = createCommandBus();
  wildcard.on('cart*', () => {});
  wildcard.register('cartAdd', () => {});
  const batch = createCommandBus();
  batch.register('test', () => 'ok');
  const cmds = Array.from({ length: 100 }, (_, i) => ({ action: 'test', target: i }));

  // syncDispatch - bare handler, no plugins
  bench('dispatch.sync.bare', () => {
    for (let i = 0; i < 10_000; i++) bare.dispatch('test', i);
  });

  // syncDispatch - 3 plugins + 1 listener
  bench('dispatch.sync.parts3', () => {
    for (let i = 0; i < 10_000; i++) parts.dispatch('test', i);
  });

  // syncQuery - bare handler, no plugins
  bench('query.sync.bare', () => {
    for (let i = 0; i < 10_000; i++) queries.query('getUser', i);
  });

  // syncQuery - 1 plugin + 1 after-hook (full runner path)
  bench('query.sync.stepped', () => {
    for (let i = 0; i < 10_000; i++) stepped.query('getUser', i);
  });

  // emit - 3 listeners, no handler
  bench('emit.listeners3', () => {
    for (let i = 0; i < 10_000; i++) emits.emit('test', i);
  });

  // matchesPattern - wildcard prefix*
  bench('dispatch.sync.wildcard', () => {
    for (let i = 0; i < 10_000; i++) wildcard.dispatch('cartAdd', i);
  });

  // dispatchBatch - 100 commands
  bench('dispatch.batch100', () => {
    for (let i = 0; i < 100; i++) batch.dispatchBatch(cmds);
  });
});

describe('meta overhead - uid generator comparison', () => {
  const bench = benchGroup();
  const counter = createCommandBus();
  counter.register('test', () => {});
  const uuid = createCommandBus();
  uuid.register('test', () => {});
  // Default: counter + per-process random prefix. About 12 ns per call against
  // about 104 ns for crypto.randomUUID (Node 24, 2026-08-17, hrtime medians over
  // 21x200k reps - quote the runtime with the number). What this bench measures
  // is the DISPATCH-level ratio (about 2.5x), not the per-call one (about 8x):
  // the rest of the dispatch dilutes it.
  // dispatch - default counter-based uid
  bench('uid.counter', { beforeEach: () => _resetUid() }, () => {
    for (let i = 0; i < 10_000; i++) counter.dispatch('test', i);
  });

  // Opt-in via configureUid - for distributed tracing / cross-process IDs.
  // dispatch - crypto.randomUUID via configureUid
  bench('uid.uuid', { beforeEach: () => configureUid(() => crypto.randomUUID()), afterEach: () => _resetUid() }, () => {
    for (let i = 0; i < 10_000; i++) uuid.dispatch('test', i);
  });
});

describe('async dispatch throughput', () => {
  const bench = benchGroup();
  const bare = createAsyncCommandBus();
  bare.register('test', async (cmd) => cmd.target);
  const parts = createAsyncCommandBus();
  // Three plugins, each a part the bus places: an observer, a recorder, a work step.
  parts.use({ started: () => {} });
  parts.use({ settled: () => {} });
  parts.use({ begin: () => undefined });
  parts.on('*', () => {});
  parts.register('test', async (cmd) => cmd.target);
  const hooked = createAsyncCommandBus();
  hooked.onAfter(() => {});
  hooked.register('test', async (cmd) => cmd.target);

  // asyncDispatch - bare handler
  bench('dispatch.async.bare', async () => {
    for (let i = 0; i < 1_000; i++) await bare.dispatch('test', i);
  });

  // The async counterpart of dispatch.sync.parts3: the parts' boundaries
  // (plugin:failed:plugin) sit on this path, and the work they add is paid
  // here, not on the bare row above.
  // asyncDispatch - 3 plugins + 1 listener
  bench('dispatch.async.parts3', async () => {
    for (let i = 0; i < 1_000; i++) await parts.dispatch('test', i);
  });

  // An async dispatch with one onAfter hook, as history(), useCommandHistory,
  // useCommandError and the devtools install.
  bench('dispatch.async.hook', async () => {
    for (let i = 0; i < 1_000; i++) await hooked.dispatch('test', i);
  });
});

// Creation, timed on its own: each row builds and disposes 1k of one thing,
// with nothing dispatched. The rows above build theirs outside the timing.
describe('creation (1k each, created and disposed)', () => {
  const bench = benchGroup();
  const undoStore = defineCoreStore('benchUndo', {
    state: () => ({ n: 0 }),
    reducers: { inc: (s: { n: number }) => ({ n: s.n + 1 }) },
    undo: true,
  });
  const storeBus = createCommandBus();
  const composableBus = createCommandBus();
  beforeAll(async () => {
    await waitForVueDetection();
  });

  bench('create.bus.sync', () => {
    for (let i = 0; i < 1_000; i++) createCommandBus().dispose();
  });

  bench('create.bus.async', () => {
    for (let i = 0; i < 1_000; i++) createAsyncCommandBus().dispose();
  });

  bench('create.store.undo', () => {
    for (let i = 0; i < 1_000; i++) undoStore(storeBus).$dispose();
  });

  bench('create.usecommand', () => {
    for (let i = 0; i < 1_000; i++) {
      const scope = effectScope();
      scope.run(() => useCommand({ bus: composableBus }));
      scope.stop();
    }
  });

  bench('create.usecommandhistory', () => {
    for (let i = 0; i < 1_000; i++) {
      const scope = effectScope();
      scope.run(() => useCommandHistory({ bus: composableBus }));
      scope.stop();
    }
  });
});

// Functional perf sanity test (always runs, not just in bench mode)
describe('performance sanity', () => {
  it('10k sync dispatches complete under 200ms', () => {
    const bus = createCommandBus();
    bus.register('test', (cmd) => cmd.target);
    const start = performance.now();
    for (let i = 0; i < 10_000; i++) {
      bus.dispatch('test', i);
    }
    const elapsed = performance.now() - start;
    console.log(`  10k sync dispatches: ${elapsed.toFixed(1)}ms`);
    expect(elapsed).toBeLessThan(200);
  });

  it('10k queries complete under 200ms', () => {
    const bus = createCommandBus();
    bus.register('test', (cmd) => cmd.target);
    const start = performance.now();
    for (let i = 0; i < 10_000; i++) {
      bus.query('test', i);
    }
    const elapsed = performance.now() - start;
    console.log(`  10k sync queries:    ${elapsed.toFixed(1)}ms`);
    expect(elapsed).toBeLessThan(200);
  });

  it('10k emits complete under 100ms', () => {
    const bus = createCommandBus();
    bus.on('test', () => {});
    const start = performance.now();
    for (let i = 0; i < 10_000; i++) {
      bus.emit('test', i);
    }
    const elapsed = performance.now() - start;
    console.log(`  10k emits:           ${elapsed.toFixed(1)}ms`);
    expect(elapsed).toBeLessThan(100);
  });

});

// ---------------------------------------------------------------------------
// Comparative throughput vs other small event/dispatch libraries.
//
// vapor-chamber is a command bus (dispatch with plugins, hooks, listeners,
// results). The closest "small lib" peers are pure event emitters - mitt,
// eventemitter3, tiny-emitter - plus a hand-rolled `Map<string, Set<fn>>` baseline. The point
// of these benches is to show that the lib's emit-fan-out (the closest apple
// to apple) is competitive with hand-rolled, with all the extra machinery
// (results, plugins, hooks, before/after, batch, request) on top.
//
// Reading these numbers:
//   - vapor-chamber `emit` should be in the same order as mitt.
//   - vapor-chamber `dispatch` does meaningfully more (plugin chain, meta
//     stamping, results) - expect it to be slower than raw emit, but still
//     competitive with hand-rolled middleware patterns.
// ---------------------------------------------------------------------------

import mitt from 'mitt';
import EventEmitter3 from 'eventemitter3';
import TinyEmitter from 'tiny-emitter';
import { Subject } from 'rxjs';

describe('emit fast path - no listeners', () => {
  const bench = benchGroup();
  const bus = createCommandBus();
  const m = mitt<{ x: number }>();

  // vapor-chamber bus.emit with NO listeners (10k)
  bench('emit.none', () => {
    for (let i = 0; i < 10_000; i++) bus.emit('nobody-listening', i);
  });

  // mitt with NO listeners (10k)
  bench('emit.none.peer.mitt', () => {
    for (let i = 0; i < 10_000; i++) m.emit('x', i);
  });
});

describe('comparative emit fan-out (10k events x 3 listeners)', () => {
  const bench = benchGroup();
  const bus = createCommandBus();
  bus.on('evt', () => {});
  bus.on('evt', () => {});
  bus.on('evt', () => {});
  const m = mitt<{ evt: number }>();
  m.on('evt', () => {});
  m.on('evt', () => {});
  m.on('evt', () => {});
  const e = new EventEmitter3();
  e.on('evt', () => {});
  e.on('evt', () => {});
  e.on('evt', () => {});
  const t = new (TinyEmitter as any)();
  t.on('evt', () => {});
  t.on('evt', () => {});
  t.on('evt', () => {});
  const s = new Subject<number>();
  s.subscribe(() => {});
  s.subscribe(() => {});
  s.subscribe(() => {});
  const handlers = new Map<string, Set<(i: number) => void>>();
  function on(evt: string, fn: (i: number) => void): void {
    let set = handlers.get(evt);
    if (!set) { set = new Set(); handlers.set(evt, set); }
    set.add(fn);
  }
  function emit(evt: string, i: number): void {
    const set = handlers.get(evt);
    if (set) for (const fn of set) fn(i);
  }
  on('evt', () => {});
  on('evt', () => {});
  on('evt', () => {});

  // vapor-chamber bus.emit - 3 listeners
  bench('fanout.emit', () => {
    for (let i = 0; i < 10_000; i++) bus.emit('evt', i);
  });

  // mitt - 3 listeners
  bench('fanout.peer.mitt', () => {
    for (let i = 0; i < 10_000; i++) m.emit('evt', i);
  });

  // eventemitter3 - 3 listeners
  bench('fanout.peer.eventemitter3', () => {
    for (let i = 0; i < 10_000; i++) e.emit('evt', i);
  });

  // tiny-emitter - 3 listeners
  bench('fanout.peer.tiny-emitter', () => {
    for (let i = 0; i < 10_000; i++) t.emit('evt', i);
  });

  // rxjs Subject - 3 subscribers
  bench('fanout.peer.rxjs', () => {
    for (let i = 0; i < 10_000; i++) s.next(i);
  });

  // raw Map<string, Set<fn>> - 3 listeners (hand-rolled baseline)
  bench('fanout.map', () => {
    for (let i = 0; i < 10_000; i++) emit('evt', i);
  });
});

// ---------------------------------------------------------------------------
// Fast lane - vapor-chamber's real-real-hot-path dispatcher.
//
// Trades the bus's ergonomics (Command envelope, results, plugins, hooks,
// listeners, schema, batch, request/response, AbortController) for raw
// throughput. Use for game ticks, trading data, audio, scroll/mousemove,
// physics steps. NOT for general app dispatch.
// ---------------------------------------------------------------------------

describe('fast lane - single-handler hot dispatch (10k)', () => {
  const bench = benchGroup();
  const lane = createFastLane();
  const onTick = lane.compile<number, number>('tick', (n) => n * 2);
  const fn = (n: number) => n * 2;
  const m = mitt<{ tick: number }>();
  m.on('tick', () => {});
  const bus = createCommandBus();
  bus.register('tick', (cmd) => cmd.target * 2);

  // vapor-chamber fast-lane compile + dispatch (compiled once, in setup)
  bench('hot.fastlane.compiled', () => {
    let acc = 0;
    for (let i = 0; i < 10_000; i++) acc = onTick(i);
    if (acc < 0) console.log(acc);
  });

  // direct function call (theoretical floor)
  bench('hot.floor', () => {
    let acc = 0;
    for (let i = 0; i < 10_000; i++) acc = fn(i);
    if (acc < 0) console.log(acc);
  });

  // mitt (closest peer - emit fires listeners, no return)
  bench('hot.peer.mitt', () => {
    for (let i = 0; i < 10_000; i++) m.emit('tick', i);
  });

  // vapor-chamber bus.dispatch (general-purpose, for comparison)
  bench('hot.dispatch', () => {
    for (let i = 0; i < 10_000; i++) bus.dispatch('tick', i);
  });
});

describe('fast lane - multi-subscriber emit fan-out (10k events x 3 listeners)', () => {
  const bench = benchGroup();
  const live = createFastLane();
  live.on('evt', () => {});
  live.on('evt', () => {});
  live.on('evt', () => {});
  const snapshot = createFastLane({ removal: 'snapshot' });
  snapshot.on('evt', () => {});
  snapshot.on('evt', () => {});
  snapshot.on('evt', () => {});
  const bus = createCommandBus();
  bus.on('evt', () => {});
  bus.on('evt', () => {});
  bus.on('evt', () => {});
  const m = mitt<{ evt: number }>();
  m.on('evt', () => {});
  m.on('evt', () => {});
  m.on('evt', () => {});
  const e = new EventEmitter3();
  e.on('evt', () => {});
  e.on('evt', () => {});
  e.on('evt', () => {});

  // vapor-chamber fast-lane emit (live, default)
  bench('lanefanout.live', () => {
    for (let i = 0; i < 10_000; i++) live.emit('evt', i);
  });

  // vapor-chamber fast-lane emit (removal: 'snapshot')
  bench('lanefanout.snapshot', () => {
    for (let i = 0; i < 10_000; i++) snapshot.emit('evt', i);
  });

  // vapor-chamber bus.emit (general-purpose, for comparison)
  bench('lanefanout.emit', () => {
    for (let i = 0; i < 10_000; i++) bus.emit('evt', i);
  });

  // mitt - 3 listeners (peer)
  bench('lanefanout.peer.mitt', () => {
    for (let i = 0; i < 10_000; i++) m.emit('evt', i);
  });

  // The EventEmitter migration guide's peer: the fast lane is what it
  // recommends for EventEmitter's pub/sub, so it is compared here, same run.
  // eventemitter3 - 3 listeners (peer)
  bench('lanefanout.peer.eventemitter3', () => {
    for (let i = 0; i < 10_000; i++) e.emit('evt', i);
  });
});

describe('comparative dispatch (10k dispatches, single handler)', () => {
  const bench = benchGroup();
  // vapor-chamber's `dispatch` does substantively more than `emit`: meta
  // stamping, plugin chain, hooks, result allocation. The benches below
  // measure the full path for a fair "is the lib competitive?" comparison
  // against minimal-feature peers.
  const bus = createCommandBus();
  bus.register('act', (cmd) => cmd.target);
  const m = mitt<{ act: number }>();
  m.on('act', () => {}); // can't capture a return - emit is fire-only

  // vapor-chamber bus.dispatch - bare handler, no plugins
  bench('compare.dispatch', () => {
    for (let i = 0; i < 10_000; i++) bus.dispatch('act', i);
  });

  // mitt - emit (bus.emit equivalent, no result)
  bench('compare.peer.mitt', () => {
    for (let i = 0; i < 10_000; i++) m.emit('act', i);
  });
});

// ---------------------------------------------------------------------------
// Listener fan-out - tests the cost of the on() / emit() listener walk.
// The benefit of bucketing exact-match listeners is supposed to scale with
// listener count: silent at 3 listeners, real at 50+.
// ---------------------------------------------------------------------------

describe('listener fan-out', () => {
  const bench = benchGroup();
  const dispatches = createCommandBus();
  dispatches.register('hot', (cmd) => cmd.target);
  for (let i = 0; i < 50; i++) dispatches.on('hot', () => {});
  for (let i = 0; i < 5; i++) dispatches.on('hot:*', () => {});
  const emits = createCommandBus();
  for (let i = 0; i < 50; i++) emits.on('evt', () => {});
  for (let i = 0; i < 5; i++) emits.on('evt:*', () => {});

  // dispatch with 50 exact-match listeners + 5 wildcards
  bench('fanout50.dispatch', () => {
    for (let i = 0; i < 5_000; i++) dispatches.dispatch('hot', i);
  });

  // emit with 50 exact-match listeners + 5 wildcards
  bench('fanout50.emit', () => {
    for (let i = 0; i < 5_000; i++) emits.emit('evt', i);
  });
});

// ---------------------------------------------------------------------------
// A store's persist - every write schedules one save per microtask: a burst of
// writes stringifies and stores once. The bench awaits that microtask, so the
// save is inside the timed call.
// ---------------------------------------------------------------------------

function makeMemoryStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, v); },
  };
}

describe('store persist throughput', () => {
  const bench = benchGroup();
  type Small = { counter: number };
  type Items = { items: { id: number; name: string }[] };
  const small = defineCoreStore('benchSmall', {
    state: (): Small => ({ counter: 0 }),
    reducers: { inc: (s: Small) => ({ counter: s.counter + 1 }) },
    persist: saveTo({ key: 'bench:small', storage: makeMemoryStorage() }),
  })(createCommandBus());
  const items = defineCoreStore('benchItems', {
    state: (): Items => ({ items: Array.from({ length: 50 }, (_, i) => ({ id: i, name: 'item-' + i })) }),
    reducers: { touch: (s: Items) => ({ items: [{ ...s.items[0], id: s.items[0].id + 1 }, ...s.items.slice(1)] }) },
    persist: saveTo({ key: 'bench:medium', storage: makeMemoryStorage() }),
  })(createCommandBus());
  afterAll(() => {
    small.$dispose();
    items.$dispose();
  });

  // 100 rapid writes of a store with persist (small state)
  bench('persist.small', async () => {
    for (let i = 0; i < 100; i++) small.inc();
    await Promise.resolve();
  });

  // 100 rapid writes of a store with persist (50-item array state)
  bench('persist.items50', async () => {
    for (let i = 0; i < 100; i++) items.touch();
    await Promise.resolve();
  });
});

// ---------------------------------------------------------------------------
// Transition bridge throughput - current-Vue baseline (the running version is in
// benchProvenance; recorded baseline blocks below stay literal)
//
// These benches lock the JS-layer dispatch cost of the transition bridge so
// any future regression in the hook-dispatch path is visible regardless of Vue
// version. onMove is called by hand here, as an app calls it: Vue has no move
// hook (tests/vue-no-move-hook.test.ts).
//
// Reading these numbers:
//   - "all 9 hooks" covers the full enter+leave lifecycle in one sequence.
//   - "onMove x 10k" is the move path's baseline.
//   - "onMove vs bus.dispatch" confirms the bridge adds only dispatch overhead.
//
// Baselines (v1.4.0, beta.13, 2026-05-28):
//   all 9 hooks x 1k        713 hz   (1.40ms / 1k sequences)   runs: 709 / 717
//   onMove only x 10k     1,018 hz   (0.98ms / 10k calls)      runs: 1,067 / 969
//   onEnter + onLeave x 5k  984 hz   (1.02ms / 5k pairs)       runs: 1,000 / 969
//   raw bus.dispatch x 10k 1,757 hz  (0.57ms / 10k calls)      runs: 1,750 / 1,764
//
// Baselines (v1.5.0, beta.14, 2026-06-05):
//   all 9 hooks x 1k        776 hz   (+9% vs beta.13)
//   onMove only x 10k     1,096 hz   (+8% vs beta.13)
//   onEnter + onLeave x 5k 1,022 hz  (+4% vs beta.13)
//   raw bus.dispatch x 10k 1,904 hz  (+8% vs beta.13)
//   -> scheduler flush improvements in beta.14 account for the uplift
//   -> bridge overhead ~37ns/call (dispatchSafe try/catch vs bare dispatch)
//   -> onMove has higher run-to-run variance (try/catch inhibits V8 inlining under GC)
//
// Baselines (v1.6.0, beta.15, 2026-06-11, dev host, median of 3 runs):
//   all 9 hooks x 1k        707 hz   runs: 684 / 724
//   onMove only x 10k     1,042 hz   runs: 1,024 / 1,053
//   onEnter + onLeave x 5k  981 hz   runs: 962 / 992
//   raw bus.dispatch x 10k 1,815 hz  runs: 1,805 / 1,834
//   -> ~3-8% under the beta.14 reference UNIFORMLY - including raw bus.dispatch,
//     which has NO Vue dependency, so Vue's version cannot have moved it. The
//     shift is host/load variance, not a beta.15 regression; numbers land on the
//     beta.13 reference. beta.15 changed no code on these paths (docs + one guard
//     on the non-hot v-vc-command click handler). Canonical cross-beta deltas
//     would need beta.14 re-run on THIS host.
// These baselines were timed with the bus and bridge built inside each call.
// ---------------------------------------------------------------------------

describe('transition bridge throughput', () => {
  const bench = benchGroup();
  const el = { tagName: 'DIV' } as unknown as Element;
  const done = () => {};
  const modal = createTransitionBridge({ bus: createCommandBus({ onMissing: 'ignore' }), namespace: 'modal' });
  const list = createTransitionBridge({ bus: createCommandBus({ onMissing: 'ignore' }), namespace: 'list' });
  const drawer = createTransitionBridge({ bus: createCommandBus({ onMissing: 'ignore' }), namespace: 'drawer' });
  const raw = createCommandBus({ onMissing: 'ignore' });

  // createTransitionBridge - all 9 hooks (1k sequences)
  bench('transition.hooks9', () => {
    for (let i = 0; i < 1_000; i++) {
      modal.onBeforeEnter(el);
      modal.onEnter(el, done);
      modal.onAfterEnter(el);
      modal.onEnterCancelled(el);
      modal.onBeforeLeave(el);
      modal.onLeave(el, done);
      modal.onAfterLeave(el);
      modal.onLeaveCancelled(el);
      modal.onMove(el);
    }
  });

  // createTransitionBridge - onMove only x 10k
  bench('transition.move', () => {
    for (let i = 0; i < 10_000; i++) list.onMove(el);
  });

  // createTransitionBridge - onEnter + onLeave x 5k (enter/leave cycle)
  bench('transition.enterleave', () => {
    for (let i = 0; i < 5_000; i++) {
      drawer.onEnter(el, done);
      drawer.onLeave(el, done);
    }
  });

  // createTransitionBridge - onMove vs raw bus.dispatch (overhead delta)
  bench('transition.dispatch', () => {
    for (let i = 0; i < 10_000; i++) raw.dispatch('listMove', { tagName: 'DIV' });
  });
});

// Vue 3.6.0-rc.2 (#15127) flipped compiler-vapor event delegation from
// opt-out to opt-in - direct per-element listeners are now the default for
// compiled `@click`. v-vc-command mirrors that same trade-off with its own
// opt-in `.delegate` modifier (src/directives.ts): one shared document
// listener instead of N per-element ones for large v-for'd action lists.
//
// MEASURED (5k elements, this machine): delegate mode is ~1.3x SLOWER to
// mount+unmount than direct mode, not faster - the shared-counter branch
// costs slightly more per element than a bare (mocked) addEventListener
// call. That is the honest number; do not read `.delegate` as a mount-speed
// optimization. Its actual payoff is standing LISTENER COUNT while mounted
// (1 vs N - real memory/retained-object pressure for thousands of rows,
// invisible to a mount/unmount-cost bench), which is why it stays opt-in
// exactly like Vue's own default: worth it for large, mostly-static lists,
// not a blanket win.
// ---------------------------------------------------------------------------
// Active-link stamping - the piece that scales with PAGE SIZE rather than
// route count. `afterEach` fires on query-only commits too (usePagination, a
// sort toggle, a search box calling setQuery per keystroke), and on those the
// path is unchanged so every stamp recomputes to the value already in the DOM.
// The router's `stamp` closure memoises the last stamped path; these rows are
// what that memo is worth on a page with a mega-menu and a footer.
// ---------------------------------------------------------------------------

describe('active-link stamping - N anchors x M commits', () => {
  const bench = benchGroup();
  const ANCHORS = 500;
  const COMMITS = 50;

  function buildRoot(n: number): ParentNode {
    // A minimal ParentNode: stampActiveLinks only calls querySelectorAll, and
    // each anchor only needs href + the attribute methods.
    const anchors = Array.from({ length: n }, (_, i) => {
      const attrs = new Set<string>();
      return {
        href: `https://example.test/admin/section-${i % 25}/item-${i}`,
        getAttribute: () => null,
        hasAttribute: (name: string) => attrs.has(name),
        removeAttribute: (name: string) => attrs.delete(name),
        toggleAttribute: (name: string, force: boolean) => {
          if (force) attrs.add(name);
          else attrs.delete(name);
          return force;
        },
      } as unknown as HTMLAnchorElement;
    });
    return { querySelectorAll: () => anchors } as unknown as ParentNode;
  }

  const root = buildRoot(ANCHORS);

  // 50 PATH commits x 500 anchors (full walk, unavoidable)
  bench('stamp.path', () => {
    for (let i = 0; i < COMMITS; i++) {
      stampActiveLinks('/admin', `/section-${i % 25}/item-${i}`, root);
    }
  });

  // 50 QUERY-ONLY commits x 500 anchors (what the memo skips)
  bench('stamp.query', () => {
    // Same path every time - this is the per-keystroke case, and every one of
    // these walks produced stamps identical to the ones already there.
    for (let i = 0; i < COMMITS; i++) {
      stampActiveLinks('/admin', '/section-3/item-3', root);
    }
  });
});

describe('directive delegation (.delegate) - mount/unmount cost at scale', () => {
  const bench = benchGroup();
  const N = 5_000;

  // Minimal Element mock - same shape as tests/directives.test.ts's, trimmed
  // to what mounted()/beforeUnmount() touch. No real DOM needed: delegate
  // mode's cost is dominated by (de)registration, not event dispatch.
  // NOT A TEARDOWN CHECK. `removeEventListener` here ignores the handler and
  // the options, so this mock cannot tell a real removal from a mismatched one
  // and could not have caught the leak rc9/4 fixed. It is shaped for COST -
  // the (de)registration work per element - and nothing else. Teardown
  // correctness is asserted in tests/directives-vapor-fixture.test.ts against
  // a real document, by comparing the remove call with the add call.
  function mockDoc() {
    const listeners = new Map<string, Function>();
    return {
      addEventListener(type: string, fn: Function) { listeners.set(type, fn); },
      removeEventListener(type: string) { listeners.delete(type); },
    };
  }
  const sharedDoc = mockDoc();

  function mockEl(): Element {
    return {
      tagName: 'BUTTON',
      classList: { add() {}, remove() {} },
      addEventListener() {},
      removeEventListener() {},
      ownerDocument: sharedDoc,
      parentElement: null,
      dataset: {},
    } as unknown as Element;
  }

  function installed() {
    const directives = new Map<string, any>();
    createDirectivePlugin().install({ directive(name: string, def: any) { directives.set(name, def); } } as any);
    return directives.get('vc-command');
  }
  const direct = installed();
  const delegated = installed();
  const els = Array.from({ length: N }, mockEl);
  const plain = { arg: 'command', value: 'a', modifiers: {} };
  const delegate = { arg: 'command', value: 'a', modifiers: { delegate: true } };
  const unbind = { arg: 'command' };

  // mount + unmount 5000 direct listeners (default)
  bench('directive.direct', () => {
    for (const el of els) direct.mounted(el, plain);
    for (const el of els) direct.beforeUnmount(el, unbind);
  });

  // mount + unmount 5000 delegated listeners (.delegate)
  bench('directive.delegate', () => {
    for (const el of els) delegated.mounted(el, delegate);
    for (const el of els) delegated.beforeUnmount(el, unbind);
  });
});

// ---------------------------------------------------------------------------
// A store - immediate vs coalesced (plan 1.32 4e: useCommandState folded into
// the store)
//
// Each row runs a burst of a store's action from its reset state: the
// dispatch and state-write cost in vapor-chamber's layer, below Vue's runtime.
//   - "immediate" writes the state per dispatch; each write would re-render a
//     template that reads it.
//   - "coalesced" chains the burst and writes once, a microtask later. The bench
//     measures the synchronous cost; the deferred write lands before the next
//     iteration's reset.
// ---------------------------------------------------------------------------

type BenchList = { items: number[] };
type BenchCount = { n: number };
const listNow = defineChamberStore('list', { state: (): BenchList => ({ items: [] }), reducers: { append: (s: BenchList, x: number) => ({ items: [...s.items, x] }) } });
const listLater = defineChamberStore('list', { state: (): BenchList => ({ items: [] }), reducers: { append: (s: BenchList, x: number) => ({ items: [...s.items, x] }) }, coalesce: true });
const countNow = defineChamberStore('count', { state: (): BenchCount => ({ n: 0 }), reducers: { inc: (s: BenchCount) => ({ n: s.n + 1 }) } });
const countLater = defineChamberStore('count', { state: (): BenchCount => ({ n: 0 }), reducers: { inc: (s: BenchCount) => ({ n: s.n + 1 }) }, coalesce: true });

describe('a store - immediate vs coalesced dispatch cost', () => {
  const bench = benchGroup();
  const scope = effectScope();
  const lists = scope.run(() => ({ immediate: listNow(createCommandBus()), coalesced: listLater(createCommandBus()) }))!;
  const counts = scope.run(() => ({ immediate: countNow(createCommandBus()), coalesced: countLater(createCommandBus()) }))!;
  afterAll(() => scope.stop());

  const { immediate: list, coalesced: listCoalesced } = lists;
  const { immediate: count, coalesced: countCoalesced } = counts;

  // immediate - 10 dispatches, array append (simulates v-for source)
  bench('store.immediate.append10', { beforeEach: () => { list.$reset(); } }, () => {
    for (let i = 0; i < 10; i++) list.append(i);
  });

  // immediate - 100 dispatches, array append (simulates v-for source)
  bench('store.immediate.append100', { beforeEach: () => { list.$reset(); } }, () => {
    for (let i = 0; i < 100; i++) list.append(i);
  });

  // coalesced - 10 dispatches, array append (simulates v-for source)
  bench('store.coalesced.append10', { beforeEach: () => { listCoalesced.$reset(); } }, () => {
    for (let i = 0; i < 10; i++) listCoalesced.append(i);
  });

  // coalesced - 100 dispatches, array append (simulates v-for source)
  bench('store.coalesced.append100', { beforeEach: () => { listCoalesced.$reset(); } }, () => {
    for (let i = 0; i < 100; i++) listCoalesced.append(i);
  });

  // immediate - 100 dispatches, counter (simulates v-if condition)
  bench('store.immediate.count100', { beforeEach: () => { count.$reset(); } }, () => {
    for (let i = 0; i < 100; i++) count.inc();
  });

  // coalesced - 100 dispatches, counter (simulates v-if condition)
  bench('store.coalesced.count100', { beforeEach: () => { countCoalesced.$reset(); } }, () => {
    for (let i = 0; i < 100; i++) countCoalesced.inc();
  });
});

// ---------------------------------------------------------------------------
// Signal path comparison - fallback vs alien-signals add-on vs Vue ref
//
// Three signal backends available in vapor-chamber:
//   1. Plain { value } object - default fallback when Vue is absent and
//      configureAlienSignals has not been called. Zero overhead, not reactive.
//   2. alien-signals via configureAlienSignals - opt-in push-pull reactivity
//      for non-Vue contexts. Backed by the same algorithm Vue 3.6 uses.
//   3. Vue ref (auto-detected) - signal() returns vue.ref() when Vue is present.
//      Identical algorithm to (2) since Vue 3.6's ref() is alien-signals.
//
// These benches measure raw write throughput for each path so the cost of
// adding reactivity is visible. Run with and without the vue devDep installed
// to see the auto-detection path vs the explicit fallback.
//
// Baselines (v1.4.0, beta.13, 2026-05-28):
//   plain { value } object 10k writes    ~368,000 hz  <- V8 DCE upper bound; real cost about zero overhead
//   closure getter/setter (OLD, v1.3)      ~2,400 hz  <- real cost; setter is a fn call V8 cannot elide
//   alien-signals via alienSignalAdapter  ~10,500 hz  <- opt-in reactive; ~4x faster than old closure
//   Vue ref via signal() auto-detected     ~9,500 hz  <- same algorithm, slight Vue wrapper overhead
//   Vue ref + watchEffect subscriber      ~50,000 hz  (notify path - different iteration scale)
//   effectScope + onScopeDispose only x1k ~158,000 hz <- beta.13 lazy job: no update job allocated
//   effectScope + signal + onScopeDispose  ~21,000 hz <- full reactive scope path
//   useCommandState 100 dispatches          ~1,700 hz
//   useCommandState coalesced 100           ~1,900 hz <- throughput-neutral (within noise)
//
// Baselines (v1.5.0, beta.14, 2026-06-05):
//   plain { value } object 10k writes    ~372,000 hz  <- stable (V8 DCE)
//   closure getter/setter (OLD, v1.3)      ~2,208 hz
//   alien-signals via alienSignalAdapter  ~10,400 hz
//   Vue shallowRef via signal() (v1.5.0)  ~40-62k hz  <- ~4-7x the old deep-ref() ~9k path (run-dependent)
//   Vue ref + watchEffect subscriber      ~53,866 hz  (+8% vs beta.13)
//   effectScope + onScopeDispose only x1k ~173,462 hz <- beta.14: +9% vs beta.13
//   effectScope + signal + onScopeDispose  ~21,287 hz <- stable
//   useCommandState 100 dispatches          ~2,100 hz  (+24% vs beta.13)
//   useCommandState coalesced 100           ~2,115 hz  <- throughput-neutral (within noise)
//
// Baselines (v1.6.0, beta.15, 2026-06-11, dev host, 3 runs):
//   plain { value } object               ~362,000 hz       <- stable (V8 DCE)
//   alien-signals via alienSignalAdapter  ~8,500-10,700 hz
//   Vue shallowRef via signal() (v1.5.0)  ~31,000-42,000 hz <- machine-state sensitive
//        (busy vs idle); the ~4-7x ratio over the old deep ref() is the robust claim
//   Vue ref + watchEffect subscriber      ~35,000-55,000 hz (+/-4.5% rme - noisiest row)
//   effectScope + onScopeDispose only x1k ~156,000 hz
//   effectScope + signal + onScopeDispose  ~21,000-25,000 hz
//   useCommandState 100 dispatches          ~1,650-2,015 hz
//   -> Reactive rows swing 20-30% run-to-run on a shared machine; fallback and
//     lifecycle rows are stable. signal-shallow-ab (same-process A/B) is the
//     trustworthy regression guard - it still shows shallowRef faster. No beta.15
//     reactivity regression; the cross-run spread is host state, not code.
// These baselines were timed with each signal and store built inside each call.
// ---------------------------------------------------------------------------

describe('signal path comparison - fallback vs alien-signals add-on vs Vue ref', () => {
  const bench = benchGroup();
  const plain = { value: 0 };
  const alien = _alienFactory(0);
  let vue!: { value: number };
  const notified = ref(0);
  const watching = effectScope();
  const stores = effectScope();
  let count!: ReturnType<typeof countNow>;
  let countCoalesced!: ReturnType<typeof countLater>;
  beforeAll(async () => {
    await waitForVueDetection();
    vue = signal(0);
    let sink = 0;
    watching.run(() => {
      watchEffect(() => { sink = notified.value; });
    });
    void sink;
    stores.run(() => {
      count = countNow(createCommandBus());
      countCoalesced = countLater(createCommandBus());
    });
  });
  afterAll(() => {
    watching.stop();
    stores.stop();
  });

  // -- without add-on (default fallback) -------------------------------------

  // plain { value } object - actual fallback (no Vue, no alien-signals)
  bench('signal.plain', () => {
    // NOTE: V8 may dead-code-eliminate these writes (no subscribers). The ~370k
    // hz figure is an upper bound; real cost is near zero overhead. The honest
    // takeaway: plain property access has no function call overhead, unlike
    // getter/setter or alien-signals.
    let sink = 0;
    for (let i = 0; i < 10_000; i++) { plain.value = i; sink = plain.value; }
    if (sink < 0) console.log(sink);
  });

  // -- with alien-signals add-on ----------------------------------------------

  // alien-signals via alienSignalAdapter - opt-in reactive path
  bench('signal.alien', () => {
    // What you get after: configureAlienSignals(alienSignal)
    // or: configureSignal(alienSignalAdapter(alienSignal))
    let sink = 0;
    for (let i = 0; i < 10_000; i++) { alien.value = i; sink = alien.value; }
    if (sink < 0) console.log(sink);
  });

  // -- Vue auto-detected (signal() wires shallowRef) --------------------------

  // Vue shallowRef via signal() - auto-detected (default)
  bench('signal.vue', () => {
    // What signal() returns when Vue is present: shallowRef. Goes
    // through the signal() indirection, so V8 can't constant-fold it - this is
    // a reliable scalar-write measurement.
    let sink = 0;
    for (let i = 0; i < 10_000; i++) { vue.value = i; sink = vue.value; }
    if (sink < 0) console.log(sink);
  });

  // Vue ref + watchEffect subscriber - notify path
  bench('signal.vue.watch', () => {
    for (let i = 0; i < 1_000; i++) notified.value = i;
  });

  // -- lifecycle overhead (current Vue) ----------------------------------------

  // effectScope + onScopeDispose only x 1k (lazy job cost)
  bench('scope.empty', () => {
    for (let i = 0; i < 1_000; i++) {
      const scope = effectScope();
      scope.run(() => {
        // tryAutoCleanup path - beta.13 does NOT allocate an update job here
        // because no reactive state is tracked inside the scope.
      });
      scope.stop();
    }
  });

  // effectScope + reactive signal + onScopeDispose x 1k (full path)
  bench('scope.signal', () => {
    for (let i = 0; i < 1_000; i++) {
      const scope = effectScope();
      scope.run(() => {
        const s = signal(0);
        onScopeDispose(() => { void s; });
        s.value = i;
      });
      scope.stop();
    }
  });

  // -- a store with real Vue refs ------------------------------------------

  // store 100 dispatches - Vue ref signal writes
  bench('signal.store.count100', { beforeEach: () => { count.$reset(); } }, () => {
    for (let i = 0; i < 100; i++) count.inc();
  });

  // store coalesced 100 dispatches - Vue ref, 1 reactive write
  bench('signal.store.coalesced100', { beforeEach: () => { countCoalesced.$reset(); } }, () => {
    for (let i = 0; i < 100; i++) countCoalesced.inc();
  });
});

// NOTE: isolated ref-vs-shallowRef micro-benches were intentionally NOT added
// here. Pure deterministic signal loops are constant-foldable, so V8 dead-code-
// eliminates the shallowRef path (whose writes have no observable effect) while
// keeping ref's Proxy-trap side effects - producing inflated, unstable ratios
// (observed 800x+ with +/-100% rme). The honest, DCE-safe measurement lives in
// tests/signal-shallow-ab.test.ts, which runs the REAL dispatch path (the bus
// indirection defeats constant-folding) interleaved in-process and prints the
// ratio on `npm run test:timing`. Use that as the source of truth.

describe('command.meta', () => {
  it('command.meta.id is populated', () => {
    const bus = createCommandBus();
    let meta: any;
    bus.register('test', (cmd) => { meta = cmd.meta; });
    bus.dispatch('test', {});
    expect(meta).toBeDefined();
    expect(typeof meta.id).toBe('string');
    expect(meta.id.length).toBeGreaterThan(0);
  });
});
