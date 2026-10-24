/** History's steps are state: its stacks are handed out with no copy, the same array until a change, readonly in the type. Rationale at the end. */
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

// Rationale.
// Plan 1.32 4.2: history's steps are store state. The 1-7 fix-up (audit M1,
// coordinator 2026-10-21) puts the ledger's two stacks on a state half of their
// own. Each change writes both as new arrays, so getState() and
// useCommandHistory hand them out with no copy (before: a copy per read and
// per change). They are `readonly` in the type, a build-time check: a
// development freeze would run per recorded dispatch (coordinator order
// 2026-10-21, step 8 e75a2c4 did the same for the command).
