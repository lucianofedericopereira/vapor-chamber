/**
 * Throughput benchmarks of dispatch, emit, the fast lane, persist, the transition bridge, stamping, directives, stores and signals, against peers where one exists; run with `npm run bench`, not by `vitest run`.
 * Why: a row that timed setup or a different path than its id names would still give a stable number that gets quoted, so each row times only the work its id names.
 * Shows: buses, stores, composables and peers are built in the group's setup, outside the timed function; a row that changes state resets it in its own beforeEach, which tinybench runs outside the timing; building is timed only in the `create.*` rows; row ids are stable. The `performance sanity` and `command.meta` tests assert wall-clock thresholds and a populated meta id.
 * See: tests/bench-harness.test.ts, scripts/bench-ratios-reporter.mjs
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

// `bench` is a test-context fixture: benches register inside a test and run through `bench.compare()`.
// Each describe shadows `bench` with a collector whose registrations run as ONE compare, so a group's
// rows come from the same run, which the ratios reporter relies on when it divides two of them.
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

// The core rows install no history and mark no dispatch; these cover the paths a history and `_withOrigin` add.
// The histories take their bus as `{ bus }`: without it `useCommandHistory` observes the shared bus.
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

  bench('history.dispatch', { beforeEach: () => history.clear() }, () => {
    for (let i = 0; i < 10_000; i++) histBus.dispatch('act', i, { qty: i });
  });

  bench('history.undoredo', { beforeEach: () => undoHistory.clear() }, () => {
    for (let i = 0; i < 2_000; i++) {
      undoBus.dispatch('act', i, { qty: i });
      undoHistory.undo();
      undoHistory.redo();
    }
  });

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

  bench('dispatch.sync.bare', () => {
    for (let i = 0; i < 10_000; i++) bare.dispatch('test', i);
  });

  bench('dispatch.sync.parts3', () => {
    for (let i = 0; i < 10_000; i++) parts.dispatch('test', i);
  });

  bench('query.sync.bare', () => {
    for (let i = 0; i < 10_000; i++) queries.query('getUser', i);
  });

  bench('query.sync.stepped', () => {
    for (let i = 0; i < 10_000; i++) stepped.query('getUser', i);
  });

  bench('emit.listeners3', () => {
    for (let i = 0; i < 10_000; i++) emits.emit('test', i);
  });

  bench('dispatch.sync.wildcard', () => {
    for (let i = 0; i < 10_000; i++) wildcard.dispatch('cartAdd', i);
  });

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
  // The rows time a whole dispatch, not one uid call: the rest of the dispatch dilutes the per-call ratio.
  bench('uid.counter', { beforeEach: () => _resetUid() }, () => {
    for (let i = 0; i < 10_000; i++) counter.dispatch('test', i);
  });

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

  bench('dispatch.async.bare', async () => {
    for (let i = 0; i < 1_000; i++) await bare.dispatch('test', i);
  });

  // The async counterpart of dispatch.sync.parts3: the parts' boundaries (plugin:failed:plugin) sit on this path.
  bench('dispatch.async.parts3', async () => {
    for (let i = 0; i < 1_000; i++) await parts.dispatch('test', i);
  });

  // One onAfter hook, as history(), useCommandHistory, useCommandError and the devtools install.
  bench('dispatch.async.hook', async () => {
    for (let i = 0; i < 1_000; i++) await hooked.dispatch('test', i);
  });
});

// Creation is timed on its own: each row builds and disposes 1k of one thing, with nothing dispatched.
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

// Wall-clock thresholds, asserted when this file runs under `vitest bench`.
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

// Peers are pure event emitters (mitt, eventemitter3, tiny-emitter, rxjs Subject) and a hand-rolled
// `Map<string, Set<fn>>`: emit fan-out is the like-for-like row, dispatch also stamps meta and returns a result.
import mitt from 'mitt';
import EventEmitter3 from 'eventemitter3';
import TinyEmitter from 'tiny-emitter';
import { Subject } from 'rxjs';

describe('emit fast path - no listeners', () => {
  const bench = benchGroup();
  const bus = createCommandBus();
  const m = mitt<{ x: number }>();

  bench('emit.none', () => {
    for (let i = 0; i < 10_000; i++) bus.emit('nobody-listening', i);
  });

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

  bench('fanout.emit', () => {
    for (let i = 0; i < 10_000; i++) bus.emit('evt', i);
  });

  bench('fanout.peer.mitt', () => {
    for (let i = 0; i < 10_000; i++) m.emit('evt', i);
  });

  bench('fanout.peer.eventemitter3', () => {
    for (let i = 0; i < 10_000; i++) e.emit('evt', i);
  });

  bench('fanout.peer.tiny-emitter', () => {
    for (let i = 0; i < 10_000; i++) t.emit('evt', i);
  });

  bench('fanout.peer.rxjs', () => {
    for (let i = 0; i < 10_000; i++) s.next(i);
  });

  bench('fanout.map', () => {
    for (let i = 0; i < 10_000; i++) emit('evt', i);
  });
});

// The fast lane trades the bus's command envelope, results and plugins for raw throughput.
describe('fast lane - single-handler hot dispatch (10k)', () => {
  const bench = benchGroup();
  const lane = createFastLane();
  const onTick = lane.compile<number, number>('tick', (n) => n * 2);
  const fn = (n: number) => n * 2;
  const m = mitt<{ tick: number }>();
  m.on('tick', () => {});
  const bus = createCommandBus();
  bus.register('tick', (cmd) => cmd.target * 2);

  // Compiled once, in setup.
  bench('hot.fastlane.compiled', () => {
    let acc = 0;
    for (let i = 0; i < 10_000; i++) acc = onTick(i);
    if (acc < 0) console.log(acc);
  });

  // A direct function call: the floor.
  bench('hot.floor', () => {
    let acc = 0;
    for (let i = 0; i < 10_000; i++) acc = fn(i);
    if (acc < 0) console.log(acc);
  });

  bench('hot.peer.mitt', () => {
    for (let i = 0; i < 10_000; i++) m.emit('tick', i);
  });

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

  bench('lanefanout.live', () => {
    for (let i = 0; i < 10_000; i++) live.emit('evt', i);
  });

  bench('lanefanout.snapshot', () => {
    for (let i = 0; i < 10_000; i++) snapshot.emit('evt', i);
  });

  bench('lanefanout.emit', () => {
    for (let i = 0; i < 10_000; i++) bus.emit('evt', i);
  });

  bench('lanefanout.peer.mitt', () => {
    for (let i = 0; i < 10_000; i++) m.emit('evt', i);
  });

  // The EventEmitter migration guide recommends the fast lane for pub/sub, so its peer runs in the same group.
  bench('lanefanout.peer.eventemitter3', () => {
    for (let i = 0; i < 10_000; i++) e.emit('evt', i);
  });
});

describe('comparative dispatch (10k dispatches, single handler)', () => {
  const bench = benchGroup();
  const bus = createCommandBus();
  bus.register('act', (cmd) => cmd.target);
  const m = mitt<{ act: number }>();
  m.on('act', () => {}); // can't capture a return - emit is fire-only

  bench('compare.dispatch', () => {
    for (let i = 0; i < 10_000; i++) bus.dispatch('act', i);
  });

  bench('compare.peer.mitt', () => {
    for (let i = 0; i < 10_000; i++) m.emit('act', i);
  });
});

// The on() / emit() listener walk at 50 exact-match listeners; bucketing them pays off with listener count, not at 3.
describe('listener fan-out', () => {
  const bench = benchGroup();
  const dispatches = createCommandBus();
  dispatches.register('hot', (cmd) => cmd.target);
  for (let i = 0; i < 50; i++) dispatches.on('hot', () => {});
  for (let i = 0; i < 5; i++) dispatches.on('hot:*', () => {});
  const emits = createCommandBus();
  for (let i = 0; i < 50; i++) emits.on('evt', () => {});
  for (let i = 0; i < 5; i++) emits.on('evt:*', () => {});

  bench('fanout50.dispatch', () => {
    for (let i = 0; i < 5_000; i++) dispatches.dispatch('hot', i);
  });

  bench('fanout50.emit', () => {
    for (let i = 0; i < 5_000; i++) emits.emit('evt', i);
  });
});

// A store's persist saves once per microtask after a burst of writes; the rows await that microtask, so the save is inside the timed call.
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

  bench('persist.small', async () => {
    for (let i = 0; i < 100; i++) small.inc();
    await Promise.resolve();
  });

  bench('persist.items50', async () => {
    for (let i = 0; i < 100; i++) items.touch();
    await Promise.resolve();
  });
});

// The bridge's JS-layer dispatch cost, independent of Vue's version. onMove is called by hand, as an app calls it:
// Vue has no move hook (tests/vue-no-move-hook.test.ts). transition.dispatch is the raw bus.dispatch reference for the delta.
describe('transition bridge throughput', () => {
  const bench = benchGroup();
  const el = { tagName: 'DIV' } as unknown as Element;
  const done = () => {};
  const modal = createTransitionBridge({ bus: createCommandBus({ onMissing: 'ignore' }), namespace: 'modal' });
  const list = createTransitionBridge({ bus: createCommandBus({ onMissing: 'ignore' }), namespace: 'list' });
  const drawer = createTransitionBridge({ bus: createCommandBus({ onMissing: 'ignore' }), namespace: 'drawer' });
  const raw = createCommandBus({ onMissing: 'ignore' });

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

  bench('transition.move', () => {
    for (let i = 0; i < 10_000; i++) list.onMove(el);
  });

  bench('transition.enterleave', () => {
    for (let i = 0; i < 5_000; i++) {
      drawer.onEnter(el, done);
      drawer.onLeave(el, done);
    }
  });

  bench('transition.dispatch', () => {
    for (let i = 0; i < 10_000; i++) raw.dispatch('listMove', { tagName: 'DIV' });
  });
});

// Stamping scales with page size, not route count. `afterEach` fires on query-only commits too (pagination, a sort
// toggle, setQuery per keystroke), where the path is unchanged and every stamp recomputes to the value already in the DOM.
// The router's `stamp` closure memoises the last stamped path; these rows measure what that memo is worth.
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

  // A path change walks every anchor.
  bench('stamp.path', () => {
    for (let i = 0; i < COMMITS; i++) {
      stampActiveLinks('/admin', `/section-${i % 25}/item-${i}`, root);
    }
  });

  bench('stamp.query', () => {
    // Same path every time: the per-keystroke case, which the memo skips.
    for (let i = 0; i < COMMITS; i++) {
      stampActiveLinks('/admin', '/section-3/item-3', root);
    }
  });
});

// `.delegate` (src/directives.ts) is opt-in: one shared document listener instead of N per-element ones. These rows see
// mount/unmount cost only; its payoff is the standing listener count (1 vs N), which they cannot show.
describe('directive delegation (.delegate) - mount/unmount cost at scale', () => {
  const bench = benchGroup();
  const N = 5_000;

  // Minimal Element mock, trimmed to what mounted()/beforeUnmount() touch: delegate mode's cost is
  // dominated by (de)registration, not event dispatch.
  // NOT A TEARDOWN CHECK: `removeEventListener` here ignores the handler and the options, so this mock cannot tell a
  // real removal from a mismatched one. Teardown is asserted in tests/directives-vapor-fixture.test.ts against a real document.
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

  bench('directive.direct', () => {
    for (const el of els) direct.mounted(el, plain);
    for (const el of els) direct.beforeUnmount(el, unbind);
  });

  bench('directive.delegate', () => {
    for (const el of els) delegated.mounted(el, delegate);
    for (const el of els) delegated.beforeUnmount(el, unbind);
  });
});

// Each row runs a burst of a store's action from its reset state: the dispatch and state-write cost below Vue's runtime.
// "immediate" writes the state per dispatch; "coalesced" chains the burst and writes once, a microtask later.
// The rows measure the synchronous cost; the deferred write lands before the next iteration's reset.
// append rows model a v-for source, count rows a v-if condition.
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

  bench('store.immediate.append10', { beforeEach: () => { list.$reset(); } }, () => {
    for (let i = 0; i < 10; i++) list.append(i);
  });

  bench('store.immediate.append100', { beforeEach: () => { list.$reset(); } }, () => {
    for (let i = 0; i < 100; i++) list.append(i);
  });

  bench('store.coalesced.append10', { beforeEach: () => { listCoalesced.$reset(); } }, () => {
    for (let i = 0; i < 10; i++) listCoalesced.append(i);
  });

  bench('store.coalesced.append100', { beforeEach: () => { listCoalesced.$reset(); } }, () => {
    for (let i = 0; i < 100; i++) listCoalesced.append(i);
  });

  bench('store.immediate.count100', { beforeEach: () => { count.$reset(); } }, () => {
    for (let i = 0; i < 100; i++) count.inc();
  });

  bench('store.coalesced.count100', { beforeEach: () => { countCoalesced.$reset(); } }, () => {
    for (let i = 0; i < 100; i++) countCoalesced.inc();
  });
});

// Raw write throughput of the three signal backends: a plain { value } object (the fallback when Vue is absent
// and configureAlienSignals was not called), alien-signals via the adapter, and Vue's shallowRef via signal().
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

  bench('signal.plain', () => {
    // V8 may dead-code-eliminate these writes (no subscribers), so this row is an upper bound.
    let sink = 0;
    for (let i = 0; i < 10_000; i++) { plain.value = i; sink = plain.value; }
    if (sink < 0) console.log(sink);
  });

  bench('signal.alien', () => {
    // What configureAlienSignals(alienSignal) or configureSignal(alienSignalAdapter(alienSignal)) gives.
    let sink = 0;
    for (let i = 0; i < 10_000; i++) { alien.value = i; sink = alien.value; }
    if (sink < 0) console.log(sink);
  });

  bench('signal.vue', () => {
    // signal() returns a shallowRef when Vue is present; the signal() indirection stops V8 constant-folding it.
    let sink = 0;
    for (let i = 0; i < 10_000; i++) { vue.value = i; sink = vue.value; }
    if (sink < 0) console.log(sink);
  });

  // The notify path: a watchEffect subscribes to `notified`.
  bench('signal.vue.watch', () => {
    for (let i = 0; i < 1_000; i++) notified.value = i;
  });

  bench('scope.empty', () => {
    for (let i = 0; i < 1_000; i++) {
      const scope = effectScope();
      scope.run(() => {
        // No reactive state is tracked inside the scope.
      });
      scope.stop();
    }
  });

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

  bench('signal.store.count100', { beforeEach: () => { count.$reset(); } }, () => {
    for (let i = 0; i < 100; i++) count.inc();
  });

  bench('signal.store.coalesced100', { beforeEach: () => { countCoalesced.$reset(); } }, () => {
    for (let i = 0; i < 100; i++) countCoalesced.inc();
  });
});

// No isolated ref-vs-shallowRef micro-bench: pure deterministic signal loops are constant-foldable, so V8 eliminates the
// shallowRef path while keeping ref's Proxy-trap side effects, which inflates the ratio. tests/signal-shallow-ab.test.ts
// runs the real dispatch path interleaved in-process and prints the ratio on `npm run test:timing`.

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
