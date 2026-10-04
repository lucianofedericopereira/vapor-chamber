/** isLoading's key equality: what shares a flag and what does not. The long note is at the end. */
import { describe, expect, it } from 'vitest';
import { useSharedCommandState } from '../src/chamber';
import { createCommandBus } from '../src/command-bus';

/** Dispatch `action, target` and report which of `reads` were lit while it ran. */
function litDuring(action: string, target: unknown, reads: Array<[string, unknown]>): boolean[] {
  const bus = createCommandBus();
  const s = useSharedCommandState({ bus });
  const flags = reads.map(([a, t]) => s.isLoading(a, t));
  let seen: boolean[] = [];
  bus.register(action, () => { seen = flags.map((f) => f.value); });
  bus.dispatch(action, target);
  const after = flags.map((f) => f.value);
  s.dispose();
  expect(after).toEqual(reads.map(() => false));
  return seen;
}

describe('isLoading keys', () => {
  it('a number target and its string share a flag, as in commandKey', () => {
    expect(litDuring('x', 1, [['x', 1], ['x', '1'], ['x', 2]])).toEqual([true, true, false]);
  });

  it('null, undefined and booleans key by their string, as in commandKey', () => {
    expect(litDuring('x', null, [['x', null], ['x', 'null'], ['x', undefined]])).toEqual([true, true, false]);
    expect(litDuring('x', undefined, [['x', undefined], ['x', 'undefined'], ['x', null]])).toEqual([true, true, false]);
    expect(litDuring('x', true, [['x', true], ['x', 'true'], ['x', false]])).toEqual([true, true, false]);
  });

  it('an object target keys by value, and shares a flag with its canonical JSON string', () => {
    expect(litDuring('x', { b: 2, a: 1 }, [['x', { a: 1, b: 2 }], ['x', '{"a":1,"b":2}'], ['x', { a: 1 }]])).toEqual([true, true, false]);
  });

  it('the action and the target are separate parts: (a:b, c) does not light (a, b:c)', () => {
    expect(litDuring('a', 'b:c', [['a', 'b:c'], ['a:b', 'c']])).toEqual([true, false]);
    expect(litDuring('a:b', 'c', [['a:b', 'c'], ['a', 'b:c']])).toEqual([true, false]);
  });
});

/*
 * perf-1.26 item 4, option a (log s35.60). isLoading's slots were keyed by
 * `commandKey(action, target)`, one string `action:target` built per dispatch.
 * They are now a map by action, then by the target's key, so a dispatch builds
 * no string. The first three tests pin the equalities that must not move:
 * the target part is exactly commandKey's (`String(target)` for a primitive,
 * the canonical JSON for an object), so 1 and '1' still share a flag. The last
 * test is the one change, approved by the owner: joined by ':', the action
 * 'a:b' with target 'c' and the action 'a' with target 'b:c' were one key and
 * lit each other's flag. It failed before the change.
 */
