/** After `bus.clear()` on the async bus, `useStore(bus)` builds a store whose actions run. Rationale at the end. */
import { describe, expect, it } from 'vitest';
import { createAsyncCommandBus } from '../src/command-bus';
import { defineChamberStore } from '../src/store/core';

type C = { n: number };
const useCount = defineChamberStore('count', { state: (): C => ({ n: 0 }), reducers: { inc: (s: C) => ({ n: s.n + 1 }) } });

describe('a store after bus.clear()', () => {
  it('the next useStore(bus) builds a store whose actions run', async () => {
    const bus = createAsyncCommandBus({ retry: false });
    const first = useCount(bus);
    bus.clear();
    const next = useCount(bus);
    expect(next).not.toBe(first);
    expect((await next.inc()).ok).toBe(true);
    expect(next.state.value.n).toBe(1);
    next.$dispose();
  });

  it('control: without clear(), the same definition joins its store', () => {
    const bus = createAsyncCommandBus({ retry: false });
    const first = useCount(bus);
    expect(useCount(bus)).toBe(first);
    first.$dispose();
  });
});

/*
 * `bus.clear()` removes every handler and, on the async bus, empties the map
 * a server's state finds its store in. The store registry was a second map
 * that clear() never reached: the next `useStore(bus)` joined the old store,
 * whose actions then answered `core:missing:handler`. Since 4e (log 36.62) the
 * registry IS that map, one entry per store, so clear() empties both and the
 * next `useStore(bus)` builds a new store. The sync bus has no such map of its
 * own: its stores live in the registry the first store makes, untouched by
 * clear(), as before.
 */
