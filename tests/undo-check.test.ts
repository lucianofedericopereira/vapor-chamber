/** `register(action, h, { undo, canUndo })`: canUndo says whether undo can run, and undo runs only then. Rationale at the end. */
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
    const h = history({ bus, filter: (cmd) => cmd.action !== 'bump' });
    bus.use(h);
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
    const h = history({ bus, filter: (cmd) => cmd.action !== 'bump' });
    bus.use(h);
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
    bus.use(h);
    bus.register('plain', () => 1, { undo: () => {} });
    bus.dispatch('plain', null);
    expect(h.getState().canUndo).toBe(true);
    expect(h.undo()?.action).toBe('plain');
  });

  it('unregistering the handler drops its check', () => {
    const bus = createCommandBus();
    const h = history({ bus });
    bus.use(h);
    const off = bus.register('inc', () => 1, { undo: () => {}, canUndo: () => false });
    bus.dispatch('inc', null);
    expect(h.getState().canUndo).toBe(false);
    off();
    expect(h.getState().canUndo).toBe(true);
  });

  it('on the async bus too', async () => {
    const bus = createAsyncCommandBus();
    const h = history({ bus });
    bus.use(h);
    bus.register('inc', async () => 1, { undo: () => {}, canUndo: () => false });
    await bus.dispatch('inc', null);
    expect(h.getState().canUndo).toBe(false);
    expect(h.undo()).toBeUndefined();
  });

  it("useCommandHistory's canUndo signal follows an unrecorded change", () => {
    const bus = createCommandBus();
    setCommandBus(bus);
    const c = counter(bus);
    const hist = useCommandHistory({ filter: (cmd) => cmd.action !== 'bump' });
    bus.dispatch('inc', null);
    expect(hist.canUndo.value).toBe(true);
    bus.dispatch('bump', null);
    expect(hist.canUndo.value).toBe(false);
    expect(hist.undo()).toBeUndefined();
    expect(c.read()).toBe(11);
    hist.dispose();
  });
});

/*
 * Owner, 2026-10-04: undo runs only when it can be undone. Log s35.113.
 */
