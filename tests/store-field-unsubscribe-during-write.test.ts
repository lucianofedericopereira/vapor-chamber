/**
 * `$onField` subscribers that subscribe or unsubscribe while a write is delivered, as `bus.on` listeners do.
 * Why: a subscriber that unsubscribes itself would shift the next one out of the delivery loop, so a later subscriber or a fieldRef would miss the write.
 * Shows: on both runtimes a self-unsubscribe skips nobody, a subscriber removed by an earlier one is not called for that write, one added during a write starts with the next write, and a stale unsubscribe after $dispose or re-subscribe changes nothing.
 * See: src/command-bus.ts (on, fanOutListeners).
 */
import { describe, expect, it } from 'vitest';
import { createCommandBus } from '../src/command-bus';
import { defineChamberStore as defineVue } from '../src/store';
import { defineChamberStore as defineCore } from '../src/store/core';

type S = { n: number; m: number };
const state = (): S => ({ n: 0, m: 0 });
const reducers = { inc: (s: S) => ({ ...s, n: s.n + 1 }), both: (s: S) => ({ n: s.n + 1, m: s.m + 1 }) };

for (const [runtime, define] of [['vue', defineVue], ['core', defineCore]] as const) {
  const make = () => (define as typeof defineCore)('fields', { state, reducers })(createCommandBus());

  describe(`${runtime} store: changing the subscribers during a write`, () => {
    it('a subscriber that unsubscribes itself does not make the next one miss the write', () => {
      const store = make();
      const ran: string[] = [];
      const offA = store.$onField('n', () => { ran.push('A'); offA(); });
      store.$onField('n', () => { ran.push('B'); });
      store.$onField('n', () => { ran.push('C'); });
      store.inc();
      store.inc();
      expect(ran).toEqual(['A', 'B', 'C', 'B', 'C']);
      store.$dispose();
    });

    it('a subscriber removed by an earlier one is not called for that write', () => {
      const store = make();
      const ran: string[] = [];
      let offB = (): void => {};
      store.$onField('n', () => { ran.push('A'); offB(); });
      offB = store.$onField('n', () => { ran.push('B'); });
      store.inc();
      expect(ran).toEqual(['A']);
      store.$dispose();
    });

    it('a subscriber added during a write is called from the next write', () => {
      const store = make();
      const ran: string[] = [];
      let added = false;
      store.$onField('n', (v) => {
        ran.push(`A${v as number}`);
        if (!added) { added = true; store.$onField('n', (w) => { ran.push(`B${w as number}`); }); }
      });
      store.inc();
      store.inc();
      expect(ran).toEqual(['A1', 'A2', 'B2']);
      store.$dispose();
    });

    it('unsubscribing one of two keeps the other; the last one leaves the field empty', () => {
      const store = make();
      const ran: string[] = [];
      const offA = store.$onField('m', () => { ran.push('A'); });
      const offB = store.$onField('m', () => { ran.push('B'); });
      offA();
      store.both();
      offB();
      store.both();
      expect(ran).toEqual(['B']);
      store.$dispose();
    });

    it('an unsubscribe after $dispose, or after the store subscribed again, changes nothing', () => {
      const store = make();
      const ran: string[] = [];
      const off = store.$onField('n', () => { ran.push('old'); });
      store.$dispose();
      const again = make();
      again.$onField('n', () => { ran.push('new'); });
      off();
      again.inc();
      expect(ran).toEqual(['new']);
      again.$dispose();
    });
  });
}
