import { describe, expect, it } from 'vitest';
import { decodeQueryParam, encodeQueryParam, parseQuery, resolveQueryHistory, stringifyQuery } from '../../src/router/url';

describe('parseQuery / stringifyQuery', () => {
  it('round-trips simple values', () => {
    expect(parseQuery('?a=1&b=two')).toEqual({ a: '1', b: 'two' });
    expect(stringifyQuery({ a: '1', b: 'two' })).toBe('a=1&b=two');
  });

  it('collects repeated keys into arrays and emits them back', () => {
    expect(parseQuery('tag=a&tag=b')).toEqual({ tag: ['a', 'b'] });
    expect(stringifyQuery({ tag: ['a', 'b'] })).toBe('tag=a&tag=b');
  });

  it('handles empty and valueless entries', () => {
    expect(parseQuery('')).toEqual({});
    expect(parseQuery('?flag')).toEqual({ flag: '' });
    expect(stringifyQuery({ flag: '' })).toBe('flag');
  });

  it('decodes + as space and survives malformed encodings', () => {
    expect(parseQuery('q=hello+world')).toEqual({ q: 'hello world' });
    expect(parseQuery('q=%E0%A4%A')).toEqual({ q: '%E0%A4%A' });
  });

  it('skips null/undefined values when stringifying', () => {
    expect(stringifyQuery({ a: '1', b: null, c: undefined } as never)).toBe('a=1');
  });

  it('keeps readable characters unescaped', () => {
    expect(stringifyQuery({ range: '1:10', path: 'a/b' })).toBe('range=1:10&path=a/b');
  });
});

describe('decodeQueryParam', () => {
  it('casts int with default fallback', () => {
    expect(decodeQueryParam('2', { type: 'int', default: 1 })).toBe(2);
    expect(decodeQueryParam(undefined, { type: 'int', default: 1 })).toBe(1);
    expect(decodeQueryParam('abc', { type: 'int', default: 1 })).toBe(1);
  });

  it('casts bool from 1/0/true/false', () => {
    expect(decodeQueryParam('1', { type: 'bool' })).toBe(true);
    expect(decodeQueryParam('false', { type: 'bool', default: true })).toBe(false);
    expect(decodeQueryParam('maybe', { type: 'bool', default: false })).toBe(false);
  });

  it('array type always yields an array', () => {
    expect(decodeQueryParam('a', { type: 'array' })).toEqual(['a']);
    expect(decodeQueryParam(['a', 'b'], { type: 'array' })).toEqual(['a', 'b']);
    expect(decodeQueryParam(undefined, { type: 'array' })).toEqual([]);
  });

  it('scalar def takes the last repeated value', () => {
    expect(decodeQueryParam(['1', '3'], { type: 'int' })).toBe(3);
  });
});

describe('encodeQueryParam', () => {
  it('drops values equal to the declared default (clean URLs)', () => {
    expect(encodeQueryParam(1, { type: 'int', default: 1 })).toBeNull();
    expect(encodeQueryParam(2, { type: 'int', default: 1 })).toBe('2');
  });

  it('encodes booleans as 1/0', () => {
    expect(encodeQueryParam(true, { type: 'bool' })).toBe('1');
    expect(encodeQueryParam(false, { type: 'bool' })).toBe('0');
  });

  it('null/undefined remove the key', () => {
    expect(encodeQueryParam(null, {})).toBeNull();
    expect(encodeQueryParam(undefined, {})).toBeNull();
  });

  it('arrays stringify element-wise and drop when equal to default', () => {
    expect(encodeQueryParam([1, 2], { type: 'array' })).toEqual(['1', '2']);
    expect(encodeQueryParam(['a'], { type: 'array', default: ['a'] })).toBeNull();
  });
});

describe('resolveQueryHistory', () => {
  it('convention: page pushes, everything else replaces', () => {
    expect(resolveQueryHistory('page', undefined)).toBe('push');
    expect(resolveQueryHistory('sort', undefined)).toBe('replace');
    expect(resolveQueryHistory('q', {})).toBe('replace');
  });

  it('route declaration beats the convention', () => {
    expect(resolveQueryHistory('page', { history: 'replace' })).toBe('replace');
    expect(resolveQueryHistory('sort', { history: 'push' })).toBe('push');
  });

  it('explicit override beats everything', () => {
    expect(resolveQueryHistory('page', { history: 'replace' }, 'push')).toBe('push');
    expect(resolveQueryHistory('sort', { history: 'push' }, 'replace')).toBe('replace');
  });
});

describe('parseQuery — repeated keys', () => {
  it('collects a repeated key into an array, in order', () => {
    // Third and later occurrences take the push branch, not the pair branch.
    expect(parseQuery('tag=a&tag=b&tag=c')).toEqual({ tag: ['a', 'b', 'c'] });
  });

  it('keeps a single occurrence a scalar', () => {
    expect(parseQuery('tag=a')).toEqual({ tag: 'a' });
  });

  it('mixes repeated and single keys', () => {
    expect(parseQuery('page=2&tag=a&tag=b')).toEqual({ page: '2', tag: ['a', 'b'] });
  });

  it('round-trips an array back through stringifyQuery', () => {
    expect(parseQuery(stringifyQuery({ tag: ['a', 'b'] }).replace(/^\?/, ''))).toEqual({ tag: ['a', 'b'] });
  });
});

describe('query edge cases', () => {
  it('skips empty pairs from doubled or trailing separators', () => {
    expect(parseQuery('a=1&&b=2&')).toEqual({ a: '1', b: '2' });
  });

  it('stringify emits a BARE key for an empty value, and skips null/undefined', () => {
    expect(stringifyQuery({ flag: '', page: '2' })).toBe('flag&page=2');
    expect(stringifyQuery({ a: null, b: undefined, c: '1' })).toBe('c=1');
  });

  it('stringify expands an array into repeated keys, skipping holes', () => {
    expect(stringifyQuery({ tag: ['a', null, 'b'] as never })).toBe('tag=a&tag=b');
  });

  it('encodeQueryParam drops a value equal to its declared default', () => {
    // Defaults never appear in the URL — that is what keeps a shared link clean.
    expect(encodeQueryParam(['a', 'b'], { type: 'array', default: ['a', 'b'] })).toBeNull();
    expect(encodeQueryParam(['a', 'c'], { type: 'array', default: ['a', 'b'] })).toEqual(['a', 'c']);
    expect(encodeQueryParam([], { type: 'array' })).toBeNull();
  });

  it('encodeQueryParam drops null and undefined outright', () => {
    expect(encodeQueryParam(null, {})).toBeNull();
    expect(encodeQueryParam(undefined, {})).toBeNull();
  });
});
