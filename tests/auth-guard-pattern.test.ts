/** authGuard's `protected` reads patterns as every list in the library does: a name is that action, `'admin*'` a prefix, `'*'` every action. Rationale at the end. */
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

/*
 * Every action list in the library takes patterns (`matchesPattern`, one
 * classifier, tests/pattern-classifier.test.ts): an exact name, `prefix*`,
 * `*`. `protected` once compared each entry as a raw prefix, so `'admin*'`
 * matched only names holding a literal `*` (audit B4, N2, log s35.165), and
 * then read a bare name as a prefix while every other list read it as one
 * action. Plan 1.32 step 8 (log 36.104, owner 2026-10-21): one meaning
 * everywhere, so `'admin'` guards that action alone and `'admin*'` the prefix.
 */
