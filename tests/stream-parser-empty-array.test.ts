/**
 * StreamParser on empty arrays, alone and nested, at any chunk split.
 * Why: valid JSON containing `[]` would be reported as an unclosed structure, while a trailing comma (`[1,]`) must still be refused.
 * Shows: ten empty-array shapes parse with no error; members around an empty array are reported with their paths; every chunk size parses; `[1,]` and `{"a":[1,]}` report an error.
 */
import { describe, expect, it } from 'vitest';
import { createStreamParser } from '../src/stream-parser';

function parse(json: string, chunk = json.length) {
  const errors: string[] = [];
  const values: Array<{ path: Array<string | number>; value: unknown }> = [];
  let arrays = 0;
  const parser = createStreamParser({
    onValue: (_key, value, path) => values.push({ path: [...path], value }),
    onArrayEnd: () => arrays++,
    onError: (e) => errors.push(e.message),
  });
  for (let i = 0; i < json.length; i += chunk) parser.write(json.slice(i, i + chunk));
  parser.end();
  return { errors, values, arrays };
}

describe('StreamParser - empty arrays', () => {
  it.each(['[]', '[[]]', '[[[]]]', '{"a":[]}', '[[],1]', '[1,[]]', '[[],{}]', '{"a":[],"b":1}', '[ ]', '[\n]'])(
    'parses %j with no error',
    (json) => {
      const { errors } = parse(json);
      expect(errors).toEqual([]);
    },
  );

  it('reports the members around an empty array', () => {
    const { values, arrays } = parse('{"items":[],"total":0,"tags":["a",[]]}');
    expect(values).toContainEqual({ path: ['total'], value: 0 });
    expect(values).toContainEqual({ path: ['tags', 0], value: 'a' });
    expect(arrays).toBe(3);
  });

  it('parses an empty array split at every position', () => {
    const json = '{"a":[],"b":[[],[1]]}';
    for (let chunk = 1; chunk <= json.length; chunk++) {
      expect(parse(json, chunk).errors, `chunk size ${chunk}`).toEqual([]);
    }
  });

  it('still refuses a trailing comma', () => {
    expect(parse('[1,]').errors.length).toBeGreaterThan(0);
    expect(parse('{"a":[1,]}').errors.length).toBeGreaterThan(0);
  });
});
