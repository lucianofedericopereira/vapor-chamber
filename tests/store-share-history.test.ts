/** After two tabs meet, each tab's history is the same and true to the one state: stacks, canUndo, canRedo, an undo, a redo. Rationale at the end. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope } from 'vue';
import { createCommandBus, type Command } from '../src/command-bus';
import { useCommandHistory } from '../src/chamber';
import { defineChamberStore } from '../src/store/core';
import { shareTabs } from '../src/store-share';
import { history } from '../src/plugins-core';
import { listen, quiet } from './tabs-quiet';

type S = { items: string[] };
const reducers = { push: (s: S, x: string) => ({ items: [...s.items, x] }) };

const closers: Array<() => void> = [];
beforeEach(() => { vi.stubGlobal('window', {}); });
afterEach(() => { while (closers.length) closers.pop()!(); vi.unstubAllGlobals(); });

/** One history an app reads: its two stacks, whether it can undo and redo, and its presses. */
type View = { past(): readonly Command[]; future(): readonly Command[]; canUndo(): boolean; canRedo(): boolean; undo(): void; redo(): void };

const kinds: Record<string, (bus: ReturnType<typeof createCommandBus>) => View> = {
  'history()': (bus) => {
    const h = history({ bus });
    closers.push(() => h.dispose());
    return { past: () => h.getState().past, future: () => h.getState().future, canUndo: () => h.getState().canUndo, canRedo: () => h.getState().canRedo, undo: () => { h.undo(); }, redo: () => { h.redo(); } };
  },
  useCommandHistory: (bus) => {
    const scope = effectScope();
    const h = scope.run(() => useCommandHistory({ bus }))!;
    closers.push(() => scope.stop());
    return { past: () => h.past.value, future: () => h.future.value, canUndo: () => h.canUndo.value, canRedo: () => h.canRedo.value, undo: () => { h.undo(); }, redo: () => { h.redo(); } };
  },
};

let n = 0;
function tab(name: string, kind: string) {
  const bus = createCommandBus();
  const h = kinds[kind]!(bus);
  const store = defineChamberStore('hist', { state: (): S => ({ items: [] }), reducers, undo: true, share: shareTabs(name) })(bus);
  closers.push(() => store.$dispose());
  return { store, h };
}
type Tab = ReturnType<typeof tab>;

/** What an app reads of a tab's history, by each command's target. */
const read = (t: Tab) => ({
  state: t.store.state.value.items,
  past: t.h.past().map((c) => c.target),
  future: t.h.future().map((c) => c.target),
  canUndo: t.h.canUndo(),
  canRedo: t.h.canRedo(),
});

/** Both tabs read the same, and the history's past holds exactly the state's writes. */
function same(a: Tab, b: Tab): ReturnType<typeof read> {
  const ra = read(a);
  expect(read(b)).toEqual(ra);
  expect([...ra.past].sort()).toEqual([...ra.state].sort());
  return ra;
}

for (const kind of Object.keys(kinds)) {
  describe(`two tabs that met, read through ${kind}`, () => {
    it('read the same history, true to the state, through an undo, a redo and undoing all', async () => {
      const name = `hist-${n++}`;
      const wire = listen(name);
      closers.push(wire.close);
      const a = tab(name, kind);
      const b = tab(name, kind);
      await quiet(wire.heard);
      a.store.push('x');
      b.store.push('y');
      await quiet(wire.heard);
      const met = same(a, b);
      expect(met.past).toHaveLength(2);
      expect(met.canUndo).toBe(true);
      b.h.undo();
      await quiet(wire.heard);
      const once = same(a, b);
      expect(once.state).toHaveLength(1);
      expect(once).toMatchObject({ canUndo: true, canRedo: true });
      a.h.redo();
      await quiet(wire.heard);
      expect(same(a, b).state).toHaveLength(2);
      a.h.undo();
      await quiet(wire.heard);
      b.h.undo();
      await quiet(wire.heard);
      expect(same(a, b)).toMatchObject({ state: [], past: [], canUndo: false });
    });
  });
}

/*
 * When the lead's command reaches a tab before the lead ran that tab's own
 * write, the tab runs its write again over the lead's (log 36.F39). Its state
 * and its ring then hold the lead's arrangement. Its history must too: a
 * history that differs from the other tab's, or from the commands its state
 * holds, changes what Undo takes there by when the writes met, the class of
 * bug B2 (B2-F1, log 36.F40). Each tab reads and presses through one history,
 * as an app does: two histories on one bus are two stacks.
 */
