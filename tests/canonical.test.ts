/**
 * canonical() - RFC 8785 (JCS) against the RFC's own examples; keyTextFor, the runtime key.
 *
 * The cases are the RFC's: the 3.2.2 sample and its 3.2.3 output, the 3.2.4
 * UTF-8 bytes, the 3.2.3 sorting data, and Appendix B's number table, each
 * IEEE 754 value built from its hex. The refusals are 3.2.2.2 (lone
 * surrogates) and 3.2.2.3 (NaN, Infinity). keyTextFor writes the runtime key text: it
 * lists integer-like keys first and writes a lone surrogate escaped (src/canonical.ts).
 * Characters beyond ASCII are built from their code units (ASCII-only files).
 */
import { describe, expect, it } from 'vitest';
import { canonical, keyTextFor } from '../src/canonical';

const ch = (...units: number[]): string => String.fromCharCode(...units);
const U = '\\' + 'u'; // a JSON \u escape, written out as text
const EURO = ch(0x20ac);
const GRIN = ch(0xd83d, 0xde00);

const fromHex = (hex: string): number => {
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, BigInt(`0x${hex}`));
  return view.getFloat64(0);
};

// RFC 8785 3.2.2, parsed as JSON so the number literals round as the RFC says.
const SAMPLE_STRING = U + '20ac$' + U + '000F' + U + "000aA'" + U + '0042' + U + '0022' + U + '005c' + '\\\\' + '\\"' + '\\/';
const SAMPLE = JSON.parse(`{
  "numbers": [333333333.33333329, 1E30, 4.50, 2e-3, 0.000000000000000000000000001],
  "string": "${SAMPLE_STRING}",
  "literals": [null, true, false]
}`);
// RFC 8785 3.2.3, the canonical text of the sample.
const SAMPLE_OUT = '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"'
  + EURO + '$' + U + '000f' + '\\n' + "A'B" + '\\"' + '\\\\\\\\' + '\\"' + '/"}';
// RFC 8785 3.2.4, the same text as UTF-8 bytes.
const SAMPLE_UTF8 = `7b 22 6c 69 74 65 72 61 6c 73 22 3a 5b 6e 75 6c 6c 2c 74 72
  75 65 2c 66 61 6c 73 65 5d 2c 22 6e 75 6d 62 65 72 73 22 3a
  5b 33 33 33 33 33 33 33 33 33 2e 33 33 33 33 33 33 33 2c 31
  65 2b 33 30 2c 34 2e 35 2c 30 2e 30 30 32 2c 31 65 2d 32 37
  5d 2c 22 73 74 72 69 6e 67 22 3a 22 e2 82 ac 24 5c 75 30 30
  30 66 5c 6e 41 27 42 5c 22 5c 5c 5c 5c 5c 22 2f 22 7d`.split(/\s+/).join(' ');

