/**
 * A store with `undo: true` keeps at most UNDO_RING (256) undone steps.
 *
 * A redo reads only the newest undone steps, and history drops its redo list
 * on a new action, so older undone steps can never be redone; kept, each held
 * two whole states for the store's lifetime (1,000 action-and-undo rounds of
 * 80 KB states: 89 MB, against 29 MB without the undos; the measurement is
 * a GC probe outside the suite). Past the bound, undo and redo still work.
 */
import { describe, expect, it } from 'vitest';
import { createCommandBus } from '../src/command-bus';
import { defineChamberStore } from '../src/store';
import { history } from '../src/plugins-core';

type Doc = { n: number };
const useDoc = defineChamberStore('undoneBound', { state: (): Doc => ({ n: 0 }), reducers: { put: (_s: Doc, n: number) => ({ n }) }, undo: true });

describe('store undo - undone steps past the bound', () => {
  it('300 rounds of an action and its undo, then undo and redo still work', () => {
    const bus = createCommandBus();
    const h = history({ bus, maxSize: 1000 });
    const store = useDoc(bus);
    for (let i = 1; i <= 300; i++) {
      store.put(i);
      h.undo();
    }
    expect(store.state.value.n).toBe(0);
    store.put(7);
    store.put(8);
    h.undo();
    expect(store.state.value.n).toBe(7);
    h.redo();
    expect(store.state.value.n).toBe(8);
    store.$dispose();
  });
});
