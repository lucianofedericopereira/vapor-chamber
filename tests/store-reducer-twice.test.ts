/** In development an `undo: true` store runs each reducer twice and warns once when the two differ (plan 1.27 item 1, R6). Rationale at the end. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCommandBus } from '../src/command-bus';
import { defineChamberStore } from '../src/store';
import { stubEnv } from '../src/vitest-pure';

afterEach(() => vi.restoreAllMocks());

const warnings = () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  return () => warn.mock.calls.map((c) => String(c[0]));
};

describe('development: a reducer runs twice', () => {
  it('a reducer that mints a value warns once per action', () => {
    const seen = warnings();
    let n = 0;
    const store = defineChamberStore('mint', { state: () => ({ ids: [] as number[] }), reducers: { add: (s) => ({ ids: [...s.ids, ++n] }) }, undo: true })(createCommandBus());
    store.add();
    store.add();
    expect(seen()).toHaveLength(1);
    expect(seen()[0]).toContain('the reducer for "mintAdd" gave two different states');
    store.$dispose();
  });

  it('a deterministic reducer runs twice and does not warn', () => {
    const seen = warnings();
    let calls = 0;
    const store = defineChamberStore('pure', { state: () => ({ n: 0 }), reducers: { inc: (s) => { calls++; return { n: s.n + 1 }; } }, undo: true })(createCommandBus());
    store.inc();
    expect(calls).toBe(2);
    expect(store.state.value).toEqual({ n: 1 });
    expect(seen()).toEqual([]);
    store.$dispose();
  });

  it('a state JSON cannot hold is not compared, and the action still runs', () => {
    const seen = warnings();
    const store = defineChamberStore('big', { state: () => ({ n: 0n }), reducers: { inc: (s) => ({ n: s.n + 1n }) }, undo: true })(createCommandBus());
    store.inc();
    expect(store.state.value.n).toBe(1n);
    expect(seen()).toEqual([]);
    store.$dispose();
  });

  it('$reset is not checked: a rollback keeps the state it set', () => {
    const seen = warnings();
    let n = 0;
    const store = defineChamberStore('fresh', { state: () => ({ at: ++n }), reducers: { set: (_s, at: number) => ({ at }) }, undo: true })(createCommandBus());
    store.$reset();
    expect(seen()).toEqual([]);
    store.$dispose();
  });

  it('control: a store without undo runs its reducer once', () => {
    let calls = 0;
    const store = defineChamberStore('once', { state: () => ({ n: 0 }), reducers: { inc: (s) => { calls++; return { n: s.n + 1 }; } } })(createCommandBus());
    store.inc();
    expect(calls).toBe(1);
    store.$dispose();
  });
});

describe('development: the two runs compared as JSON, without whole-state strings', () => {
  /** An object that counts how often JSON.stringify reads it. */
  const counted = () => { const c = { n: 0, toJSON() { c.n++; return 'c'; } }; return c; };

  it('a part the reducer leaves alone is never serialized', () => {
    const seen = warnings();
    const kept = counted();
    const store = defineChamberStore('keep', { state: () => ({ kept, n: 0 }), reducers: { inc: (s) => ({ ...s, n: s.n + 1 }) }, undo: true })(createCommandBus());
    store.inc();
    store.inc();
    expect({ reads: kept.n, warned: seen() }).toEqual({ reads: 0, warned: [] });
    store.$dispose();
  });

  it('control: an object the reducer builds anew in each run is serialized, and the same JSON does not warn', () => {
    const seen = warnings();
    const reads = { n: 0 };
    const store = defineChamberStore('fresh2', {
      state: () => ({ c: null as unknown }),
      reducers: { set: () => ({ c: { toJSON() { reads.n++; return 'c'; } } }) },
      undo: true,
    })(createCommandBus());
    store.set();
    expect({ reads: reads.n, warned: seen() }).toEqual({ reads: 2, warned: [] });
    store.$dispose();
  });

  it('a counter minted deep in a nested array warns once', () => {
    const seen = warnings();
    let n = 0;
    const store = defineChamberStore('deep', {
      state: () => ({ rows: [[{ id: 0 }]] }),
      reducers: { add: (s) => ({ rows: [...s.rows, [{ id: ++n }]] }) },
      undo: true,
    })(createCommandBus());
    store.add();
    store.add();
    expect(seen()).toHaveLength(1);
    store.$dispose();
  });

  it('a time minted with Date.now warns at the first dispatch once the clock moves between the runs', () => {
    const seen = warnings();
    let t = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => t++);
    const store = defineChamberStore('clock', { state: () => ({ at: 0 }), reducers: { touch: () => ({ at: Date.now() }) }, undo: true })(createCommandBus());
    store.touch();
    expect(seen()).toHaveLength(1);
    store.$dispose();
  });

  // Each pair: the reducer answers `a` on its first run and `b` on its second.
  // It warns exactly when JSON.stringify gives two different strings.
  class Point { constructor(public x: number) {} }
  const nul = Object.assign(Object.create(null), { a: 1 });
  const pairs: Array<[string, unknown, unknown]> = [
    ['undefined slot against null', [undefined], [null]],
    ['null against an undefined slot', [null], [undefined]],
    ['a function slot against null', [() => 1], [null]],
    ['NaN slot against null', [Number.NaN], [null]],
    ['an undefined property against none', { a: undefined, b: 1 }, { b: 1 }],
    ['none against an undefined property', { b: 1 }, { a: undefined, b: 1 }],
    ['a fresh function property against none', { f: () => 1, b: 1 }, { b: 1 }],
    ['a fresh Map', { m: new Map([[1, 2]]) }, { m: new Map() }],
    ['a fresh Date of the same time', { d: new Date(0) }, { d: new Date(0) }],
    ['a fresh Date of another time', { d: new Date(0) }, { d: new Date(1) }],
    ['a null-prototype object against a plain one', nul, { a: 1 }],
    ['a class instance against a plain object', new Point(1), { x: 1 }],
    ['the same keys in another order', { a: 1, b: 2 }, { b: 2, a: 1 }],
    ['another key with the same value', { a: 1 }, { b: 1 }],
    ['one slot more', [1, 2], [1, 2, 3]],
    ['one slot fewer', [1, 2, 3], [1, 2]],
    ['an array against an object', [1], { 0: 1 }],
    ['a deep difference', { a: [{ b: [1, { c: 2 }] }] }, { a: [{ b: [1, { c: 3 }] }] }],
    ['-0 against 0', { z: -0 }, { z: 0 }],
  ];
  for (const [label, a, b] of pairs) {
    const differ = JSON.stringify(a) !== JSON.stringify(b);
    it(`${label}: ${differ ? 'warns' : 'does not warn'}, as JSON.stringify says`, () => {
      const seen = warnings();
      let run = 0;
      const store = defineChamberStore(`p${pairs.findIndex((p) => p[0] === label)}`, {
        state: () => ({}) as object,
        reducers: { set: () => (run++ % 2 === 0 ? a : b) as object },
        undo: true,
      })(createCommandBus());
      store.set();
      expect(seen().length).toBe(differ ? 1 : 0);
      store.$dispose();
    });
  }

  it('a BigInt in a shared part does not stop a pure action, and an impure one is not compared, as before', () => {
    const seen = warnings();
    const big = { v: 1n };
    let n = 0;
    const store = defineChamberStore('bigpart', {
      state: () => ({ big, n: 0, id: 0 }),
      reducers: { inc: (s) => ({ ...s, n: s.n + 1 }), mint: (s) => ({ ...s, id: ++n }) },
      undo: true,
    })(createCommandBus());
    store.inc();
    store.mint();
    expect({ n: store.state.value.n, warned: seen() }).toEqual({ n: 1, warned: [] });
    store.$dispose();
  });
});

describe('production', () => {
  it('runs the reducer once and warns about nothing', async () => {
    using _NODE_ENV = stubEnv('NODE_ENV', 'production');
    vi.resetModules();
    const seen = warnings();
    const { createCommandBus: bus } = await import('../src/command-bus');
    const { defineChamberStore: define } = await import('../src/store');
    let n = 0;
    const store = define('prod', { state: () => ({ ids: [] as number[] }), reducers: { add: (s) => ({ ids: [...s.ids, ++n] }) }, undo: true })(bus());
    store.add();
    expect(n).toBe(1);
    expect(seen()).toEqual([]);
    store.$dispose();
    vi.resetModules();
  });
});

/*
 * A rollback of an older step replays every later step by calling its
 * reducer again (log s35.157). A reducer that mints a value, an id or a time,
 * then rebases to a different state: a re-keyed row, the data otherwise
 * right. React's StrictMode double-invokes reducers in development to expose
 * the same impurity. Here the two results are also compared (as JSON), and a
 * difference warns once per action with the fix: mint in the call. Undo and
 * redo do not need deterministic reducers (redo writes the recorded state,
 * s35.158). Production runs each reducer once; the check folds away with DEV.
 */
