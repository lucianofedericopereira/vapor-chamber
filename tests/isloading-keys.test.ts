/**
 * isLoading's key equality: which action and target pairs share a flag and which do not.
 * Why: the target part of a key must match commandKey (String(target) for a primitive, canonical JSON for an object), and the action and target must stay separate parts, or one command would light another's flag.
 * Shows: 1 and '1', null and 'null', undefined, booleans, and key-order-insensitive objects share a flag with their string form, while (a:b, c) and (a, b:c) do not light each other; each flag is dark again after the dispatch.
 * See: log s35.60.
 */
import { describe, expect, it } from 'vitest';
import { useSharedCommandState } from '../src/chamber';
import { createCommandBus } from '../src/command-bus';

/** Dispatch `action, target` and report which of `reads` were lit while it ran. */
function litDuring(action: string, target: unknown, reads: Array<[string, unknown]>): boolean[] {
  const bus = createCommandBus();
  const s = useSharedCommandState({ bus });
  const flags = reads.map(([a, t]) => s.pending(a, t));
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
