/**
 * StreamParser on malformed input: structure, string escapes, keywords, numbers, and input that ends inside a number.
 * Why: the parser reads bytes off a network, so broken JSON would be accepted, or rejected for the wrong reason, instead of reported with a specific message. Also the only file reaching the structure, escape, hex, keyword and number error arms, so the 100% floor needs it.
 * Shows: each broken input reports its specific message (not just "an error"); valid whitespace, escapes, hex digits and number shapes report none; an unfinished number at end() is an error with no value, as with JSON.parse.
 * See: log 36.13
 */
import { describe, expect, it } from 'vitest';
import { createStreamParser } from '../src/stream-parser';

function collect() {
  const errors: string[] = [];
  const values: Array<{ key: string; value: unknown }> = [];
  const parser = createStreamParser({
    onValue: (key, value) => values.push({ key, value }),
    onError: (e) => errors.push(e.message),
  });
  return { parser, errors, values };
}

/** Feed a chunk and return whatever the parser complained about. */
function errorsFor(json: string): string[] {
  const { parser, errors } = collect();
  parser.write(json);
  parser.end();
  return errors;
}

describe('StreamParser - structural errors', () => {
  it('rejects junk where a key must start', () => {
    expect(errorsFor('{x:1}').join(' ')).toMatch(/Expected " or }/);
  });

  it('rejects a missing colon after a key', () => {
    expect(errorsFor('{"a" 1}').join(' ')).toMatch(/Expected :/);
  });

  it('rejects junk between members', () => {
    expect(errorsFor('{"a":1 "b":2}').join(' ')).toMatch(/Expected , or } or \]/);
  });

  it('accepts whitespace in every position the error arms guard', () => {
    // Each handler must reject only non-whitespace.
    const { parser, values, errors } = collect();
    parser.write('{\n  "a"\t:\r1 ,\n  "b" : 2\n}');
    parser.end();
    expect(errors).toEqual([]);
    expect(values).toEqual([
      { key: 'a', value: 1 },
      { key: 'b', value: 2 },
    ]);
  });
});

describe('StreamParser - string escapes', () => {
  it('rejects an unknown escape', () => {
    expect(errorsFor('{"a":"\\q"}').join(' ')).toMatch(/Invalid escape/);
  });

  it('accepts every simple escape', () => {
    const { parser, values, errors } = collect();
    parser.write('{"a":"\\"\\\\\\/\\b\\f\\n\\r\\t"}');
    parser.end();
    expect(errors).toEqual([]);
    expect(values[0].value).toBe('"\\/\b\f\n\r\t');
  });

  it('rejects a non-hex digit in a \\u escape', () => {
    expect(errorsFor('{"a":"\\u00zz"}').join(' ')).toMatch(/Invalid hex digit/);
  });

  it('accepts \\u across the full hex alphabet, both cases', () => {
    const { parser, values, errors } = collect();
    parser.write('{"a":"\\u00e9\\u00C9\\u0041"}');
    parser.end();
    expect(errors).toEqual([]);
    expect(values[0].value).toBe('éÉA');
  });
});

describe('StreamParser - keywords and numbers', () => {
  it('rejects a mistyped keyword and names what it wanted', () => {
    expect(errorsFor('{"a":tru3}').join(' ')).toMatch(/Expected "true"/);
    expect(errorsFor('{"a":fals3}').join(' ')).toMatch(/Expected "false"/);
    expect(errorsFor('{"a":nul3}').join(' ')).toMatch(/Expected "null"/);
  });

  it('rejects a bare minus with no digit', () => {
    expect(errorsFor('{"a":-x}').join(' ')).toMatch(/Expected digit after -/);
  });

  it('parses the number shapes the minus/zero states branch on', () => {
    const { parser, values, errors } = collect();
    parser.write('{"a":-0,"b":-1.5,"c":0,"d":1e3,"e":-2.5E-2}');
    parser.end();
    expect(errors).toEqual([]);
    expect(values.map((v) => v.value)).toEqual([-0, -1.5, 0, 1000, -0.025]);
  });
});

describe('StreamParser - an input that ends inside a number', () => {
  function atEnd(json: string) {
    const { parser, values, errors } = collect();
    parser.write(json);
    parser.end();
    return { values: values.map((v) => v.value), errors };
  }
  const native = (json: string): unknown[] | 'error' => {
    try { return [JSON.parse(json)]; } catch { return 'error'; }
  };

  it.each(['-', '1.', '1e', '1e+', '-1.5E-', '[1.', '{"a":1e'])('%s is an error and emits no value, as JSON.parse rejects it', (json) => {
    const r = atEnd(json);
    expect([r.values, r.errors[0], native(json)]).toEqual([[], 'Unexpected end: incomplete number', 'error']);
  });

  it.each(['0', '-0', '12', '1.5', '1e3', '-2.5E+2'])('control: %s is its number, as JSON.parse reads it', (json) => {
    expect(atEnd(json)).toEqual({ values: native(json), errors: [] });
  });
});