describe('canonical - RFC 8785 examples', () => {
  it('3.2.2 / 3.2.3: the sample canonicalizes to the RFC output', () => {
    expect(canonical(SAMPLE)).toBe(SAMPLE_OUT);
  });

  it('3.2.4: the output is the RFC bytes in UTF-8', () => {
    const bytes = [...new TextEncoder().encode(canonical(SAMPLE))].map((b) => b.toString(16).padStart(2, '0')).join(' ');
    expect(bytes).toBe(SAMPLE_UTF8);
  });

  it('3.2.3: properties sort by UTF-16 code units, recursively', () => {
    const data = {
      [EURO]: 'Euro Sign',
      '\r': 'Carriage Return',
      [ch(0xfb33)]: 'Hebrew Letter Dalet With Dagesh',
      1: 'One',
      [GRIN]: 'Emoji: Grinning Face',
      [ch(0x80)]: 'Control',
      [ch(0xf6)]: 'Latin Small Letter O With Diaeresis',
    };
    // The RFC's expected order, written out pair by pair (JSON.parse would
    // move "1" first again: an object lists integer-like keys first).
    const order: Array<[string, string]> = [
      ['\r', 'Carriage Return'], ['1', 'One'], [ch(0x80), 'Control'],
      [ch(0xf6), 'Latin Small Letter O With Diaeresis'], [EURO, 'Euro Sign'],
      [GRIN, 'Emoji: Grinning Face'], [ch(0xfb33), 'Hebrew Letter Dalet With Dagesh'],
    ];
    expect(canonical(data)).toBe('{' + order.map(([k, v]) => JSON.stringify(k) + ':' + JSON.stringify(v)).join(',') + '}');
    // Inside arrays too, while the array keeps its order.
    expect(canonical([{ b: 1, a: { d: 1, c: 2 } }, 2])).toBe('[{"a":{"c":2,"d":1},"b":1},2]');
  });

  it('sorts integer-like keys as strings, not in the order an object lists them', () => {
    expect(canonical({ 9: 'b', 10: 'a', x: 1 })).toBe('{"10":"a","9":"b","x":1}');
  });

  it('leaves out what JSON has no text for, as JSON.stringify does', () => {
    expect(canonical({ a: undefined, f: () => 1, s: Symbol('s'), b: [undefined, () => 1] })).toBe('{"b":[null,null]}');
  });

  it.each([
    ['0000000000000000', '0'], ['8000000000000000', '0'], ['0000000000000001', '5e-324'],
    ['8000000000000001', '-5e-324'], ['7fefffffffffffff', '1.7976931348623157e+308'],
    ['ffefffffffffffff', '-1.7976931348623157e+308'], ['4340000000000000', '9007199254740992'],
    ['c340000000000000', '-9007199254740992'], ['4430000000000000', '295147905179352830000'],
    ['44b52d02c7e14af5', '9.999999999999997e+22'], ['44b52d02c7e14af6', '1e+23'],
    ['44b52d02c7e14af7', '1.0000000000000001e+23'], ['444b1ae4d6e2ef4e', '999999999999999700000'],
    ['444b1ae4d6e2ef4f', '999999999999999900000'], ['444b1ae4d6e2ef50', '1e+21'],
    ['3eb0c6f7a0b5ed8c', '9.999999999999997e-7'], ['3eb0c6f7a0b5ed8d', '0.000001'],
    ['41b3de4355555553', '333333333.3333332'], ['41b3de4355555554', '333333333.33333325'],
    ['41b3de4355555555', '333333333.3333333'], ['41b3de4355555556', '333333333.3333334'],
    ['41b3de4355555557', '333333333.33333343'], ['becbf647612f3696', '-0.0000033333333333333333'],
    ['43143ff3c1cb0959', '1424953923781206.2'],
  ])('Appendix B: %s serializes as %s', (hex, out) => {
    expect(canonical([fromHex(hex)])).toBe(`[${out}]`);
  });

  it('no whitespace, literals as is', () => {
    expect(canonical({ a: [null, true, false], b: 'x y' })).toBe('{"a":[null,true,false],"b":"x y"}');
  });

  it('control: one changed value changes the output', () => {
    expect(canonical({ a: 1, b: [1, 2] })).not.toBe(canonical({ a: 1, b: [2, 1] }));
    expect(canonical({ a: 1 })).not.toBe(canonical({ a: 2 }));
  });
});

