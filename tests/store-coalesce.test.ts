/**
 * A store with `coalesce: true` writes its state once per microtask, every write chained on the pending one.
 * Why: a burst of dispatches should cost one state write, one field event and one persist save; a state from outside (a server's, a tab's, a seed) is a fact and must land at once; undo is refused because a coalesced write has no "after" until the microtask.
 * Shows: on both runtimes, three dispatches give chained results and one write, `$reset` chains, a seed lands at once, persist saves once, a write before an async read chains and the replay keeps it, undo throws `store:invalid:coalesce` (code only in production); without coalesce each dispatch writes.
 * See: log s36.62, tests/store-facts-lane.test.ts
 */
import { describe, expect, it, vi } from 'vitest';
import { createCommandBus, type CommandResult } from '../src/command-bus';
import { defineChamberStore as defineVue } from '../src/store';
import { defineChamberStore as defineCore } from '../src/store/core';
import { saveTo } from '../src/store-persist';
import { seedStores } from '../src/ssr';

type List = { items: number[] };
const state = (): List => ({ items: [] });
const reducers = { add: (s: List, n: number) => ({ items: [...s.items, n] }) };
const tick = () => Promise.resolve();

for (const [runtime, define] of [['vue', defineVue], ['core', defineCore]] as const) {
  describe(`${runtime} store, coalesce`, () => {
    it('three dispatches write the state once, after the microtask, chained', async () => {
      const list = (define as typeof defineCore)('list', { state, reducers, coalesce: true })(createCommandBus());
      const writes: number[][] = [];
      list.$onField('items', (v) => { writes.push(v); });
      const r = [list.add(1), list.add(2), list.add(3)] as CommandResult[];
      expect(r.map((x) => (x.value as List).items)).toEqual([[1], [1, 2], [1, 2, 3]]);
      expect(list.state.value.items).toEqual([]);
      await tick();
      expect(list.state.value.items).toEqual([1, 2, 3]);
      expect(writes).toEqual([[1, 2, 3]]);
      list.add(4);
      await tick();
      expect(writes).toEqual([[1, 2, 3], [1, 2, 3, 4]]);
      list.$dispose();
    });

    it('$reset chains, and a server state lands at once after the pending write', async () => {
      const bus = createCommandBus();
      const list = (define as typeof defineCore)('list', { state, reducers, coalesce: true })(bus);
      list.add(1);
      list.$reset();
      list.add(2);
      expect(list.state.value.items).toEqual([]);
      await tick();
      expect(list.state.value.items).toEqual([2]);
      list.add(3);
      seedStores(bus, { list: { items: [9] } });
      expect(list.state.value.items).toEqual([9]);
      list.add(4);
      expect(list.state.value.items).toEqual([9]);
      await tick();
      expect(list.state.value.items).toEqual([9, 4]);
      list.$dispose();
    });

    it('persist saves the written state once', async () => {
      const saved: string[] = [];
      const list = (define as typeof defineCore)('list', { state, reducers, coalesce: true, persist: saveTo<List>({ key: 'l', storage: { getItem: () => null, setItem: (_k, v) => { saved.push(v); } } }) })(createCommandBus());
      list.add(1);
      list.add(2);
      await tick();
      await tick();
      expect(saved).toEqual([JSON.stringify({ items: [1, 2] })]);
      list.$dispose();
    });

    it('on an async storage, a write before the read lands chains too, and the replay keeps it', async () => {
      let land!: (v: string | null) => void;
      const storage = { getItem: () => new Promise<string | null>((r) => { land = r; }), setItem: () => {} };
      const list = (define as typeof defineCore)('list', { state, reducers, coalesce: true, persist: saveTo<List>({ key: 'l', storage }) })(createCommandBus());
      list.add(1);
      list.add(2);
      expect(list.state.value.items).toEqual([]);
      await tick();
      expect(list.state.value.items).toEqual([1, 2]);
      land(JSON.stringify({ items: [7] }));
      await tick();
      await tick();
      expect(list.state.value.items).toEqual([7, 1, 2]);
      list.$dispose();
    });

    it('is refused with undo: a ring cannot hold an unwritten step', () => {
      expect(() => (define as typeof defineCore)('list', { state, reducers, coalesce: true, undo: true })).toThrow(
        expect.objectContaining({ code: 'store:invalid:coalesce' }),
      );
    });

    it('control: without coalesce each dispatch writes', () => {
      const list = (define as typeof defineCore)('list', { state, reducers })(createCommandBus());
      list.add(1);
      expect(list.state.value.items).toEqual([1]);
      list.$dispose();
    });
  });
}

describe('coalesce, refused in production', () => {
  it('the refusal keeps its code without the advice', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.resetModules();
    try {
      const { defineChamberStore } = await import('../src/store/core');
      expect(() => defineChamberStore('list', { state, reducers, coalesce: true, undo: true })).toThrow(/^Store "list": coalesce and undo do not go together\.$/);
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});
