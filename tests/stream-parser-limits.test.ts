/**
 * StreamParser — buffer growth, depth limits, mismatched closers, post-end input.
 *
 * The malformed-input suite covers the handlers' error arms; what it never
 * exercises are the *structural* limits that sit outside any single handler:
 *
 *  - StringBuffer.push growth (115) — every existing test string fits the
 *    initial 256-unit buffer, so the doubling path never ran.
 *  - openObject/openArray maxDepth guards (437, 446) — the parser's only
 *    protection against a hostile stream nesting until the process dies.
 *  - closeObject/closeArray parent mismatch (456, 465) — `[1}` / `{"a":1]`
 *    reach the closers with the *wrong* parent on the stack, which is a
 *    different path from the handler-level "unexpected character" rejects.
 *  - handleNumber's default arm (430) — reachable only after end(), when the
 *    state is S_DONE and dispatch falls through to the number handler.
 *  - S_NUM_EXP_DIGIT digit accumulation (425) — a multi-digit exponent.
 */
import { describe, expect, it } from 'vitest';
import { createStreamParser } from '../src/stream-parser';

function collect(options?: { maxDepth?: number }) {
  const errors: string[] = [];
  const values: Array<{ key: string; value: unknown }> = [];
  const parser = createStreamParser(
    {
      onValue: (key, value) => values.push({ key, value }),
      onError: (e) => errors.push(e.message),
    },
    options ?? {},
  );
  return { parser, errors, values };
}

describe('StreamParser — string buffer growth', () => {
  it('grows past the initial buffer for a long string value', () => {
    // 5000 > the 256-unit initial buffer, so push() doubles several times.
    const long = 'x'.repeat(5000);
    const { parser, values, errors } = collect();
    parser.write(`{"a":"${long}"}`);
    parser.end();
    expect(errors).toEqual([]);
    expect(values).toEqual([{ key: 'a', value: long }]);
  });

  it('grows past the chunked-flush size', () => {
    // > FLUSH_CHUNK (8192): flush() must stitch the segments back together in
    // order, not just survive the growth.
    const long = `${'a'.repeat(9000)}TAIL`;
    const { parser, values, errors } = collect();
    parser.write(`{"a":"${long}"}`);
    parser.end();
    expect(errors).toEqual([]);
    expect((values[0]!.value as string).length).toBe(long.length);
    expect(values[0]!.value).toBe(long);
  });
});

describe('StreamParser — depth limit', () => {
  it('rejects objects nested past maxDepth', () => {
    const { parser, errors } = collect({ maxDepth: 3 });
    parser.write('{"a":{"b":{"c":{"d":1}}}}');
    expect(errors.some(m => /Max depth exceeded/.test(m))).toBe(true);
  });

  it('rejects arrays nested past maxDepth', () => {
    const { parser, errors } = collect({ maxDepth: 2 });
    parser.write('[[[1]]]');
    expect(errors.some(m => /Max depth exceeded/.test(m))).toBe(true);
  });

  it('accepts nesting exactly at the limit', () => {
    const { parser, errors, values } = collect({ maxDepth: 3 });
    parser.write('{"a":{"b":1}}');
    parser.end();
    expect(errors).toEqual([]);
    expect(values).toEqual([{ key: 'b', value: 1 }]);
  });
});

describe('StreamParser — mismatched closers', () => {
  it('rejects } closing an array', () => {
    const { parser, errors } = collect();
    parser.write('[1}');
    expect(errors.join(' ')).toMatch(/Unexpected }/);
  });

  it('rejects ] closing an object', () => {
    const { parser, errors } = collect();
    parser.write('{"a":1]');
    expect(errors.join(' ')).toMatch(/Unexpected ]/);
  });
});

describe('StreamParser — numbers and post-end input', () => {
  it('accumulates multi-digit exponents', () => {
    const { parser, values, errors } = collect();
    parser.write('{"a":1.5e123}');
    parser.end();
    expect(errors).toEqual([]);
    expect(values).toEqual([{ key: 'a', value: 1.5e123 }]);
  });

  it('rejects input written after end()', () => {
    const { parser, errors } = collect();
    parser.write('{"a":1}');
    parser.end();
    parser.write('{');
    expect(errors.join(' ')).toMatch(/Invalid state/);
  });

  it('parses again after reset()', () => {
    const { parser, values, errors } = collect();
    parser.write('{"a":1}');
    parser.end();
    parser.reset();
    parser.write('{"b":2}');
    parser.end();
    expect(errors).toEqual([]);
    expect(values).toEqual([{ key: 'a', value: 1 }, { key: 'b', value: 2 }]);
  });
});
