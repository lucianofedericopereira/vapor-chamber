/**
 * history().getState() stacks: handed out without a copy, replaced by new arrays on each change.
 * Why: a copy per read or in-place mutation of a handed-out stack would make store state unreliable for subscribers; the type is readonly because a runtime freeze would cost a pass per recorded dispatch.
 * Shows: same array identity between reads, new arrays after a dispatch and after an undo with old snapshots unchanged, and a write to past is a type error while the array is not frozen.
 * See: audit M1.
 */
import { describe, expect, it } from 'vitest';
import { createCommandBus } from '../src/command-bus';
import { history } from '../src/plugins-core';

const setup = () => {
  const bus = createCommandBus();
  bus.register('add', (cmd) => cmd.target, { undo: () => {} });
  return { bus, h: history({ bus }) };
};

describe("history's stacks", () => {
  it('getState() hands out the same arrays until a change, then new ones', () => {
    const { bus, h } = setup();
    bus.dispatch('add', 1);
    const a = h.getState();
    const b = h.getState();
    expect(a.past).toBe(b.past);
    expect(a.future).toBe(b.future);
    bus.dispatch('add', 2);
    const c = h.getState();
    expect(c.past).not.toBe(a.past);
    expect(a.past.length).toBe(1);
    expect(c.past.length).toBe(2);
  });

  it('an undo moves the step: both stacks are new arrays, the old ones unchanged', () => {
    const { bus, h } = setup();
    bus.dispatch('add', 1);
    const before = h.getState();
    h.undo();
    const after = h.getState();
    expect([before.past.length, before.future.length]).toEqual([1, 0]);
    expect([after.past.length, after.future.length]).toEqual([0, 1]);
  });

  it('the stacks are readonly in the type: a write is a type error, and nothing freezes them', () => {
    const { bus, h } = setup();
    bus.dispatch('add', 1);
    const { past } = h.getState();
    const write = (): void => {
      // @ts-expect-error a readonly Command[] has no push
      past.push(past[0]);
    };
    expect(typeof write).toBe('function');
    expect(Object.isFrozen(past)).toBe(false);
  });
});
