/**
 * commandKey - two different commands never share a key.
 *
 * The key backs idempotent, cache, serialize and supersede (and isLoading's
 * slots), so a collision collapses two commands into one: the second never
 * runs and gets the first one's answer. Two collisions remained after the
 * `__proto__` one (prototype-keys.test.ts), each merging different values:
 *   - every circular target: JSON.stringify threw and the fallback was
 *     String(target), '[object Object]' for all of them;
 *   - every target holding a BigInt, the same way.
 * A target still keys by its value - a primitive by its String(), so 1 and '1'
 * share a key by design (isloading-keys.test.ts) - and ordinary keys read as
 * before ('act:plain', 'act:{"a":1}').
 *
 * An action name holding ':' can still share a key with another action
 * (('a:b', 'c') and ('a', 'b:c')): escaping it per call measured 25-30% of a
 * key (V8-RULES rule 3), so it is a naming rule, warned in development.
 */
import { describe, expect, it, vi } from 'vitest';
import { _targetKey } from '../src/command-bus';
import { commandKey, createAsyncCommandBus, idempotent } from '../src/index';

const circular = (label: string) => { const o: Record<string, unknown> = { label }; o.self = o; return o; };

describe('commandKey - collisions', () => {
  it.each([
    ['two different circular targets', ['act', circular('first')], ['act', circular('second')]],
    ['two targets holding different BigInts', ['act', { n: 1n }], ['act', { n: 2n }]],
    ['a BigInt and its string inside an object', ['act', { n: 1n }], ['act', { n: '1' }]],
  ] as Array<[string, [string, unknown], [string, unknown]]>)('keeps %s apart', (_label, [a1, t1], [a2, t2]) => {
    expect(commandKey(a1, t1)).not.toBe(commandKey(a2, t2));
  });

  it("warns once in development about an action holding ':'", () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    commandKey('cart:add', 1);
    commandKey('cart:add', 2);
    commandKey('cartAdd', 3);
    // A library command derived from it (`$undo`) is the library's name: no warning.
    commandKey('cart:remove$undo', 4);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('cart:add');
    warn.mockRestore();
  });

  it('keeps the by-design equivalences: a target keys by its String()', () => {
    expect(commandKey('act', 1)).toBe(commandKey('act', '1'));
    expect(commandKey('act', null)).toBe(commandKey('act', 'null'));
    expect(commandKey('act', 5n)).toBe(commandKey('act', 5));
    expect(commandKey('act', { a: 1 })).toBe(commandKey('act', '{"a":1}'));
  });

  it('keeps ordinary keys readable and stable', () => {
    expect(commandKey('act', 'plain')).toBe('act:plain');
    expect(commandKey('act', null)).toBe('act:null');
    expect(commandKey('act', 7)).toBe('act:7');
    expect(commandKey('act', { b: 2, a: 1 })).toBe('act:{"a":1,"b":2}');
  });

  it('is stable for the same circular or BigInt target', () => {
    const o = circular('x');
    expect(commandKey('act', o)).toBe(commandKey('act', o));
    expect(commandKey('act', { n: 5n, m: [1n] })).toBe(commandKey('act', { m: [1n], n: 5n }));
  });

  it('keeps _targetKey the target half of commandKey', () => {
    for (const t of ['plain', '1', 'b:c', 'null', '"q"', 1, true, null, undefined, { a: 1 }, [1, '2'], circular('c'), { n: 3n }, 4n]) {
      expect('act:' + _targetKey(t)).toBe(commandKey('act', t));
    }
  });

  it('idempotent no longer collapses them', async () => {
    const bus = createAsyncCommandBus({ retry: false });
    bus.use(idempotent({ actions: ['*'] }), { priority: 100 });
    const ran: string[] = [];
    const c1 = circular('first');
    const c2 = circular('second');
    bus.register('obj', async (cmd) => { ran.push(`obj/${cmd.target.label}`); return 3; });
    await bus.dispatch('obj', c1);
    await bus.dispatch('obj', c2);
    await bus.dispatch('obj', { label: 'big1', n: 1n });
    await bus.dispatch('obj', { label: 'big2', n: 2n });
    expect(ran).toEqual(['obj/first', 'obj/second', 'obj/big1', 'obj/big2']);
  });
});
