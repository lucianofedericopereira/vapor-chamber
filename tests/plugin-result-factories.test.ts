// ok / err / countOption from the root: the tools an app plugin needs (decision 12, #15).
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

  it('an app plugin rejects with err(fail(...)): its own owner, the bus\'s map', () => {
    const bus = createCommandBus();
    bus.register('cartAdd', () => 1);
    bus.use(Object.assign((cmd: { payload?: { qty?: number } }, next: () => CommandResult, fail: root.Fail) =>
      (cmd.payload?.qty ?? 0) > 0 ? next() : root.err(fail('invalid:payload', 'qty must be positive')), { id: 'qtyGuard' }));
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

/*
 * Why these three are public. An app plugin that rejects had to hand-build
 * `{ ok: false, error }`: a two-field literal, a different hidden class from
 * the bus's three-field result, so every `result.ok` site that sees both goes
 * polymorphic (tests/v8-shapes.test.ts pins the library's own sites; this pins
 * what an app gets). `ok` / `err` are the same functions the library uses, so
 * identity is the test, then the map. `err` only wraps an error: the owner of
 * a failure is minted by the plugin's bound `fail`, the third argument, so
 * `err(fail(...))` is the one idiom and it carries the plugin's declared id.
 * `countOption` is the rule bounds.ts records: a caller's count is often NaN
 * (a parsed env var, a storage read), and a hand-written `| 0` or `x > max`
 * gate fails open; app plugins with a `maxQueue`-style option meet the same
 * class the library met in cache() and createOutbox().
 */
