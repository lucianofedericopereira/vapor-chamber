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

describe('cache() - invalidation during a read in flight', () => {
  it.each([
    ['a targeted invalidate', (c: ReturnType<typeof cache>) => c.invalidate('getUser', { id: 1 })],
    ['an action-wide invalidate', (c: ReturnType<typeof cache>) => c.invalidate('getUser')],
    ['clear()', (c: ReturnType<typeof cache>) => c.clear()],
  ])('does not store the overtaken answer after %s', async (_label, invalidate) => {
    const { bus, c, db, runs, release } = setup();
    const inflight = bus.dispatch('getUser', { id: 1 });
    db.name = 'new';
    invalidate(c);
    release();
    expect((await inflight).value).toEqual({ name: 'old' }); // its own caller still gets its answer

    const after = bus.dispatch('getUser', { id: 1 });
    release();
    expect((await after).value).toEqual({ name: 'new' });
    expect(runs()).toBe(2);
  });

  it('still stores a read no invalidation touched', async () => {
    const { bus, c, runs, release } = setup();
    const first = bus.dispatch('getUser', { id: 1 });
    c.invalidate('getUser', { id: 2 }); // another key
    release();
    await first;
    await bus.dispatch('getUser', { id: 1 });
    expect(runs()).toBe(1);
    expect(c.size()).toBe(1);
  });
});
