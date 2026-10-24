/** A lane's single-listener emit path never meets a listener already off: unsubscribe replaces or deletes its bucket. Rationale at the end. */
import { describe, expect, it } from 'vitest';
import { createFastLane } from '../src/fast-lane';

for (const onError of [undefined, () => {}]) {
  describe(`live mode${onError ? ' with onError' : ''}`, () => {
    it('two listeners, one unsubscribed: the emit calls only the other', () => {
      const lane = createFastLane(onError ? { onError } : {});
      const ran: string[] = [];
      lane.on('tick', () => { ran.push('a'); });
      const offB = lane.on('tick', () => { ran.push('b'); });
      offB();
      lane.emit('tick', 1);
      expect(ran).toEqual(['a']);
    });

    it('the only listener unsubscribed, a new one subscribed: the emit calls only the new one', () => {
      const lane = createFastLane(onError ? { onError } : {});
      const ran: string[] = [];
      const offA = lane.on('tick', () => { ran.push('a'); });
      offA();
      lane.on('tick', () => { ran.push('c'); });
      lane.emit('tick', 1);
      expect(ran).toEqual(['c']);
    });

    it('the only listener unsubscribed and nothing else: the emit calls nothing (the pin: a kept off entry would be called)', () => {
      const lane = createFastLane(onError ? { onError } : {});
      const ran: string[] = [];
      lane.on('tick', () => { ran.push('a'); })();
      lane.emit('tick', 1);
      expect(ran).toEqual([]);
    });
  });
}

/*
 * Both live-mode emits, with and without `onError`, call a bucket's one
 * listener with no `off` check: in one bucket there is no neighbour to skip.
 * That holds because an unsubscribe never leaves an off entry in the bucket an
 * emit starts from: it replaces the bucket with one that drops the entry, or
 * deletes it when it empties (src/fast-lane.ts, `on`). If an unsubscribe ever
 * only marked its entry off and kept it, a bucket of one could hold an off
 * entry, and the fast path would call it: the third case fails then (seeded
 * and seen red, log 36.63). The first two keep a bucket of two, which the
 * loop's own `off` check covers: they are the controls.
 */