describe('canonical - what the RFC refuses', () => {
  const cycle = (() => { const o: Record<string, unknown> = {}; o.self = o; return o; })();

  it.each([
    ['NaN (3.2.2.3)', { n: NaN }],
    ['Infinity (3.2.2.3)', { n: Infinity }],
    ['-Infinity (3.2.2.3)', [-Infinity]],
    ['a BigInt, not an I-JSON number', { n: 1n }],
    ['a cycle', cycle],
    ['a lone high surrogate in a value (3.2.2.2)', { s: 'a' + ch(0xd800) }],
    ['a lone low surrogate in a value (3.2.2.2)', [ch(0xdead)]],
    ['a lone surrogate in a property name (3.2.2.2)', { [ch(0xdc00) + 'x']: 1 }],
    ['a low surrogate before its high one (3.2.2.2)', ch(0xde00, 0xd83d)],
  ])('throws on %s', (_label, value) => {
    expect(() => canonical(value)).toThrow();
  });

  it('control: a well-formed pair, and the escape typed as text, pass', () => {
    expect(canonical({ e: GRIN })).toBe('{"e":"' + GRIN + '"}');
    // The six characters backslash-u-d-8-0-0 typed as text: an escaped backslash, not a surrogate.
    expect(canonical({ t: '\\' + 'ud800' })).toBe(`{"t":"\\\\ud800"}`);
    expect(canonical({ t: '\\\\' + U + 'x' })).toBe(`{"t":"\\\\\\\\\\\\ux"}`);
  });

  it('an own __proto__ key is kept as data, as JSON.parse produces it', () => {
    expect(canonical(JSON.parse('{"__proto__":"A","id":1}'))).toBe('{"__proto__":"A","id":1}');
  });

  it('honours toJSON, then sorts its result', () => {
    expect(canonical({ when: new Date(0), x: { toJSON: () => ({ b: 1, a: 2 }) } })).toBe('{"when":"1970-01-01T00:00:00.000Z","x":{"a":2,"b":1}}');
  });

  it('unwraps a Number, String or Boolean object, as JSON.stringify does', () => {
    expect(canonical({ n: new Number(5), s: new String('a'), b: new Boolean(false) })).toBe('{"b":false,"n":5,"s":"a"}');
    expect(canonical(new Number(5))).toBe('5');
  });

  it.each([
    ['a BigInt object', { n: Object(1n) }],
    ['a NaN Number object (3.2.2.3)', { n: new Number(NaN) }],
  ])('throws on %s, as on its value', (_label, value) => {
    expect(() => canonical(value)).toThrow();
  });
});

describe('keyTextFor - one runtime key text per value, not RFC 8785', () => {
  const NUL = ch(0);
  const keyText = keyTextFor((v: number | bigint) => ({ [NUL]: String(v) }));
  const esc = U + '0000';

  it('sorts keys at every level and keeps arrays in order', () => {
    expect(keyText({ b: [{ d: 1, c: 2 }], a: 1 })).toBe('{"a":1,"b":[{"c":2,"d":1}]}');
    expect(keyText({ b: 2, a: 1 })).toBe(keyText({ a: 1, b: 2 }));
  });

  it('writes a NaN, an Infinity and a BigInt as what outside returns', () => {
    expect(keyText({ n: NaN, i: -Infinity, b: 2n }))
      .toBe(`{"b":{"${esc}":"2"},"i":{"${esc}":"-Infinity"},"n":{"${esc}":"NaN"}}`);
  });

  it('control: an ordinary number never reaches outside', () => {
    let calls = 0;
    keyTextFor((v) => { calls++; return String(v); })({ n: 1, m: [0, -0, 1.5] });
    expect(calls).toBe(0);
  });

  it('lists integer-like keys first, as an object does, where canonical sorts them as strings', () => {
    expect(keyText({ 9: 'b', 10: 'a', x: 1 })).toBe('{"9":"b","10":"a","x":1}');
    expect(canonical({ 9: 'b', 10: 'a', x: 1 })).toBe('{"10":"a","9":"b","x":1}');
  });

  it('writes a lone surrogate escaped, as JSON.stringify does, so a key stays distinct', () => {
    expect(keyText({ s: ch(0xd800) })).toBe(`{"s":"${U}d800"}`);
  });

  it('keeps an own __proto__ key as data', () => {
    expect(keyText(JSON.parse('{"__proto__":"A","id":1}'))).toBe('{"__proto__":"A","id":1}');
  });

  it('writes a Number, String, Boolean or BigInt object as its value', () => {
    expect(keyText({ n: new Number(5), s: new String('a'), b: new Boolean(false) })).toBe('{"b":false,"n":5,"s":"a"}');
    expect(keyText({ n: new Number(NaN), g: Object(2n) })).toBe(`{"g":{"${esc}":"2"},"n":{"${esc}":"NaN"}}`);
  });
});
