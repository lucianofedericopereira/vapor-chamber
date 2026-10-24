/** One scope for every plugin and recorder: `actions` and `actionFilter`, read in one place, asked once per action. The long note is at the end. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCommandBus, _scoped } from '../src/command-bus';
import { matchesPattern } from '../src/pattern';
import { getCommandBus, resetCommandBus, setCommandBus } from '../src/shared-bus';
import { history, logger } from '../src/plugins-core';
import { createActionFilter } from '../src/action-filter';
import { useCommandError, useCommandHistory } from '../src/chamber';

afterEach(() => { vi.restoreAllMocks(); resetCommandBus(); });

/** A bus with a cart action, a user action and a failing one of each. */
function world() {
  const bus = createCommandBus();
  setCommandBus(bus);
  bus.register('cartAdd', () => 1);
  bus.register('userLogin', () => 1);
  bus.register('cartFail', () => { throw new Error('cart'); });
  bus.register('userFail', () => { throw new Error('user'); });
  return bus;
}
const groups = () => {
  const spy = vi.spyOn(console, 'groupCollapsed').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'groupEnd').mockImplementation(() => {});
  return (action: string) => spy.mock.calls.filter((c) => String(c[0]).includes(action)).length;
};

describe('logger', () => {
  it('actions logs only the actions it names', () => {
    const logged = groups();
    const bus = world();
    bus.use(logger({ actions: ['cart*'] }));
    bus.dispatch('cartAdd', 1);
    bus.dispatch('userLogin', 1);
    expect([logged('cartAdd'), logged('userLogin')]).toEqual([1, 0]);
  });

  it('actionFilter logs only what the filter selects', () => {
    const logged = groups();
    const bus = world();
    bus.use(logger({ actionFilter: createActionFilter([{ prefix: { action: 'user' } }]) }));
    bus.dispatch('cartAdd', 1);
    bus.dispatch('userLogin', 1);
    expect([logged('cartAdd'), logged('userLogin')]).toEqual([0, 1]);
  });

  it('an empty actions list and no scope log every action (control)', () => {
    const logged = groups();
    const bus = world();
    bus.use(logger({ actions: [] }));
    bus.use(logger());
    bus.dispatch('userLogin', 1);
    expect(logged('userLogin')).toBe(2);
  });

  it('never asks its filter about an action its patterns leave out', () => {
    groups();
    const asked: string[] = [];
    const bus = world();
    bus.use(logger({ actions: ['cart*'], actionFilter: (a) => { asked.push(a); return true; } }));
    bus.dispatch('cartAdd', 1);
    bus.dispatch('userLogin', 1);
    expect(asked).toEqual(['cartAdd']);
  });
});

describe('history', () => {
  it('actions records only the actions it names', () => {
    const bus = world();
    const h = history({ bus, actions: ['cart*'] });
    bus.dispatch('cartAdd', 1);
    bus.dispatch('userLogin', 1);
    expect(h.getState().past.map((c) => c.action)).toEqual(['cartAdd']);
  });

  it('actionFilter records only what the filter selects', () => {
    const bus = world();
    const h = history({ bus, actionFilter: (a) => a !== 'cartAdd' });
    bus.dispatch('cartAdd', 1);
    bus.dispatch('userLogin', 1);
    expect(h.getState().past.map((c) => c.action)).toEqual(['userLogin']);
  });

  it('records every action with no scope (control)', () => {
    const bus = world();
    const h = history({ bus });
    bus.dispatch('cartAdd', 1);
    bus.dispatch('userLogin', 1);
    expect(h.getState().past).toHaveLength(2);
  });

  it('never asks its filter about an action its patterns leave out', () => {
    const asked: string[] = [];
    const bus = world();
    history({ bus, actions: ['cart*'], actionFilter: (a) => { asked.push(a); return true; } });
    bus.dispatch('cartAdd', 1);
    bus.dispatch('userLogin', 1);
    expect(asked).toEqual(['cartAdd']);
  });
});

