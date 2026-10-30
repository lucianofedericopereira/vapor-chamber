/**
 * register(action, handler, { undo, canUndo }): canUndo says whether undo can run, and history undoes only then.
 * Why: history undoes newest first and asks canUndo before each undo; running an undo that no longer fits the
 * state would corrupt it, while a rollback after a failure must always reverse the step that ran (a store's rebase relies on it).
 * Shows: getState().canUndo and undo() follow the check (false after an unrecorded change, true again on top, dropped
 * on unregister, async bus, useCommandHistory signal), and a transactional batch and an optimistic action roll back whatever canUndo says.
 * See: docs/rc-alignment-log.md s35.113, s35.161
 */
import { afterEach, describe, expect } from 'vitest';
import { resetCommandBus, setCommandBus, useCommandHistory } from '../src/chamber';
import { type Command, createAsyncCommandBus, createCommandBus } from '../src/command-bus';
import { history } from '../src/plugins-core';
import { it } from '../src/vitest';

afterEach(() => resetCommandBus());

/** A counter whose `inc` can be undone only while nothing else moved it. */
function counter(bus: ReturnType<typeof createCommandBus>) {
  let n = 0;
  const produced = new WeakMap<object, number>();
  const undone: number[] = [];
  bus.register('inc', (cmd) => { n++; produced.set(cmd, n); return n; }, {
    undo: () => { n--; undone.push(n); },
    canUndo: (cmd: Command) => produced.get(cmd) === n,
  });
  bus.register('bump', () => { n += 10; return n; });
  return { read: () => n, undone };
}

describe('canUndo on register', () => {
  it('history reports it, and undo() runs only when it is true', () => {
    const bus = createCommandBus();
    const h = history({ bus, actionFilter: (a) => a !== 'bump' });
    const c = counter(bus);
    bus.dispatch('inc', null);
    expect(h.getState().canUndo).toBe(true);

    bus.dispatch('bump', null); // not recorded, and it moved the counter
    expect(h.getState().canUndo).toBe(false);
    expect(h.undo()).toBeUndefined();
    expect(c.read()).toBe(11);
    expect(c.undone).toEqual([]);
    expect(h.getState().past.map((x) => x.action)).toEqual(['inc']);
  });

  it('true again once the command on top can be undone', () => {
    const bus = createCommandBus();
    const h = history({ bus, actionFilter: (a) => a !== 'bump' });
    const c = counter(bus);
    bus.dispatch('inc', null);
    bus.dispatch('bump', null);
    bus.dispatch('inc', null);
    expect(h.getState().canUndo).toBe(true);
    h.undo();
    expect(c.read()).toBe(11);
  });

  it('without canUndo, a non-empty history can undo, as before', () => {
    const bus = createCommandBus();
    const h = history({ bus });
    bus.register('plain', () => 1, { undo: () => {} });
    bus.dispatch('plain', null);
    expect(h.getState().canUndo).toBe(true);
    expect(h.undo()?.action).toBe('plain');
  });

  it('unregistering the handler drops its check', () => {
    const bus = createCommandBus();
    const h = history({ bus });
    const off = bus.register('inc', () => 1, { undo: () => {}, canUndo: () => false });
    bus.dispatch('inc', null);
    expect(h.getState().canUndo).toBe(false);
    off();
    expect(h.getState().canUndo).toBe(true);
  });

  it('on the async bus too', async () => {
    const bus = createAsyncCommandBus();
    const h = history({ bus });
    bus.register('inc', async () => 1, { undo: () => {}, canUndo: () => false });
    await bus.dispatch('inc', null);
    expect(h.getState().canUndo).toBe(false);
    expect(h.undo()).toBeUndefined();
  });

  it("useCommandHistory's canUndo signal follows an unrecorded change", () => {
    const bus = createCommandBus();
    setCommandBus(bus);
    const c = counter(bus);
    const hist = useCommandHistory({ actionFilter: (a) => a !== 'bump' });
    bus.dispatch('inc', null);
    expect(hist.canUndo.value).toBe(true);
    bus.dispatch('bump', null);
    expect(hist.canUndo.value).toBe(false);
    expect(hist.undo()).toBeUndefined();
    expect(c.read()).toBe(11);
    hist.dispose();
  });
});

describe('a rollback does not read canUndo', () => {
  /** An action whose canUndo is always false, and one that always fails. */
  function wired(bus: ReturnType<typeof createCommandBus>) {
    const undone: string[] = [];
    bus.register('inc', () => 1, { undo: () => { undone.push('inc'); }, canUndo: () => false });
    bus.register('fail', () => { throw new Error('boom'); });
    return undone;
  }

  it('a transactional batch reverses the step that ran; history refuses the same step', () => {
    const bus = createCommandBus();
    const h = history({ bus });
    const undone = wired(bus);
    bus.dispatch('inc', null);
    expect(h.undo()).toBeUndefined();
    expect(undone).toEqual([]);
    const r = bus.dispatchBatch([{ action: 'inc', target: null }, { action: 'fail', target: null }], { transactional: true });
    expect(r.ok).toBe(false);
    expect(undone).toEqual(['inc']);
  });

  it('an optimistic action reverses the step that failed, whatever canUndo says', () => {
    const bus = createCommandBus();
    const undone: string[] = [];
    bus.register('save', () => { throw new Error('boom'); }, { undo: () => { undone.push('save'); }, canUndo: () => false, optimistic: true });
    expect(bus.dispatch('save', null).ok).toBe(false);
    expect(undone).toEqual(['save']);
  });
});
