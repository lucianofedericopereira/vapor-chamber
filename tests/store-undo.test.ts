/** `undo: true` on a store: its actions undo through `history`, as commands. Rationale at the end. */
import { describe, expect, it } from 'vitest';
import { resetCommandBus, setCommandBus, useCommandHistory } from '../src/chamber';
import { createAsyncCommandBus, createCommandBus } from '../src/command-bus';
import { history } from '../src/plugins-core';
import { persist } from '../src/plugins-io';
import { defineChamberStore } from '../src/store';

type List = { items: number[] };
const reducers = {
  add: (s: List, n: number) => ({ items: [...s.items, n] }),
  clear: () => ({ items: [] as number[] }),
};
const useUndoable = defineChamberStore('undoable', { state: (): List => ({ items: [] }), reducers, undo: true });
const usePlain = defineChamberStore('plain', { state: (): List => ({ items: [] }), reducers });

function memoryStorage() {
  let stored: string | null = null;
  return { getItem: () => stored, setItem: (_k: string, v: string) => { stored = v; }, removeItem: () => { stored = null; }, read: () => stored };
}

describe('a store with undo: true', () => {
  it('undo goes back one action at a time, redo forward again', () => {
    const bus = createCommandBus();
    const h = history({ bus });
    bus.use(h);
    const store = useUndoable(bus);
    store.add(1);
    store.add(2);
    h.undo();
    expect(store.state.value.items).toEqual([1]);
    h.undo();
    expect(store.state.value.items).toEqual([]);
    h.redo();
    expect(store.state.value.items).toEqual([1]);
    h.redo();
    expect(store.state.value.items).toEqual([1, 2]);
    h.undo();
    expect(store.state.value.items).toEqual([1]);
    store.$dispose();
  });

  it('the undo is a command: persist stores the undone state, and a reload reads it', () => {
    const storage = memoryStorage();
    const bus = createCommandBus();
    const h = history({ bus });
    bus.use(h);
    const store = useUndoable(bus);
    bus.use(persist({ key: 'vc:undoable', storage, getState: () => store.state.value }));
    store.add(1);
    store.add(2);
    h.undo();
    expect(storage.read()).toBe(JSON.stringify({ items: [1] }));
    expect(persist<List>({ key: 'vc:undoable', storage, getState: () => ({ items: [] }) }).load()).toEqual({ items: [1] });
    store.$dispose();
  });

  it('a listener hears the undo as <action>$undo and the redo as the action, each with its origin', () => {
    const bus = createCommandBus();
    const h = history({ bus });
    bus.use(h);
    const heard: string[] = [];
    bus.on('*', (cmd) => heard.push(`${cmd.action}:${cmd.meta?.origin ?? '-'}`));
    const store = useUndoable(bus);
    store.add(1);
    h.undo();
    h.redo();
    expect(heard.slice(1)).toEqual(['undoableAdd$undo:undo', 'undoableAdd:redo']);
    store.$dispose();
  });

  it("the undo's own dispatch is not recorded as a new step", () => {
    const bus = createCommandBus();
    const h = history({ bus });
    bus.use(h);
    const store = useUndoable(bus);
    store.add(1);
    h.undo();
    expect(h.getState().past).toEqual([]);
    expect(h.getState().future.map((c) => c.action)).toEqual(['undoableAdd']);
    store.$dispose();
  });

  it('$reset undoes too, back to the state before it', () => {
    const bus = createCommandBus();
    const h = history({ bus });
    bus.use(h);
    const store = useUndoable(bus);
    store.add(1);
    store.$reset();
    expect(store.state.value.items).toEqual([]);
    h.undo();
    expect(store.state.value.items).toEqual([1]);
    store.$dispose();
  });

  it('two stores on one bus undo their own state only', () => {
    const useOther = defineChamberStore('other', { state: (): List => ({ items: [] }), reducers, undo: true });
    const bus = createCommandBus();
    const h = history({ bus });
    bus.use(h);
    const a = useUndoable(bus);
    const b = useOther(bus);
    a.add(1);
    b.add(9);
    h.undo();
    expect(b.state.value.items).toEqual([]);
    expect(a.state.value.items).toEqual([1]);
    a.$dispose();
    b.$dispose();
  });

  it('on an async bus the state is back once undo settles', async () => {
    const bus = createAsyncCommandBus();
    const h = history({ bus });
    bus.use(h);
    const store = useUndoable(bus);
    await store.add(1);
    await store.add(2);
    await h.undo();
    expect(store.state.value.items).toEqual([1]);
    store.$dispose();
  });

  it('on an async bus, each undo once the last has settled walks back one more write', async () => {
    const bus = createAsyncCommandBus();
    const h = history({ bus });
    bus.use(h);
    const store = useUndoable(bus);
    await store.add(1);
    await store.add(2);
    const settled = () => new Promise((r) => setTimeout(r, 0));
    expect(h.undo()).toBeDefined();
    expect(h.undo()).toBeUndefined(); // a press while one is in flight does nothing
    await settled();
    expect(h.undo()).toBeDefined();
    await settled();
    expect(store.state.value.items).toEqual([]);
    store.$dispose();
  });

  it('cannot undo past a change the history did not record, and says so', () => {
    const bus = createCommandBus();
    const h = history({ bus, filter: (cmd) => cmd.action !== 'undoableClear' });
    bus.use(h);
    const store = useUndoable(bus);
    store.add(1);
    store.clear(); // not recorded
    expect(h.getState().canUndo).toBe(false);
    expect(h.undo()).toBeUndefined();
    expect(store.state.value.items).toEqual([]);
    store.add(2);
    expect(h.getState().canUndo).toBe(true);
    h.undo();
    expect(store.state.value.items).toEqual([]);
    store.$dispose();
  });

  it("useCommandHistory's canUndo signal follows a store write it did not record", () => {
    const bus = createCommandBus();
    setCommandBus(bus);
    const store = useUndoable(bus);
    const hist = useCommandHistory({ filter: (cmd) => cmd.action !== 'undoableClear' });
    store.add(1);
    expect(hist.canUndo.value).toBe(true);
    store.clear();
    expect(hist.canUndo.value).toBe(false);
    store.add(2);
    expect(hist.canUndo.value).toBe(true);
    hist.dispose();
    store.$dispose();
    resetCommandBus();
  });

  it('after a redo the redone action can be undone again', () => {
    const bus = createCommandBus();
    const h = history({ bus });
    bus.use(h);
    const store = useUndoable(bus);
    store.add(1);
    store.add(2);
    h.undo();
    h.undo();
    h.redo();
    h.redo();
    expect(h.getState().canUndo).toBe(true);
    h.undo();
    expect(store.state.value.items).toEqual([1]);
    expect(h.getState().canUndo).toBe(true);
    h.undo();
    expect(store.state.value.items).toEqual([]);
    store.$dispose();
  });

  it('a refused restore leaves the step to undo, and redo stays paired', () => {
    const bus = createCommandBus();
    const h = history({ bus });
    bus.use(h);
    let refuse = false;
    bus.onBefore((cmd) => { if (cmd.action.endsWith('$undo') && refuse) throw new Error('not now'); });
    const store = useUndoable(bus);
    store.add(1);
    store.add(2);
    h.undo(); // [1]
    refuse = true;
    h.undo(); // refused: still [1], the step stays
    expect(store.state.value.items).toEqual([1]);
    expect(h.getState().past).toHaveLength(1);
    refuse = false;
    h.redo(); // [1, 2]: the redo of add(2), credited to add(2)
    expect(store.state.value.items).toEqual([1, 2]);
    expect(h.getState().canUndo).toBe(true);
    h.undo();
    expect(store.state.value.items).toEqual([1]);
    store.$dispose();
  });

  it('keeps its last 256 steps: an older one reads canUndo false and is not undone', () => {
    const bus = createCommandBus();
    const h = history({ bus, maxSize: 300 });
    bus.use(h);
    const store = useUndoable(bus);
    for (let i = 0; i < 257; i++) store.add(i);
    for (let i = 0; i < 256; i++) h.undo();
    expect(store.state.value.items).toEqual([0]);
    expect(h.getState().canUndo).toBe(false);
    expect(h.undo()).toBeUndefined();
    expect(store.state.value.items).toEqual([0]);
    store.$dispose();
  });

  it('$dispose unregisters the $undo commands with the actions', () => {
    const bus = createCommandBus();
    const store = useUndoable(bus);
    expect(bus.hasHandler('undoableAdd$undo')).toBe(true);
    store.$dispose();
    expect(bus.hasHandler('undoableAdd$undo')).toBe(false);
  });
});

describe('a store without undo (the default): as before', () => {
  it('history records the action, and undo leaves the state as it is', () => {
    const bus = createCommandBus();
    const h = history({ bus });
    bus.use(h);
    const store = usePlain(bus);
    store.add(1);
    store.add(2);
    expect(h.getState().past.map((c) => c.action)).toEqual(['plainAdd', 'plainAdd']);
    h.undo();
    expect(store.state.value.items).toEqual([1, 2]);
    expect(bus.getUndoHandler('plainAdd')).toBeUndefined();
    expect(bus.hasHandler('plainAdd$undo')).toBe(false);
    store.$dispose();
  });
});

/*
 * Handoff finding 1: the store registered no inverse, so history could not undo
 * its actions. Log s35.112 and s35.113.
 */
