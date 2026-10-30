/**
 * `ok`, `err` and `countOption` exported from the root.
 * Why: a plugin that hand-builds `{ ok: false, error }` has a different hidden class from the bus's result, so every `result.ok` site that sees both goes polymorphic; a hand-written `| 0` or `x > max` count gate fails open on NaN.
 * Shows: `ok` and `err` are the bus's own factories (identity) and build the same result map as a dispatch, `err(fail(...))` carries the plugin's own id, and `countOption` is the library's own function with the default, clamp and truncate rules.
 * See: log s35.74, tests/v8-shapes.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { _errResult, _okResult, createCommandBus, type CommandResult } from '../src/command-bus';
import { countOption as internalCountOption } from '../src/bounds';
import * as root from '../src/index';
import { sameMap } from './v8';

function busResult(): CommandResult {
  const bus = createCommandBus();
  bus.register('t', () => 1);
  return bus.dispatch('t', 1);
}

describe('ok / err from the root', () => {
  it('are the bus\'s own result factories, not copies', () => {
    expect((root as Record<string, unknown>).ok).toBe(_okResult);
    expect((root as Record<string, unknown>).err).toBe(_errResult);
  });

  it('build the bus\'s one result map, ok and error alike', () => {
    const ref = busResult();
    expect(sameMap(ref, root.ok(1))).toBe(true);
    expect(sameMap(ref, root.err(new Error('x')))).toBe(true);
  });

  it('an app rule refuses with err(fail(...)): its own owner, the bus\'s map', () => {
    const bus = createCommandBus();
    bus.register('cartAdd', () => 1);
    bus.use({ id: 'qtyGuard', validate: () => (cmd, fail: root.Fail) =>
      ((cmd.payload as { qty?: number } | undefined)?.qty ?? 0) > 0 ? undefined : root.err(fail('invalid:payload', 'qty must be positive')) });
    const r = bus.dispatch('cartAdd', {}, { qty: 0 });
    expect(r.ok).toBe(false);
    expect((r.error as root.BusError).code).toBe('qtyGuard:invalid:payload');
    expect(sameMap(busResult(), r)).toBe(true);
    expect(bus.dispatch('cartAdd', {}, { qty: 1 })).toEqual(root.ok(1));
  });
});

describe('countOption from the root', () => {
  it('is the library\'s own rule', () => {
    expect((root as Record<string, unknown>).countOption).toBe(internalCountOption);
  });

  it('a bad count falls back to the default; the rest clamp and truncate', () => {
    expect(root.countOption(Number.NaN, 200)).toBe(200);
    expect(root.countOption('x', 200)).toBe(200);
    expect(root.countOption(-5, 200)).toBe(0);
    expect(root.countOption(2.7, 200)).toBe(2);
    expect(root.countOption(Number.POSITIVE_INFINITY, 200)).toBe(Number.POSITIVE_INFINITY);
    expect(root.countOption(0, 3, 1)).toBe(1);
  });
});
