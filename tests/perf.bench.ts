/**
 * vapor-chamber — Performance benchmarks
 *
 * Run with: npx vitest bench tests/perf.bench.ts
 * Or:       npm run test -- --bench tests/perf.bench.ts
 *
 * These are not CI tests — they measure throughput on the developer's machine.
 */

import { describe, it, expect, bench, beforeAll } from 'vitest';
import { createCommandBus, createAsyncCommandBus, configureUid } from '../src/command-bus';
import { rehydrate, type DehydratedCommand } from '../src/ssr';
import { persist } from '../src/plugins-io';
import { createFastLane } from '../src/fast-lane';
import { createTransitionBridge } from '../src/transitions';
import { useCommandState, signal, configureSignal, waitForVueDetection } from '../src/chamber';
import { alienSignalAdapter } from '../src/alien-signals';
import { signal as _alienSignal } from 'alien-signals';

const _alienFactory = alienSignalAdapter(_alienSignal as any);

describe('core dispatch throughput', () => {
  bench('syncDispatch — bare handler, no plugins', () => {
    const bus = createCommandBus();
    bus.register('test', (cmd) => cmd.target);
    for (let i = 0; i < 10_000; i++) {
      bus.dispatch('test', i);
    }
  });

  bench('syncDispatch — 3 plugins + 1 listener', () => {
    const bus = createCommandBus();
    bus.use((cmd, next) => next());
    bus.use((cmd, next) => next());
    bus.use((cmd, next) => next());
    bus.on('*', () => {});
    bus.register('test', (cmd) => cmd.target);
    for (let i = 0; i < 10_000; i++) {
      bus.dispatch('test', i);
    }
  });

  bench('syncQuery — bare handler, no plugins', () => {
    const bus = createCommandBus();
    bus.register('getUser', (cmd) => ({ id: cmd.target }));
    for (let i = 0; i < 10_000; i++) {
      bus.query('getUser', i);
    }
  });

  bench('syncQuery — 1 plugin + 1 after-hook (full runner path)', () => {
    const bus = createCommandBus();
    bus.register('getUser', (cmd) => ({ id: cmd.target }));
    bus.use((cmd, next) => next());
    bus.onAfter(() => {});
    for (let i = 0; i < 10_000; i++) {
      bus.query('getUser', i);
    }
  });

  bench('emit — 3 listeners, no handler', () => {
    const bus = createCommandBus();
    bus.on('test', () => {});
    bus.on('test', () => {});
    bus.on('test', () => {});
    for (let i = 0; i < 10_000; i++) {
      bus.emit('test', i);
    }
  });

  bench('matchesPattern — wildcard prefix*', () => {
    const bus = createCommandBus();
    bus.on('cart*', () => {});
    bus.register('cartAdd', () => {});
    for (let i = 0; i < 10_000; i++) {
      bus.dispatch('cartAdd', i);
    }
  });

  bench('dispatchBatch — 100 commands', () => {
    const bus = createCommandBus();
    bus.register('test', () => 'ok');
    const cmds = Array.from({ length: 100 }, (_, i) => ({ action: 'test', target: i }));
    for (let i = 0; i < 100; i++) {
      bus.dispatchBatch(cmds);
    }
  });
});

describe('meta overhead — uid generator comparison', () => {
  // Default: counter + per-process random prefix (~30–50ns per uid).
  bench('dispatch — default counter-based uid', () => {
    const bus = createCommandBus();
    bus.register('test', () => {});
    // Reset to the default fast path in case a prior bench swapped it.
    configureUid(((): () => string => {
      const prefix = ((Math.random() * 0xffffffff) >>> 0).toString(36);
      let n = 0;
      return () => prefix + '-' + (++n).toString(36);
    })());
    for (let i = 0; i < 10_000; i++) {
      bus.dispatch('test', i);
    }
  });

  // Opt-in via configureUid — for distributed tracing / cross-process IDs.
  bench('dispatch — crypto.randomUUID via configureUid', () => {
    const bus = createCommandBus();
    bus.register('test', () => {});
    configureUid(() => crypto.randomUUID());
    for (let i = 0; i < 10_000; i++) {
      bus.dispatch('test', i);
    }
    // Restore counter-based uid so later benches are not contaminated.
    configureUid(((): () => string => {
      const prefix = ((Math.random() * 0xffffffff) >>> 0).toString(36);
      let n = 0;
      return () => prefix + '-' + (++n).toString(36);
    })());
  });
});

