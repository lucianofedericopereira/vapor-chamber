/**
 * A state from outside a store (a tab's, a server's, a seed) is a fact on the bus's store lane, written as it arrives, never coalesced.
 * Why: a fact written a microtask late would let share send it back (a message storm for one write), a seeded coalesce store would read its default state first, and `storeStates` would miss a same-tick write.
 * Shows: on both runtimes, with and without coalesce, one write in a tab crosses as one command per tab with no echo; two coalescing tabs writing at once both keep both writes; a server state lands at once past a pending own write; a seed is read at once; `storeStates` sees a same-tick write; after a takeover only the newest store hears the id's facts.
 * See: log s36.F30
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCommandBus } from '../src/command-bus';
import { defineChamberStore as defineVue } from '../src/store';
import { defineChamberStore as defineCore } from '../src/store/core';
import { shareTabs } from '../src/store-share';
import { seedStores, storeStates } from '../src/ssr';
import { listen, perTab, quiet } from './tabs-quiet';

type List = { items: number[] };
const state = (): List => ({ items: [] });
const reducers = { add: (s: List, n: number) => ({ items: [...s.items, n] }) };

const closers: Array<() => void> = [];
afterEach(() => { while (closers.length) closers.pop()!(); vi.unstubAllGlobals(); });

let n = 0;
for (const [runtime, define] of [['vue', defineVue], ['core', defineCore]] as const) {
  describe(`${runtime} store: facts are written as they arrive`, () => {
    beforeEach(() => { vi.stubGlobal('window', {}); });

    for (const coalesce of [false, true]) {
      it(`one write in a tab sends one message (coalesce ${coalesce})`, async () => {
        const name = `facts-${n++}`;
        const make = () => {
          const s = (define as typeof defineCore)('list', { state, reducers, coalesce, share: shareTabs(name) })(createCommandBus());
          closers.push(() => s.$dispose());
          return s;
        };
        const { heard, close } = listen(name);
        closers.push(close);
        const a = make();
        const b = make();
        await quiet(heard);
        heard.length = 0;
        a.add(1);
        await quiet(heard);
        // The write crosses once from its tab, and once more from the tab holding the lock when that is the other.
        expect(heard.every((m) => m.kind === 'cmd')).toBe(true);
        expect(perTab(heard).every((c) => c === 1)).toBe(true);
        expect(b.state.value).toEqual({ items: [1] });
      });
    }

    it('two coalescing tabs writing at once both keep both writes', async () => {
      const name = `facts-${n++}`;
      const make = () => {
        const s = (define as typeof defineCore)('list', { state, reducers, coalesce: true, share: shareTabs(name) })(createCommandBus());
        closers.push(() => s.$dispose());
        return s;
      };
      const { heard, close } = listen(name);
      closers.push(close);
      const a = make();
      const b = make();
      await quiet(heard);
      a.add(1);
      b.add(2);
      await quiet(heard);
      // The tab holding the lock runs both writes and the other follows it.
      expect([...a.state.value.items].sort()).toEqual([1, 2]);
      expect(b.state.value).toEqual(a.state.value);
    });

    it('a server state lands at once, after a pending own write', async () => {
      const bus = createCommandBus();
      const list = (define as typeof defineCore)('list', { state, reducers, coalesce: true })(bus);
      list.add(1);
      seedStores(bus, { list: { items: [9] } });
      expect(list.state.value.items).toEqual([9]);
      list.add(2);
      expect(list.state.value.items).toEqual([9]);
      await Promise.resolve();
      expect(list.state.value.items).toEqual([9, 2]);
      list.$dispose();
    });

    it('a seeded coalesce store reads its seed at once', () => {
      for (const coalesce of [false, true]) {
        const bus = createCommandBus();
        seedStores(bus, { list: { items: [5] } });
        const list = (define as typeof defineCore)('list', { state, reducers, coalesce })(bus);
        expect(list.state.value.items).toEqual([5]);
        list.$dispose();
      }
    });

    it('storeStates reads a coalesced write made in the same tick', () => {
      for (const coalesce of [false, true]) {
        const bus = createCommandBus();
        const list = (define as typeof defineCore)('list', { state, reducers, coalesce })(bus);
        list.add(1);
        expect(storeStates(bus)).toEqual({ list: { items: [1] } });
        list.$dispose();
      }
    });
  });
}

describe('a store taken over by another definition', () => {
  it('only the newest store hears the id\'s facts', () => {
    const bus = createCommandBus();
    const old = defineCore('list', { state, reducers })(bus);
    const next = defineCore('list', { state, reducers })(bus);
    seedStores(bus, { list: { items: [3] } });
    expect(next.state.value.items).toEqual([3]);
    expect(old.state.value.items).toEqual([]);
    next.$dispose();
    old.$dispose();
  });
});
