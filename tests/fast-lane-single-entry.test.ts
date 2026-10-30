/**
 * A lane's single-listener emit path never meets a listener already off: unsubscribe replaces or deletes its bucket.
 * Why: both live-mode emits call a bucket's one listener with no `off` check, which holds only while an unsubscribe never leaves an off entry behind.
 * Shows: with and without onError, an emit calls only the live listener; the third case fails if an off entry is kept, the first two are controls.
 * See: log 36.63, src/fast-lane.ts.
 */
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
