/** A store's own keyed field events ($onField) and their Vue binding (fieldRef). Log s35.104 (measured), s35.125. */
import { describe, expect, it } from 'vitest';
import { effectScope, watchEffect } from 'vue';
import { createCommandBus } from '../src/command-bus';
import { history } from '../src/plugins-core';
import { defineChamberStore, fieldRef } from '../src/store';

type S = { a: number; b: number; list: number[] };
const useS = defineChamberStore('fields', {
  state: (): S => ({ a: 0, b: 0, list: [] }),
  reducers: {
    setA: (s: S, a: number) => ({ ...s, a }),
    setB: (s: S, b: number) => ({ ...s, b }),
  },
  undo: true,
});

describe('$onField', () => {
  it('fires for the field that changed, with its new value, and not for the others', () => {
    const bus = createCommandBus();
    const store = useS(bus);
    const a: number[] = [];
    const b: number[] = [];
    store.$onField('a', (v) => a.push(v as number));
    store.$onField('b', (v) => b.push(v as number));
    store.setA(1);
    store.setA(1); // same value: no event
    store.setB(2);
    expect(a).toEqual([1]);
    expect(b).toEqual([2]);
    store.$dispose();
  });

  it('unsubscribes, and fires on $reset and on an undo too', () => {
    const bus = createCommandBus();
    const h = history({ bus });
    bus.use(h);
    const store = useS(bus);
    const a: number[] = [];
    const off = store.$onField('a', (v) => a.push(v as number));
    store.setA(5);
    h.undo();
    store.setA(7);
    store.$reset();
    off();
    store.setA(9);
    expect(a).toEqual([5, 0, 7, 0]);
    store.$dispose();
  });

  it('unsubscribing twice is harmless; $dispose drops every subscriber', () => {
    const bus = createCommandBus();
    const store = useS(bus);
    const a: number[] = [];
    const off = store.$onField('a', (v) => a.push(v as number));
    off();
    off();
    store.$onField('a', (v) => a.push(v as number));
    store.$dispose();
    const again = useS(bus);
    again.setA(4);
    expect(a).toEqual([]);
    again.$dispose();
  });

  it('$onField is a store member an action cannot take', () => {
    expect(() => defineChamberStore('x', { state: () => ({}), reducers: { $onField: (s: object) => s } })).toThrow(/would replace the store's own "\$onField"/);
  });
});

describe('fieldRef', () => {
  it('a reader of one field re-runs only when that field changes', () => {
    const bus = createCommandBus();
    const store = useS(bus);
    const scope = effectScope();
    let runs = 0;
    scope.run(() => {
      const a = fieldRef(store, 'a');
      watchEffect(() => { void a.value; runs++; }, { flush: 'sync' });
    });
    store.setB(1);
    store.setB(2);
    expect(runs).toBe(1);
    store.setA(3);
    expect(runs).toBe(2);
    expect(fieldRef(store, 'a').value).toBe(3);
    expect(fieldRef(store, 'a')).toBe(fieldRef(store, 'a')); // one binding per field
    scope.stop();
    store.$dispose();
  });
});
