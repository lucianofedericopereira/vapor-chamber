/**
 * commandKey: two different commands never share a key.
 * Why: the key backs idempotent, cache, serialize, supersede and isLoading; a collision collapses two commands, so the second never runs and gets the first's answer.
 * Shows: circular, BigInt, non-finite, function, symbol and wrapper targets keep apart; 1 and '1' share a key by design; ordinary keys stay readable; idempotent runs both.
 * See: tests/prototype-keys.test.ts, tests/isloading-keys.test.ts, docs/V8-RULES.md rule 3, log 36.41.
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
    // JSON.stringify writes null for NaN and Infinity (RFC 8785 refuses them).
    ['NaN and null inside an object', ['act', { n: NaN }], ['act', { n: null }]],
    ['Infinity and null inside an object', ['act', { n: Infinity }], ['act', { n: null }]],
    ['Infinity and -Infinity inside an object', ['act', { n: Infinity }], ['act', { n: -Infinity }]],
    ['NaN and Infinity inside an array', ['act', [NaN]], ['act', [Infinity]]],
    // JSON has no text for a function or a symbol at the top: each keyed as undefined.
    ['a function and an undefined target', ['act', () => 1], ['act', undefined]],
    ['two different functions', ['act', () => 1], ['act', () => 2]],
    ['a symbol and an undefined target', ['act', Symbol('s')], ['act', undefined]],
    ['two symbols with one description', ['act', Symbol('s')], ['act', Symbol('s')]],
    ['a registered and an unregistered symbol', ['act', Symbol.for('s')], ['act', Symbol('s')]],
    ['an object whose toJSON gives undefined and an undefined target', ['act', { toJSON: () => undefined }], ['act', undefined]],
    // JSON unwraps a Number, String, Boolean or BigInt object after the replacer ran.
    ['two Number objects', ['act', { x: new Number(5) }], ['act', { x: new Number(6) }]],
    ['two Boolean objects', ['act', { x: new Boolean(true) }], ['act', { x: new Boolean(false) }]],
    ['two BigInt objects', ['act', { x: Object(1n) }], ['act', { x: Object(2n) }]],
    ['a String object and an index-keyed object', ['act', { x: new String('ab') }], ['act', { x: { 0: 'a', 1: 'b' } }]],
    ['a NaN Number object and null', ['act', { x: new Number(NaN) }], ['act', { x: null }]],
  ] as Array<[string, [string, unknown], [string, unknown]]>)('keeps %s apart', (_label, [a1, t1], [a2, t2]) => {
    expect(commandKey(a1, t1)).not.toBe(commandKey(a2, t2));
  });

  it('keys a Number, String, Boolean or BigInt object as its value, as JSON.stringify does', () => {
    expect(commandKey('act', { x: new Number(5) })).toBe('act:{"x":5}');
    expect(commandKey('act', { x: new String('a') })).toBe(commandKey('act', { x: 'a' }));
    expect(commandKey('act', { x: new Boolean(false) })).toBe(commandKey('act', { x: false }));
    expect(commandKey('act', { x: Object(5n) })).toBe(commandKey('act', { x: 5n }));
    expect(commandKey('act', { x: new Number(NaN) })).toBe(commandKey('act', { x: NaN }));
    // A wrapper as the whole target, and inside an array.
    expect(commandKey('act', new Number(5))).toBe('act:5');
    expect(commandKey('act', [new String('a')])).toBe('act:["a"]');
  });

  // Known limit: only an object with no keys, or keys from '0', is checked for a wrapper (cost per key).
  // Passes while the limit holds, turns red if it is lifted.
  it.fails('known limit: a Number object with fields of its own keys by its fields', () => {
    expect(commandKey('act', { x: Object.assign(new Number(5), { a: 1 }) })).not.toBe(commandKey('act', { x: Object.assign(new Number(6), { a: 1 }) }));
  });

  // An action holding ':' can share a key with another; escaping it per call costs too much, so it is a naming rule.
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
    // The same non-finite target twice is the same command, so it keeps one key.
    expect(commandKey('act', { n: NaN, m: [Infinity] })).toBe(commandKey('act', { m: [Infinity], n: NaN }));
  });

  it('is stable for the same function or symbol target', () => {
    const f = () => 1;
    const s = Symbol('s');
    expect(commandKey('act', f)).toBe(commandKey('act', f));
    expect(commandKey('act', s)).toBe(commandKey('act', s));
    expect(commandKey('act', Symbol.for('s'))).toBe(commandKey('act', Symbol.for('s')));
  });

  it('keeps _targetKey the target half of commandKey', () => {
    const f = () => 1;
    const s = Symbol('s');
    for (const t of ['plain', '1', 'b:c', 'null', '"q"', 1, true, null, undefined, { a: 1 }, [1, '2'], circular('c'), { n: 3n }, 4n, f, s, { x: new Number(5) }]) {
      expect('act:' + _targetKey(t)).toBe(commandKey('act', t));
    }
  });

  it('idempotent no longer collapses them', async () => {
    const bus = createAsyncCommandBus({ retry: false });
    bus.use(idempotent({ actions: ['*'] }));
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
