/** authGuard's `protected` takes the library's pattern form too: `'admin*'` and `'*'` protect what they say (plan 1.27 section 10.2). Rationale at the end. */
import { describe, expect, it } from 'vitest';
import { createCommandBus } from '../src/command-bus';
import { authGuard } from '../src/plugins-core';

/** A bus whose user is signed out, guarded by `list`; returns whether `action` ran. */
function ran(list: string[], action: string): boolean {
  const bus = createCommandBus();
  bus.register(action, () => 'ran');
  bus.use(authGuard({ isAuthenticated: () => false, protected: list }));
  return bus.dispatch(action, {}).ok;
}

describe('authGuard protected patterns', () => {
  it("'admin*' protects every action that starts with admin", () => {
    expect(ran(['admin*'], 'adminDelete')).toBe(false);
    expect(ran(['admin*'], 'admin')).toBe(false);
  });

  it("'*' protects every action", () => {
    expect(ran(['*'], 'cartAdd')).toBe(false);
  });

  it("control: 'admin' is a prefix, as released", () => {
    expect(ran(['admin'], 'adminDelete')).toBe(false);
    expect(ran(['admin'], 'admin')).toBe(false);
  });

  it('control: an action outside the list runs', () => {
    expect(ran(['admin*'], 'cartAdd')).toBe(true);
    expect(ran(['admin'], 'cartAdd')).toBe(true);
  });

  it('control: signed in, a protected action runs', () => {
    const bus = createCommandBus();
    bus.register('adminDelete', () => 'ran');
    bus.use(authGuard({ isAuthenticated: () => true, protected: ['admin*'] }));
    expect(bus.dispatch('adminDelete', {}).ok).toBe(true);
  });
});

/*
 * Every other action list in the library takes patterns (`matchesPattern`:
 * an exact name, `prefix*`, `*`), and `authGuard`'s `protected` compared
 * each entry as a raw prefix, so `'admin*'` matched only names holding a
 * literal `*` and protected nothing, with no warning (audit B4, N2). The
 * list is compiled once in the factory: a trailing `*` is dropped, so
 * `'admin*'` is the prefix `admin` and `'*'` the empty prefix, every
 * action. A list without `*` behaves as released. Log s35.165.
 */