describe('the patterns of an actions scope', () => {
  it('agree with matchesPattern, whatever the mix of names, prefixes and *', () => {
    const lists = [['cartAdd'], ['cart*'], ['*'], ['cartAdd', 'user*'], ['cart*', 'cartAdd', 'x'], ['car*', 'cart*'], ['cartAdd*']];
    const names = ['cartAdd', 'cartAddMany', 'cart', 'userLogin', 'user', 'x', 'xy', 'other', ''];
    for (const actions of lists) {
      const inside = _scoped({ actions });
      for (const name of names) expect([actions, name, inside?.(name)]).toEqual([actions, name, actions.some((p) => matchesPattern(p, name))]);
    }
  });

  it('stay right across many actions (control: 513 actions)', () => {
    const bus = createCommandBus();
    for (let i = 0; i <= 512; i++) bus.register(`a${i}`, () => 1);
    bus.register('b0', () => 1);
    const h = history({ bus, maxSize: 1000, actions: ['a*'] });
    for (let i = 0; i <= 512; i++) bus.dispatch(`a${i}`, 1);
    bus.dispatch('b0', 1);
    bus.dispatch('a0', 1);
    bus.dispatch('b0', 1);
    expect(h.getState().past.map((c) => c.action).slice(-2)).toEqual(['a512', 'a0']);
    expect(h.getState().past).toHaveLength(514);
  });
});

describe('useCommandHistory', () => {
  it('actions records only the actions it names', () => {
    const bus = world();
    const { past } = useCommandHistory({ actions: ['cart*'] });
    bus.dispatch('cartAdd', 1);
    bus.dispatch('userLogin', 1);
    expect(past.value.map((c) => c.action)).toEqual(['cartAdd']);
  });

  it('actionFilter records only what the filter selects', () => {
    const bus = world();
    const { past } = useCommandHistory({ actionFilter: (a) => a.startsWith('user') });
    bus.dispatch('cartAdd', 1);
    bus.dispatch('userLogin', 1);
    expect(past.value.map((c) => c.action)).toEqual(['userLogin']);
  });
});

describe('useCommandError', () => {
  it('actions captures only the errors of the actions it names', () => {
    const bus = world();
    const { errors } = useCommandError({ actions: ['cart*'] });
    bus.dispatch('cartFail', 1);
    bus.dispatch('userFail', 1);
    expect(errors.value.map((e) => e.cmd.action)).toEqual(['cartFail']);
  });

  it('actionFilter captures only what the filter selects', () => {
    const bus = world();
    const { errors } = useCommandError({ actionFilter: (a) => a === 'userFail' });
    bus.dispatch('cartFail', 1);
    bus.dispatch('userFail', 1);
    expect(errors.value.map((e) => e.cmd.action)).toEqual(['userFail']);
  });

  it('captures every error with no scope (control)', () => {
    const bus = getCommandBus();
    bus.register('cartFail', () => { throw new Error('cart'); });
    bus.register('userFail', () => { throw new Error('user'); });
    const { errors } = useCommandError();
    bus.dispatch('cartFail', 1);
    bus.dispatch('userFail', 1);
    expect(errors.value).toHaveLength(2);
  });
});

/*
 * Plan 1.32 step 7c (.probes/step-7-pickup.md, plan G). Two ways to scope a
 * plugin read as two spellings of one thing: `actions` and `actionFilter` on
 * the parts the bus reads, and a `filter(cmd)` option the plugin called on
 * every command. Every `filter` read only `cmd.action`, so it goes: `logger`,
 * `history`, `useCommandHistory` and `useCommandError` take `actions` (an
 * ActionScope, absent or [] is every action) and `actionFilter` (a predicate
 * of the action name), the same two names `metrics`, `cache` and the others
 * take, read by the one `_scoped`. The patterns are classified once into names
 * and prefixes, so a command costs a few comparisons; an `actionFilter` is a
 * plain predicate of the name and is called as it is (a map lookup per command
 * cost a scoped history record +19.5 ns, measured). That a filter option is gone
 * is pinned by tests/option-types.test-d.ts.
 */