describe('async dispatch throughput', () => {
  bench('asyncDispatch — bare handler', async () => {
    const bus = createAsyncCommandBus();
    bus.register('test', async (cmd) => cmd.target);
    for (let i = 0; i < 1_000; i++) {
      await bus.dispatch('test', i);
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
// results). The closest "small lib" peers are pure event emitters — mitt and
// nanoevents — plus a hand-rolled `Map<string, Set<fn>>` baseline. The point
// of these benches is to show that the lib's emit-fan-out (the closest apple
// to apple) is competitive with hand-rolled, with all the extra machinery
// (results, plugins, hooks, before/after, batch, request) on top.
//
// Reading these numbers:
//   - vapor-chamber `emit` should be in the same order as mitt / nanoevents.
//   - vapor-chamber `dispatch` does meaningfully more (plugin chain, meta
//     stamping, results) — expect it to be slower than raw emit, but still
//     competitive with hand-rolled middleware patterns.
// ---------------------------------------------------------------------------

import mitt from 'mitt';
import { createNanoEvents } from 'nanoevents';
import EventEmitter3 from 'eventemitter3';
import TinyEmitter from 'tiny-emitter';
import { Subject } from 'rxjs';

describe('emit fast path — no listeners', () => {
  bench('vapor-chamber bus.emit with NO listeners (10k)', () => {
    const bus = createCommandBus();
    for (let i = 0; i < 10_000; i++) bus.emit('nobody-listening', i);
  });

  bench('mitt with NO listeners (10k)', () => {
    const m = mitt<{ x: number }>();
    for (let i = 0; i < 10_000; i++) m.emit('x', i);
  });

  bench('nanoevents with NO listeners (10k)', () => {
    const n = createNanoEvents<{ x: (i: number) => void }>();
    for (let i = 0; i < 10_000; i++) n.emit('x', i);
  });
});

describe('comparative emit fan-out (10k events × 3 listeners)', () => {
  bench('vapor-chamber bus.emit — 3 listeners', () => {
    const bus = createCommandBus();
    bus.on('evt', () => {});
    bus.on('evt', () => {});
    bus.on('evt', () => {});
    for (let i = 0; i < 10_000; i++) bus.emit('evt', i);
  });

  bench('mitt — 3 listeners', () => {
    const m = mitt<{ evt: number }>();
    m.on('evt', () => {});
    m.on('evt', () => {});
    m.on('evt', () => {});
    for (let i = 0; i < 10_000; i++) m.emit('evt', i);
  });

  bench('nanoevents — 3 listeners', () => {
    const n = createNanoEvents<{ evt: (i: number) => void }>();
    n.on('evt', () => {});
    n.on('evt', () => {});
    n.on('evt', () => {});
    for (let i = 0; i < 10_000; i++) n.emit('evt', i);
  });

  bench('eventemitter3 — 3 listeners', () => {
    const e = new EventEmitter3();
    e.on('evt', () => {});
    e.on('evt', () => {});
    e.on('evt', () => {});
    for (let i = 0; i < 10_000; i++) e.emit('evt', i);
  });

  bench('tiny-emitter — 3 listeners', () => {
    const t = new (TinyEmitter as any)();
    t.on('evt', () => {});
    t.on('evt', () => {});
    t.on('evt', () => {});
    for (let i = 0; i < 10_000; i++) t.emit('evt', i);
  });

  bench('rxjs Subject — 3 subscribers', () => {
    const s = new Subject<number>();
    s.subscribe(() => {});
    s.subscribe(() => {});
    s.subscribe(() => {});
    for (let i = 0; i < 10_000; i++) s.next(i);
  });

  bench('raw Map<string, Set<fn>> — 3 listeners (hand-rolled baseline)', () => {
    const handlers = new Map<string, Set<(i: number) => void>>();
    function on(evt: string, fn: (i: number) => void): void {
      let s = handlers.get(evt);
      if (!s) { s = new Set(); handlers.set(evt, s); }
      s.add(fn);
    }
    function emit(evt: string, i: number): void {
      const s = handlers.get(evt);
      if (s) for (const fn of s) fn(i);
    }
    on('evt', () => {});
    on('evt', () => {});
    on('evt', () => {});
    for (let i = 0; i < 10_000; i++) emit('evt', i);
  });
});

// ---------------------------------------------------------------------------
// Fast lane — vapor-chamber's real-real-hot-path dispatcher.
//
// Trades the bus's ergonomics (Command envelope, results, plugins, hooks,
// listeners, schema, batch, request/response, AbortController) for raw
// throughput. Use for game ticks, trading data, audio, scroll/mousemove,
// physics steps. NOT for general app dispatch.
// ---------------------------------------------------------------------------

describe('fast lane — single-handler hot dispatch (10k)', () => {
  bench('vapor-chamber fast-lane compile + dispatch', () => {
    const lane = createFastLane();
    const onTick = lane.compile<number, number>('tick', (n) => n * 2);
    let acc = 0;
    for (let i = 0; i < 10_000; i++) acc = onTick(i);
    if (acc < 0) console.log(acc);
  });

  bench('direct function call (theoretical floor)', () => {
    const fn = (n: number) => n * 2;
    let acc = 0;
    for (let i = 0; i < 10_000; i++) acc = fn(i);
    if (acc < 0) console.log(acc);
  });

  bench('mitt (closest peer — emit fires listeners, no return)', () => {
    const m = mitt<{ tick: number }>();
    m.on('tick', () => {});
    for (let i = 0; i < 10_000; i++) m.emit('tick', i);
  });

  bench('nanoevents (closest peer — emit fires listeners, no return)', () => {
    const n = createNanoEvents<{ tick: (n: number) => void }>();
    n.on('tick', () => {});
    for (let i = 0; i < 10_000; i++) n.emit('tick', i);
  });

  bench('vapor-chamber bus.dispatch (general-purpose, for comparison)', () => {
    const bus = createCommandBus();
    bus.register('tick', (cmd) => cmd.target * 2);
    for (let i = 0; i < 10_000; i++) bus.dispatch('tick', i);
  });
});

describe('fast lane — multi-subscriber emit fan-out (10k events × 3 listeners)', () => {
  bench('vapor-chamber fast-lane emit', () => {
    const lane = createFastLane();
    lane.on('evt', () => {});
    lane.on('evt', () => {});
    lane.on('evt', () => {});
    for (let i = 0; i < 10_000; i++) lane.emit('evt', i);
  });

  bench('vapor-chamber bus.emit (general-purpose, for comparison)', () => {
    const bus = createCommandBus();
    bus.on('evt', () => {});
    bus.on('evt', () => {});
    bus.on('evt', () => {});
    for (let i = 0; i < 10_000; i++) bus.emit('evt', i);
  });

  bench('mitt — 3 listeners (peer)', () => {
    const m = mitt<{ evt: number }>();
    m.on('evt', () => {});
    m.on('evt', () => {});
    m.on('evt', () => {});
    for (let i = 0; i < 10_000; i++) m.emit('evt', i);
  });

  bench('nanoevents — 3 listeners (peer)', () => {
    const n = createNanoEvents<{ evt: (i: number) => void }>();
    n.on('evt', () => {});
    n.on('evt', () => {});
    n.on('evt', () => {});
    for (let i = 0; i < 10_000; i++) n.emit('evt', i);
  });
});

describe('comparative dispatch (10k dispatches, single handler)', () => {
  // vapor-chamber's `dispatch` does substantively more than `emit`: meta
  // stamping, plugin chain, hooks, result allocation. The benches below
  // measure the full path for a fair "is the lib competitive?" comparison
  // against minimal-feature peers.

  bench('vapor-chamber bus.dispatch — bare handler, no plugins', () => {
    const bus = createCommandBus();
    bus.register('act', (cmd) => cmd.target);
    for (let i = 0; i < 10_000; i++) bus.dispatch('act', i);
  });

  bench('mitt — emit (bus.emit equivalent, no result)', () => {
    const m = mitt<{ act: number }>();
    m.on('act', () => {});  // can't capture a return — emit is fire-only
    for (let i = 0; i < 10_000; i++) m.emit('act', i);
  });

  bench('nanoevents — emit', () => {
    const n = createNanoEvents<{ act: (i: number) => void }>();
    n.on('act', () => {});
    for (let i = 0; i < 10_000; i++) n.emit('act', i);
  });
});

// ---------------------------------------------------------------------------
// SSR rehydration throughput
//
// The lib's `rehydrate()` replays serialized commands through the bus. It is
// orthogonal to Vue's own hydration — Vue 3.6.0-beta.11's static-template
// hydration fast path speeds up VDOM/Vapor hydration but does NOT speed up
// command replay. These benches lock the lib's replay cost so any regression
// is visible regardless of Vue version.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Listener fan-out — tests the cost of the on() / emit() listener walk.
// The benefit of bucketing exact-match listeners is supposed to scale with
// listener count: silent at 3 listeners, real at 50+.
// ---------------------------------------------------------------------------

describe('listener fan-out', () => {
  bench('dispatch with 50 exact-match listeners + 5 wildcards', () => {
    const bus = createCommandBus();
    bus.register('hot', (cmd) => cmd.target);
    for (let i = 0; i < 50; i++) bus.on('hot', () => {});
    for (let i = 0; i < 5; i++) bus.on('hot:*', () => {});
    for (let i = 0; i < 5_000; i++) bus.dispatch('hot', i);
  });

  bench('emit with 50 exact-match listeners + 5 wildcards', () => {
    const bus = createCommandBus();
    for (let i = 0; i < 50; i++) bus.on('evt', () => {});
    for (let i = 0; i < 5; i++) bus.on('evt:*', () => {});
    for (let i = 0; i < 5_000; i++) bus.emit('evt', i);
  });
});

// ---------------------------------------------------------------------------
// Persist plugin — every dispatch triggers getState() + JSON.stringify() +
// storage.setItem(). Coalescing should batch back-to-back saves into one.
// ---------------------------------------------------------------------------

function makeMemoryStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, v); },
    removeItem: (k: string) => { m.delete(k); },
  };
}

describe('persist plugin throughput', () => {
  bench('100 rapid dispatches with persist enabled (small state)', () => {
    const bus = createCommandBus();
    let counter = 0;
    bus.register('inc', () => ++counter);
    bus.use(persist({
      key: 'bench:small',
      getState: () => ({ counter }),
      storage: makeMemoryStorage(),
    }));
    for (let i = 0; i < 100; i++) bus.dispatch('inc', null);
  });

  bench('100 rapid dispatches with persist enabled (50-item array state)', () => {
    const bus = createCommandBus();
    const items: { id: number; name: string }[] = [];
    for (let i = 0; i < 50; i++) items.push({ id: i, name: 'item-' + i });
    bus.register('touch', () => { items[0].id++; });
    bus.use(persist({
      key: 'bench:medium',
      getState: () => ({ items }),
      storage: makeMemoryStorage(),
    }));
    for (let i = 0; i < 100; i++) bus.dispatch('touch', null);
  });

  // Same workload, but with coalesce: true — saves collapse to one per
  // microtask burst. Measures the win when many rapid dispatches touch the
  // same state.
  bench('100 rapid dispatches with persist enabled + coalesce (50-item array state)', () => {
    const bus = createCommandBus();
    const items: { id: number; name: string }[] = [];
    for (let i = 0; i < 50; i++) items.push({ id: i, name: 'item-' + i });
    bus.register('touch', () => { items[0].id++; });
    bus.use(persist({
      key: 'bench:medium-coalesced',
      getState: () => ({ items }),
      storage: makeMemoryStorage(),
      coalesce: true,
    }));
    for (let i = 0; i < 100; i++) bus.dispatch('touch', null);
  });
});

describe('SSR rehydrate throughput', () => {
  function makeCommands(n: number): DehydratedCommand[] {
    const out: DehydratedCommand[] = new Array(n);
    for (let i = 0; i < n; i++) {
      out[i] = { action: 'replay', target: i, payload: { v: i % 7 } };
    }
    return out;
  }

  bench('rehydrate — 10 commands, single handler', () => {
    const bus = createCommandBus();
    bus.register('replay', (cmd) => cmd.target);
    rehydrate(bus, makeCommands(10));
  });

  bench('rehydrate — 100 commands, single handler', () => {
    const bus = createCommandBus();
    bus.register('replay', (cmd) => cmd.target);
    rehydrate(bus, makeCommands(100));
  });

  bench('rehydrate — 1000 commands, single handler', () => {
    const bus = createCommandBus();
    bus.register('replay', (cmd) => cmd.target);
    rehydrate(bus, makeCommands(1000));
  });

  bench('rehydrate — 1000 commands, ignoreUnhandled skip path', () => {
    const bus = createCommandBus();
    // No handler registered — every command is skipped via hasHandler check.
    // Measures the cheap-path cost (relevant when the page replays a mix
    // of commands and only a subset is bound on the client).
    rehydrate(bus, makeCommands(1000), { ignoreUnhandled: true });
  });
});

// ---------------------------------------------------------------------------
// Transition bridge throughput — Vue 3.6.0-beta.13 baseline
//
// Beta.13 fixed two silent-skip bugs: onMove was never called for Vapor or
// VDOM component moves inside a Vapor TransitionGroup. These benches lock the
// JS-layer dispatch cost of the transition bridge so any future regression in
// the hook-dispatch path is visible regardless of Vue version.
//
// Reading these numbers:
//   - "all 9 hooks" covers the full enter+leave lifecycle in one sequence.
//   - "onMove × 10k" is the new baseline for the previously-broken move path.
//   - "onMove vs bus.dispatch" confirms the bridge adds only dispatch overhead.
//
// Baselines (v1.4.0, two-run average, 2026-05-28):
//   all 9 hooks × 1k        713 hz   (1.40ms / 1k sequences)   runs: 709 / 717
//   onMove only × 10k     1,018 hz   (0.98ms / 10k calls)      runs: 1,067 / 969  ← beta.13 baseline
//   onEnter + onLeave × 5k  984 hz   (1.02ms / 5k pairs)       runs: 1,000 / 969
//   raw bus.dispatch × 10k 1,757 hz  (0.57ms / 10k calls)      runs: 1,750 / 1,764
//   → bridge overhead ~37ns/call (dispatchSafe try/catch vs bare dispatch)
//   → onMove has higher run-to-run variance (try/catch inhibits V8 inlining under GC)
// ---------------------------------------------------------------------------

describe('transition bridge throughput', () => {
  function mockEl(): Element {
    return { tagName: 'DIV' } as unknown as Element;
  }

  bench('createTransitionBridge — all 9 hooks (1k sequences)', () => {
    const bus = createCommandBus({ onMissing: 'ignore' });
    const t = createTransitionBridge({ bus, namespace: 'modal' });
    const el = mockEl();
    const done = () => {};
    for (let i = 0; i < 1_000; i++) {
      t.onBeforeEnter(el);
      t.onEnter(el, done);
      t.onAfterEnter(el);
      t.onEnterCancelled(el);
      t.onBeforeLeave(el);
      t.onLeave(el, done);
      t.onAfterLeave(el);
      t.onLeaveCancelled(el);
      t.onMove(el);
    }
  });

  bench('createTransitionBridge — onMove only × 10k (beta.13 baseline)', () => {
    const bus = createCommandBus({ onMissing: 'ignore' });
    const t = createTransitionBridge({ bus, namespace: 'list' });
    const el = mockEl();
    for (let i = 0; i < 10_000; i++) {
      t.onMove(el);
    }
  });

  bench('createTransitionBridge — onEnter + onLeave × 5k (enter/leave cycle)', () => {
    const bus = createCommandBus({ onMissing: 'ignore' });
    const t = createTransitionBridge({ bus, namespace: 'drawer' });
    const el = mockEl();
    const done = () => {};
    for (let i = 0; i < 5_000; i++) {
      t.onEnter(el, done);
      t.onLeave(el, done);
    }
  });

  bench('createTransitionBridge — onMove vs raw bus.dispatch (overhead delta)', () => {
    const bus = createCommandBus({ onMissing: 'ignore' });
    for (let i = 0; i < 10_000; i++) {
      bus.dispatch('listMove', { tagName: 'DIV' });
    }
  });
});

// ---------------------------------------------------------------------------
// useCommandState — immediate vs coalesced (beta.13 v-for/v-if baseline)
//
// Beta.13 introduces specialized v-for block operations and reduced v-if branch
// scope overhead in the Vapor runtime. Both optimizations feed into signal writes
// that come from useCommandState. These benches measure the dispatch+state-write
// cost in vapor-chamber's layer (below Vue) so we can track our contribution to
// the overall update cost separately from Vue's runtime improvements.
//
// Reading these numbers:
//   - "immediate" fires a signal write per dispatch — each write would trigger
//     a Vue re-render if consumed in a template.
//   - "coalesced" batches all writes via queueMicrotask — one signal write for
//     the whole burst. The bench measures synchronous cost only; the deferred
//     write is not awaited.
//   - "100 dispatches vs 10" shows how coalescing scales with burst size.
//
// Baselines (v1.4.0, two-run average, 2026-05-28):
//   immediate  10 array appends    20,347 hz   runs: 20,188 / 20,507
//   coalesced  10 array appends    19,741 hz   runs: 19,767 / 19,715  — parity at small bursts
//   immediate 100 array appends     2,012 hz   runs:  1,934 /  2,090
//   coalesced 100 array appends     2,052 hz   runs:  2,015 /  2,090  — within noise
//   immediate 100 counter            2,044 hz  runs:  2,015 /  2,073
//   coalesced 100 counter            1,986 hz  runs:  1,875 /  2,098  — within noise
//   → coalesce is throughput-neutral across both array and scalar types (two-run confirmed)
//   → use coalesce for correctness (≤1 signal write per burst), not for throughput
// ---------------------------------------------------------------------------

describe('useCommandState — immediate vs coalesced dispatch cost', () => {
  bench('immediate — 10 dispatches, array append (simulates v-for source)', () => {
    const bus = createCommandBus();
    const { state, dispose } = useCommandState<number[]>(
      [],
      { append: (s, cmd) => [...s, cmd.target] },
    );
    for (let i = 0; i < 10; i++) bus.dispatch('append', i);
    dispose();
  });

  bench('coalesced — 10 dispatches, array append (simulates v-for source)', () => {
    const bus = createCommandBus();
    const { state, dispose } = useCommandState<number[]>(
      [],
      { append: (s, cmd) => [...s, cmd.target] },
      { coalesce: true },
    );
    for (let i = 0; i < 10; i++) bus.dispatch('append', i);
    dispose();
    void state;
  });

  bench('immediate — 100 dispatches, array append', () => {
    const bus = createCommandBus();
    const { state, dispose } = useCommandState<number[]>(
      [],
      { append: (s, cmd) => [...s, cmd.target] },
    );
    for (let i = 0; i < 100; i++) bus.dispatch('append', i);
    dispose();
    void state;
  });

  bench('coalesced — 100 dispatches, array append', () => {
    const bus = createCommandBus();
    const { state, dispose } = useCommandState<number[]>(
      [],
      { append: (s, cmd) => [...s, cmd.target] },
      { coalesce: true },
    );
    for (let i = 0; i < 100; i++) bus.dispatch('append', i);
    dispose();
    void state;
  });

  bench('immediate — 100 dispatches, counter (simulates v-if condition)', () => {
    const bus = createCommandBus();
    const { state, dispose } = useCommandState<number>(
      0,
      { inc: (s) => s + 1 },
    );
    for (let i = 0; i < 100; i++) bus.dispatch('inc', null);
    dispose();
    void state;
  });

  bench('coalesced — 100 dispatches, counter (simulates v-if condition)', () => {
    const bus = createCommandBus();
    const { state, dispose } = useCommandState<number>(
      0,
      { inc: (s) => s + 1 },
      { coalesce: true },
    );
    for (let i = 0; i < 100; i++) bus.dispatch('inc', null);
    dispose();
    void state;
  });
});

// ---------------------------------------------------------------------------
// Signal path comparison — fallback vs alien-signals add-on vs Vue ref
//
// Three signal backends available in vapor-chamber:
//   1. Plain { value } object — default fallback when Vue is absent and
//      configureAlienSignals has not been called. Zero overhead, not reactive.
//   2. alien-signals via configureAlienSignals — opt-in push-pull reactivity
//      for non-Vue contexts. Backed by the same algorithm Vue 3.6 uses.
//   3. Vue ref (auto-detected) — signal() returns vue.ref() when Vue is present.
//      Identical algorithm to (2) since Vue 3.6's ref() is alien-signals.
//
// These benches measure raw write throughput for each path so the cost of
// adding reactivity is visible. Run with and without the vue devDep installed
// to see the auto-detection path vs the explicit fallback.
//
// Baselines (v1.4.0 + Vue 3.6.0-beta.13, 2026-05-28):
//   plain { value } object 10k writes    ~368,000 hz  ← V8 DCE upper bound; real cost ≈ zero overhead
//   closure getter/setter (OLD, v1.3)      ~2,400 hz  ← real cost; setter is a fn call V8 cannot elide
//   alien-signals via alienSignalAdapter  ~10,500 hz  ← opt-in reactive; ~4× faster than old closure
//   Vue ref via signal() auto-detected     ~9,500 hz  ← same algorithm, slight Vue wrapper overhead
//   Vue ref + watchEffect subscriber      ~50,000 hz  (notify path — different iteration scale)
//   effectScope + onScopeDispose only ×1k ~158,000 hz ← beta.13 lazy job: no update job allocated
//   effectScope + signal + onScopeDispose  ~21,000 hz ← full reactive scope path
//   useCommandState 100 dispatches          ~1,700 hz
//   useCommandState coalesced 100           ~1,900 hz ← throughput-neutral (within noise)
// ---------------------------------------------------------------------------

describe('signal path comparison — fallback vs alien-signals add-on vs Vue ref', () => {
  beforeAll(async () => {
    await waitForVueDetection();
  });

  // ── without add-on (default fallback) ─────────────────────────────────────

  bench('plain { value } object — actual fallback (no Vue, no alien-signals)', () => {
    // NOTE: V8 may dead-code-eliminate these writes (no subscribers, fresh object
    // per iteration). The ~370k hz figure is an upper bound; real cost is near
    // zero overhead. The honest takeaway: plain property access has no function
    // call overhead, unlike getter/setter or alien-signals.
    const s = { value: 0 };
    let sink = 0;
    for (let i = 0; i < 10_000; i++) { s.value = i; sink = s.value; }
    if (sink < 0) console.log(sink);
  });

  bench('closure getter/setter — old v1.3 fallback (historical comparison)', () => {
    // Replaced in v1.4.0. The setter is a real function call — V8 cannot
    // eliminate it, so this measures actual invocation cost.
    let _v = 0;
    const s = { get value() { return _v; }, set value(v: number) { _v = v; } };
    let sink = 0;
    for (let i = 0; i < 10_000; i++) { s.value = i; sink = s.value; }
    if (sink < 0) console.log(sink);
  });

  // ── with alien-signals add-on ──────────────────────────────────────────────

  bench('alien-signals via alienSignalAdapter — opt-in reactive path', () => {
    // What you get after: configureAlienSignals(alienSignal)
    // or: configureSignal(alienSignalAdapter(alienSignal))
    const s = _alienFactory(0);
    let sink = 0;
    for (let i = 0; i < 10_000; i++) { s.value = i; sink = s.value; }
    if (sink < 0) console.log(sink);
  });

  // ── Vue auto-detected (beta.13) ────────────────────────────────────────────

  bench('Vue ref via signal() — auto-detected alien-signals path (beta.13)', () => {
    // What signal() returns when vue is present. Same algorithm as alien-signals
    // adapter above — Vue 3.6's ref() is alien-signals internally.
    const s = signal(0);
    let sink = 0;
    for (let i = 0; i < 10_000; i++) { s.value = i; sink = s.value; }
    if (sink < 0) console.log(sink);
  });

  bench('Vue ref + watchEffect subscriber — notify path (beta.13)', async () => {
    const { ref, watchEffect, effectScope } = await import('vue');
    const scope = effectScope();
    const r = ref(0);
    let sink = 0;
    scope.run(() => {
      watchEffect(() => { sink = r.value; });
    });
    for (let i = 0; i < 1_000; i++) r.value = i;
    scope.stop();
    void sink;
  });

  // ── beta.13 lifecycle overhead ────────────────────────────────────────────

  bench('effectScope + onScopeDispose only × 1k (beta.13 lazy job cost)', async () => {
    const { effectScope } = await import('vue');
    for (let i = 0; i < 1_000; i++) {
      const scope = effectScope();
      scope.run(() => {
        // tryAutoCleanup path — beta.13 does NOT allocate an update job here
        // because no reactive state is tracked inside the scope.
      });
      scope.stop();
    }
  });

  bench('effectScope + reactive signal + onScopeDispose × 1k (beta.13 full path)', async () => {
    const { effectScope, onScopeDispose } = await import('vue');
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

  // ── useCommandState with real Vue refs ────────────────────────────────────

  bench('useCommandState 100 dispatches — Vue ref signal writes (beta.13)', () => {
    const bus = createCommandBus();
    const { state, dispose } = useCommandState<number>(0, { inc: (s) => s + 1 });
    for (let i = 0; i < 100; i++) bus.dispatch('inc', null);
    dispose();
    void state;
  });

  bench('useCommandState coalesced 100 dispatches — Vue ref, 1 reactive write (beta.13)', () => {
    const bus = createCommandBus();
    const { state, dispose } = useCommandState<number>(0, { inc: (s) => s + 1 }, { coalesce: true });
    for (let i = 0; i < 100; i++) bus.dispatch('inc', null);
    dispose();
    void state;
  });
});

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
