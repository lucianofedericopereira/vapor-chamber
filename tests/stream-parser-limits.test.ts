/**
 * StreamParser structural limits: string buffer growth, maxDepth, mismatched closers, multi-digit exponents, input after end().
 * Why: a hostile stream nesting past maxDepth would otherwise exhaust the process, and long strings would be truncated or reordered. Also the only file reaching the maxDepth error, the mismatched closers and multi-digit exponents, so the 100% floor needs it.
 * Shows: 5000- and 9000-char strings come back intact; nesting past maxDepth errors and nesting at the limit parses; `[1}` and `{"a":1]` error; `1.5e123` parses; a write after end() errors; reset() allows a new parse.
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

describe('StreamParser - string buffer growth', () => {
  it('grows past the initial buffer for a long string value', () => {
    // 5000 exceeds the 256-unit initial buffer.
    const long = 'x'.repeat(5000);
    const { parser, values, errors } = collect();
    parser.write(`{"a":"${long}"}`);
    parser.end();
    expect(errors).toEqual([]);
    expect(values).toEqual([{ key: 'a', value: long }]);
  });

  it('grows past the chunked-flush size', () => {
    // Longer than FLUSH_CHUNK: the segments must be rejoined in order.
    const long = `${'a'.repeat(9000)}TAIL`;
    const { parser, values, errors } = collect();
    parser.write(`{"a":"${long}"}`);
    parser.end();
    expect(errors).toEqual([]);
    expect((values[0]!.value as string).length).toBe(long.length);
    expect(values[0]!.value).toBe(long);
  });
});

describe('StreamParser - depth limit', () => {
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

describe('StreamParser - mismatched closers', () => {
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

describe('StreamParser - numbers and post-end input', () => {
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
