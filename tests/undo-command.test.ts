/** Every undo is a command, `<action>$undo`: from history, and the rollbacks after a failure. Log s35.114. */
import { describe, expect } from 'vitest';
import { type Command, createAsyncCommandBus, createCommandBus } from '../src/command-bus';
import { history } from '../src/plugins-core';
import { it } from '../src/vitest';

function setup() {
  const bus = createCommandBus();
  const h = history({ bus });
  const inverseGot: Command[] = [];
  bus.register('add', () => 1, { undo: (cmd) => { inverseGot.push(cmd); } });
  const heard: string[] = [];
  bus.on('*', (cmd) => heard.push(`${cmd.action}:${cmd.meta?.origin ?? '-'}`));
  return { bus, h, inverseGot, heard };
}

describe('undo is a command', () => {
  it('history dispatches <action>$undo, caused by the command; the inverse gets that command', () => {
    const { bus, h, inverseGot, heard } = setup();
    let causation: unknown;
    bus.on('add$undo', (cmd) => { causation = cmd.meta?.causationId; });
    bus.dispatch('add', 5);
    const recorded = h.getState().past[0];
    h.undo();
    expect(heard).toEqual(['add:-', 'add$undo:undo']);
    expect(inverseGot).toEqual([recorded]);
    expect(inverseGot[0]).toBe(recorded);
    expect(causation).toBe(recorded.meta?.id);
    expect(h.getState().past).toEqual([]);
  });

  it('a rule can refuse it: the inverse does not run and the step stays', () => {
    const { bus, h, inverseGot } = setup();
    bus.use({ authorize: () => (cmd) => (cmd.action === 'add$undo' ? { ok: false, value: undefined, error: new Error('not now') } : undefined) });
    bus.dispatch('add', 5);
    h.undo();
    expect(inverseGot).toEqual([]);
    expect(h.getState().past.map((c) => c.action)).toEqual(['add']);
  });

  it('unregistering the action removes its $undo', () => {
    const bus = createCommandBus();
    const off = bus.register('add', () => 1, { undo: () => {} });
    expect(bus.hasHandler('add$undo')).toBe(true);
    off();
    expect(bus.hasHandler('add$undo')).toBe(false);
  });

  it('an action without undo has no $undo, and history pops its record as before', () => {
    const bus = createCommandBus();
    const h = history({ bus });
    bus.register('plain', () => 1);
    bus.dispatch('plain', null);
    expect(bus.hasHandler('plain$undo')).toBe(false);
    expect(h.undo()?.action).toBe('plain');
    expect(h.getState().past).toEqual([]);
  });

  it('on the async bus', async () => {
    const bus = createAsyncCommandBus();
    const h = history({ bus });
    const got: unknown[] = [];
    bus.register('add', async () => 1, { undo: (cmd) => { got.push(cmd.target); } });
    const heard: string[] = [];
    bus.on('add$undo', (cmd) => heard.push(String(cmd.meta?.origin)));
    await bus.dispatch('add', 5);
    h.undo();
    await new Promise((r) => setTimeout(r, 0));
    expect(got).toEqual([5]);
    expect(heard).toEqual(['undo']);
  });
});

describe('a rollback after a failure is the same command', () => {
  it('an optimistic action dispatches <action>$undo', () => {
    const bus = createCommandBus();
    const got: unknown[] = [];
    bus.register('save', () => { throw new Error('down'); }, { undo: (cmd) => { got.push(cmd.target); }, optimistic: true });
    const heard: string[] = [];
    bus.on('save$undo', (cmd) => heard.push(cmd.action));
    bus.dispatch('save', 1);
    expect(got).toEqual([1]);
    expect(heard).toEqual(['save$undo']);
  });

  it('on the async bus, done settles once the rollback has run', async () => {
    const bus = createAsyncCommandBus({ retry: false });
    const order: string[] = [];
    bus.register('save', async () => { throw new Error('down'); }, { undo: () => { order.push('undo'); }, optimistic: true });
    bus.use({ validate: () => async () => { await Promise.resolve(); return undefined; } }); // the rollback's dispatch then takes a tick
    const r = await bus.dispatch('save', 1);
    await (r.value as { done: Promise<unknown> }).done;
    order.push('done');
    expect(order).toEqual(['undo', 'done']);
  });

  it('a transactional batch dispatches <action>$undo, and reports its result', () => {
    const bus = createCommandBus();
    const got: unknown[] = [];
    bus.register('a', () => 1, { undo: (cmd) => { got.push(cmd.target); } });
    bus.register('b', () => { throw new Error('down'); });
    const heard: string[] = [];
    bus.on('a$undo', (cmd) => heard.push(cmd.action));
    const result = bus.dispatchBatch([{ action: 'a', target: 1 }, { action: 'b', target: 2 }], { transactional: true });
    expect(got).toEqual([1]);
    expect(heard).toEqual(['a$undo']);
    expect(result.rollbacks?.map((r) => r.ok)).toEqual([true]);
  });
});
