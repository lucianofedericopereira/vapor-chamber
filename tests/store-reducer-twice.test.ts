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
