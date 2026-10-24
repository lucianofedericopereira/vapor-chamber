/**
 * cache() - an invalidation that overtakes a read in flight.
 *
 * A read missed, started, and a write then invalidated its key while it was
 * still running. The read settled afterwards and stored its answer from before
 * the write, so every read after the invalidation was served that stale answer
 * until the TTL ran out. The HTTP client's cache has the same window closed
 * with read tickets; this is the bus-level cache's version of it.
 *
 * The read in flight still answers its own caller (it is a real answer to the
 * question it asked); it is only not stored.
 */
import { describe, expect, it } from 'vitest';
import { cache, createAsyncCommandBus } from '../src/index';

function setup() {
  const bus = createAsyncCommandBus({ retry: false });
  const c = cache({ actions: ['getUser'], ttl: 60_000 });
  bus.use(c);
  const db = { name: 'old' };
  let runs = 0;
  let release: () => void = () => {};
  bus.register('getUser', () => {
    runs++;
    const seen = db.name;
    return new Promise((resolve) => { release = () => resolve({ name: seen }); });
  });
  return { bus, c, db, runs: () => runs, release: () => release() };
}

describe('cache() - clear() during a read in flight', () => {
  it('does not store the overtaken answer after clear()', async () => {
    const { bus, c, db, runs, release } = setup();
    const inflight = bus.dispatch('getUser', { id: 1 });
    db.name = 'new';
    c.clear();
    release();
    expect((await inflight).value).toEqual({ name: 'old' }); // its own caller still gets its answer

    const after = bus.dispatch('getUser', { id: 1 });
    release();
    expect((await after).value).toEqual({ name: 'new' });
    expect(runs()).toBe(2);
  });

});
