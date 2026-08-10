/**
 * Tests for src/stream-parser.ts — StreamParser / createStreamParser
 */
import { describe, expect, it } from 'vitest';
import { createStreamParser } from '../src/stream-parser';

function collect() {
  const values: Array<{ key: string; value: unknown; path: ReadonlyArray<string | number> }> = [];
  const errors: string[] = [];
  const parser = createStreamParser({
    onValue: (key, value, path) => values.push({ key, value, path: [...path] }),
    onError: (e) => errors.push(e.message),
  });
  return { parser, values, errors };
}

describe('StreamParser — basic values', () => {
  it('parses a flat object', () => {
    const { parser, values } = collect();
    parser.write('{"a":1,"b":"two","c":true,"d":false,"e":null}');
    parser.end();

    expect(values).toEqual([
      { key: 'a', value: 1, path: ['a'] },
      { key: 'b', value: 'two', path: ['b'] },
      { key: 'c', value: true, path: ['c'] },
      { key: 'd', value: false, path: ['d'] },
      { key: 'e', value: null, path: ['e'] },
    ]);
  });

  it('parses a flat array with indexed paths', () => {
    const { parser, values } = collect();
    parser.write('[10, 20, 30]');
    parser.end();

    expect(values.map((v) => v.value)).toEqual([10, 20, 30]);
    expect(values.map((v) => v.path)).toEqual([[0], [1], [2]]);
  });

  it('parses nested objects/arrays with correct paths', () => {
    const { parser, values } = collect();
    parser.write('{"items":[{"id":1},{"id":2}]}');
    parser.end();

    const ids = values.filter((v) => v.key === 'id');
    expect(ids.map((v) => v.value)).toEqual([1, 2]);
    expect(ids.map((v) => v.path)).toEqual([
      ['items', 0, 'id'],
      ['items', 1, 'id'],
    ]);
  });

  it('a bare top-level scalar is still emitted', () => {
    const { parser, values } = collect();
    parser.write('42');
    parser.end();
    expect(values).toEqual([{ key: '', value: 42, path: [] }]);
  });
});

describe('StreamParser — numbers', () => {
  it('handles negative, fractional, and exponent forms', () => {
    const { parser, values } = collect();
    parser.write('[-5, 3.14, 1e3, 2.5e-2, 0]');
    parser.end();
    expect(values.map((v) => v.value)).toEqual([-5, 3.14, 1000, 0.025, 0]);
  });

  it('flushes a trailing number on end() with no closing delimiter', () => {
    const { parser, values } = collect();
    parser.write('123');
    parser.end();
    expect(values).toEqual([{ key: '', value: 123, path: [] }]);
  });
});

describe('StreamParser — strings and escapes', () => {
  it('decodes standard escapes', () => {
    const { parser, values } = collect();
    parser.write(String.raw`{"s":"line1\nline2\ttab\"quote\\slash"}`);
    parser.end();
    expect(values[0]?.value).toBe('line1\nline2\ttab"quote\\slash');
  });

  it('decodes literal UTF-8 characters written directly (no escape)', () => {
    const { parser, values } = collect();
    parser.write('{"s":"café 😀"}');
    parser.end();
    expect(values[0]?.value).toBe('café 😀');
  });

  it('decodes \\uXXXX escapes, including a surrogate pair', () => {
    const { parser, values } = collect();
    // é = é ; 😀 = 😀 (surrogate pair)
    parser.write('{"s":"\\u00e9 \\ud83d\\ude00"}');
    parser.end();
    expect(values[0]?.value).toBe('é 😀');
  });

  // The module's headline input is an LLM completion or an export row — one
  // long string value. `String.fromCharCode.apply` passes the buffer as call
  // arguments, and engines cap argument counts, so the whole parse threw
  // RangeError somewhere past ~65k characters.
  it('round-trips a 1MB string value byte-identically', () => {
    const { parser, values, errors } = collect();
    const big = 'x'.repeat(1_000_000);
    parser.write(`{"completion":"${big}"}`);
    parser.end();

    expect(errors).toEqual([]);
    expect(values[0]?.key).toBe('completion');
    expect(values[0]?.value).toBe(big);
    expect((values[0].value as string).length).toBe(1_000_000);
  });

  it('keeps a surrogate pair intact across a flush-chunk boundary', () => {
    // flush() converts in 8192-unit chunks, and the split is on UTF-16 units —
    // so a pair can straddle a boundary. Concatenating the halves must still
    // yield one code point. 8191 'x' + 😀 puts the high surrogate at index
    // 8191 and the low surrogate at 8192, exactly on the seam.
    const { parser, values, errors } = collect();
    const value = `${'x'.repeat(8191)}😀tail`;
    parser.write(`{"s":"${value}"}`);
    parser.end();

    expect(errors).toEqual([]);
    expect(values[0]?.value).toBe(value);
    expect([...(values[0].value as string)].at(8191)).toBe('😀');
  });
});

