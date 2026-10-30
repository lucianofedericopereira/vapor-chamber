/**
 * `liveStores(bus)`: the stores live on a bus, as a new array.
 * Why: code that lists a bus's stores must not read an internal registry, and a loop that disposes
 * or creates stores while iterating would otherwise skip stores or change what it holds.
 * Shows: creation order per bus, none on a bus without stores, disposed stores and seeded-but-never-created
 * ids left out, and the returned array is a copy.
 * See: log s36.76
 */
import { describe, expect, it, vi } from 'vitest';
import { createAsyncCommandBus, createCommandBus } from '../src/command-bus';
import { liveStores, seedStores } from '../src/ssr';
import { defineChamberStore } from '../src/store';

const define = (id: string) => defineChamberStore(id, { state: () => ({ n: 0 }), reducers: { inc: (s) => ({ n: s.n + 1 }) } });
const useA = define('a');
const useB = define('b');

describe('liveStores(bus)', () => {
  it('the stores in use on that bus, in creation order; none on a bus without stores', () => {
    const bus = createCommandBus();
    const other = createAsyncCommandBus();
    expect(liveStores(bus)).toEqual([]);
    const a = useA(bus);
    const b = useB(bus);
    useA(other);
    expect(liveStores(bus)).toEqual([a, b]);
    a.$dispose();
    b.$dispose();
  });

  it('a disposed store is left out', () => {
    const bus = createCommandBus();
    const a = useA(bus);
    const b = useB(bus);
    a.$dispose();
    expect(liveStores(bus)).toEqual([b]);
    b.$dispose();
  });

  it('a new array: a store disposed or created while iterating changes nothing it holds', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bus = createCommandBus();
    const a = useA(bus);
    useB(bus);
    liveStores(bus).splice(0);
    expect(liveStores(bus)).toHaveLength(2);
    for (const store of liveStores(bus)) {
      store.$dispose();
      useA(bus);
    }
    expect(liveStores(bus)).toHaveLength(1);
    expect(liveStores(bus)[0]).not.toBe(a);
    vi.restoreAllMocks();
  });

  it('a seeded id whose store was never created is left out', () => {
    const bus = createCommandBus();
    seedStores(bus, { cart: { items: [1] } });
    const a = useA(bus);
    expect(liveStores(bus)).toEqual([a]);
    a.$dispose();
  });
});
