/**
 * StreamParser — malformed input.
 *
 * The existing suite parses well-formed JSON thoroughly; what it never does is
 * hand the parser something broken. That left the error arms of nearly every
 * state handler untested — 21 uncovered branch sites, and the single largest
 * gap in the package (84.2% branches).
 *
 * These are the branches that matter most in a streaming parser: it consumes
 * bytes off a network, so malformed input is an expected condition, not an
 * exotic one. Each case pins the specific handler that must reject, and asserts
 * the *message* rather than just "an error happened" — otherwise a parser that
 * rejected everything for the wrong reason would pass.
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

describe('StreamParser — structural errors', () => {
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
    // The mirror image of the three cases above: each handler falls through to
    // `err()` only for NON-whitespace, so this pins that the guard is a
    // whitespace check and not an accident of ordering.
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

describe('StreamParser — string escapes', () => {
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

describe('StreamParser — keywords and numbers', () => {
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
