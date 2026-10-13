/** `$onField` subscribers that subscribe or unsubscribe while a write is delivered, as `bus.on` listeners do. Rationale at the end. */
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

/*
 * `notify` walked a field's subscriber array by
 * index while the unsubscribe spliced that same array: a subscriber that
 * unsubscribed itself during a write shifted the next one into its slot, and
 * the loop stepped past it, so a "once" subscriber made a later subscriber or
 * a `fieldRef` miss that write. The rule is now the bus's own for `bus.on`
 * listeners (src/command-bus.ts, `on` and `fanOutListeners`): an unsubscribe
 * marks its entry off and replaces the field's array with a filtered copy, a
 * write walks the array it read with its length taken at the start, skipping
 * entries marked off. So a subscriber removed during a write is not called
 * after its removal, every other one is called once, and one added during a
 * write starts with the next write (before, it was called for the write that
 * added it, because the loop re-read the length).
 */
