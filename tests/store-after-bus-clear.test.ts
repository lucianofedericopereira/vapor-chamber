/**
 * After `bus.clear()` on the async bus, `useStore(bus)` builds a new store whose actions run.
 * Why: clear() removes every handler and empties the bus's store registry together; joining a store from before the clear would answer `core:missing:handler`.
 * Shows: the next use builds a different store whose action succeeds and writes state; without clear() the same definition joins its store.
 * See: log s36.62
 */
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
