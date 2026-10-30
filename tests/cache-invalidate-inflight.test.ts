/**
 * cache(): a clear() that overtakes a read in flight.
 * Why: an answer from before the clear, stored after it, would be served stale until its TTL; the HTTP client closes the same window with read tickets.
 * Shows: the read in flight still answers its own caller but is not stored; the next read runs again and gets the new value.
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
