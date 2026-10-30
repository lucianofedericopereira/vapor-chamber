/**
 * authGuard's `protected` reads patterns as every list in the library does: a name is that action, `'admin*'` a prefix, `'*'` every action.
 * Why: one pattern meaning everywhere (`matchesPattern`); a guard that reads a list differently protects the wrong actions.
 * Shows: a prefix, `*` and an exact name each protect what they say, anything else runs, [] protects nothing, a signed-in user passes.
 * See: audit B4, audit N2, log s35.165, log 36.104, tests/pattern-classifier.test.ts.
 */
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

  it("'admin' protects that action only", () => {
    expect(ran(['admin'], 'admin')).toBe(false);
    expect(ran(['admin'], 'adminDelete')).toBe(true);
  });

  it('control: an action outside the list runs, and [] protects nothing', () => {
    expect(ran(['admin*'], 'cartAdd')).toBe(true);
    expect(ran(['admin'], 'cartAdd')).toBe(true);
    expect(ran([], 'cartAdd')).toBe(true);
  });

  it('control: signed in, a protected action runs', () => {
    const bus = createCommandBus();
    bus.register('adminDelete', () => 'ran');
    bus.use(authGuard({ isAuthenticated: () => true, protected: ['admin*'] }));
    expect(bus.dispatch('adminDelete', {}).ok).toBe(true);
  });
});
