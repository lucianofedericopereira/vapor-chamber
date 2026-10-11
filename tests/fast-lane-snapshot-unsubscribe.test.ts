/**
 * createFastLane({ removal: 'snapshot' }) - an unsubscribe removes only its
 * own registration, as in the default live mode.
 *
 * It found its listener by function and removed every copy, so an unsubscribe
 * kept from before `remove()` or `clear()` took out a later registration of
 * the same function, and one of two registrations took out both.
 */
import { describe, expect, it } from 'vitest';
import { createFastLane } from '../src/fast-lane';

describe("fast lane, removal: 'snapshot' - an unsubscribe is its registration's", () => {
  it('one kept from before clear() does not remove a later registration', () => {
    const lane = createFastLane({ removal: 'snapshot' });
    const seen: number[] = [];
    const fn = (n: number) => seen.push(n);
    const stale = lane.on('tick', fn);
    lane.clear();
    lane.on('tick', fn);
    stale();
    lane.emit('tick', 1);
    expect(seen).toEqual([1]);
  });

  it('one kept from before remove(action) does not remove a later registration', () => {
    const lane = createFastLane({ removal: 'snapshot' });
    const seen: number[] = [];
    const fn = (n: number) => seen.push(n);
    const stale = lane.on('tick', fn);
    lane.remove('tick');
    lane.on('tick', fn);
    stale();
    lane.emit('tick', 2);
    expect(seen).toEqual([2]);
  });

  it('removes one of two registrations of the same function, as live mode does', () => {
    for (const removal of ['snapshot', 'live'] as const) {
      const lane = createFastLane({ removal });
      const seen: number[] = [];
      const fn = (n: number) => seen.push(n);
      const off = lane.on('tick', fn);
      lane.on('tick', fn);
      off();
      lane.emit('tick', 3);
      expect(seen).toEqual([3]);
    }
  });
});