describe('StreamParser — chunked / streamed input', () => {
  it('reassembles a value split across many small writes', () => {
    const { parser, values } = collect();
    const json = '{"greeting":"hello world","n":123}';
    for (const ch of json) parser.write(ch);
    parser.end();

    expect(values).toEqual([
      { key: 'greeting', value: 'hello world', path: ['greeting'] },
      { key: 'n', value: 123, path: ['n'] },
    ]);
  });

  it('reads from a fetch-like Response via stream()', async () => {
    const { parser, values } = collect();
    const body = '{"items":[1,2,3]}';
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        // Split into two chunks to prove incremental decoding works.
        controller.enqueue(encoder.encode(body.slice(0, 8)));
        controller.enqueue(encoder.encode(body.slice(8)));
        controller.close();
      },
    });
    const response = new Response(stream);

    await parser.stream(response);

    expect(values.map((v) => v.value)).toEqual([1, 2, 3]);
  });
});

describe('StreamParser — errors', () => {
  it('reports unexpected characters without throwing', () => {
    const { parser, errors } = collect();
    parser.write('{"a": }');
    expect(errors.length).toBeGreaterThan(0);
  });

  it('reports unclosed structures on end()', () => {
    const { parser, errors } = collect();
    parser.write('{"a": 1');
    parser.end();
    expect(errors.some((e) => e.includes('unclosed'))).toBe(true);
  });
});

describe('StreamParser — reset/getState', () => {
  it('reset() returns the parser to a clean idle state', () => {
    const { parser, values } = collect();
    parser.write('{"a":1');
    expect(parser.getState().depth).toBe(2); // top + object

    parser.reset();
    expect(parser.getState().depth).toBe(1);

    parser.write('{"b":2}');
    parser.end();
    expect(values).toEqual([{ key: 'b', value: 2, path: ['b'] }]);
  });
});

describe('StreamParser — object/array lifecycle callbacks', () => {
  it('fires onObjectStart/End and onArrayStart/End around onValue', () => {
    const events: string[] = [];
    const parser = createStreamParser({
      onObjectStart: () => events.push('obj-start'),
      onObjectEnd: () => events.push('obj-end'),
      onArrayStart: () => events.push('arr-start'),
      onArrayEnd: () => events.push('arr-end'),
      onValue: (k) => events.push(`value:${k}`),
    });
    parser.write('{"list":[1]}');
    parser.end();

    // `key` tracks the nearest enclosing OBJECT property name (arrays have
    // no keys of their own — `path`'s index disambiguates array members),
    // so the scalar array element still reports key "list".
    expect(events).toEqual(['obj-start', 'arr-start', 'value:list', 'arr-end', 'obj-end']);
  });
});

// ---------------------------------------------------------------------------
// Number-format error paths + uppercase exponent (previously uncovered states)
// ---------------------------------------------------------------------------

describe('number edge states', () => {
  const parseWithErrors = (input: string) => {
    const errors: string[] = [];
    const values: unknown[] = [];
    const parser = createStreamParser({
      onError: (e) => errors.push(e.message),
      onValue: (_k, v) => values.push(v),
    });
    parser.write(input);
    parser.end();
    return { errors, values };
  };

  it('a dot with no following digit is an error', () => {
    const { errors } = parseWithErrors('{"n": 1.}');
    expect(errors.some((m) => m.includes('Expected digit after .'))).toBe(true);
  });

  it('an exponent with no digit or sign is an error', () => {
    const { errors } = parseWithErrors('{"n": 1e}');
    expect(errors.some((m) => m.includes('Expected digit or sign after exponent'))).toBe(true);
  });

  it('an exponent sign with no following digit is an error', () => {
    const { errors } = parseWithErrors('{"n": 1e+}');
    expect(errors.some((m) => m.includes('Expected digit after exponent sign'))).toBe(true);
  });

  it('uppercase E exponents parse (both bare and after a fraction)', () => {
    const { errors, values } = parseWithErrors('{"a": 2E3, "b": 1.5E+2}');
    expect(errors).toEqual([]);
    expect(values).toContain(2000);
    expect(values).toContain(150);
  });

  it('signed exponent digits accumulate across chunk boundaries', () => {
    const errors: string[] = [];
    const values: unknown[] = [];
    const parser = createStreamParser({
      onError: (e) => errors.push(e.message),
      onValue: (_k, v) => values.push(v),
    });
    parser.write('{"n": 1e-');
    parser.write('2}');
    parser.end();
    expect(errors).toEqual([]);
    expect(values).toContain(0.01);
  });
});
