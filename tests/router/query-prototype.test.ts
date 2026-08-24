/**
 * Query objects must not inherit from Object.prototype.
 *
 * `parseQuery` built into a `{}` and then read `query[key]` to detect a repeated
 * key. On a plain object that read walks the prototype chain, so any query key
 * named after an Object.prototype member came back DEFINED and took the
 * "repeated key" branch — turning a scalar into an array whose first element was
 * the inherited function. `?__proto__=` was worse: the assignment went through
 * the `__proto__` setter, so the key never became an own property and the parsed
 * object's prototype was replaced.
 *
 * Reachable from a plain link — no privileged caller required. Same bug class
 * v1.15.0 fixed in the MCP `tools/call` gate (`Object.hasOwn`), which is why
 * this one is pinned rather than trusted to review.
 */

import { describe, expect, it } from 'vitest';
import { defaultAffects } from '../../src/router/loaders';
import { parseQuery, stringifyQuery } from '../../src/router/url';

const POLLUTING_KEYS = ['constructor', 'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf'];

describe('parseQuery — prototype safety', () => {
  it('has a null prototype', () => {
    expect(Object.getPrototypeOf(parseQuery('?a=1'))).toBe(null);
    expect(Object.getPrototypeOf(parseQuery(''))).toBe(null);
  });

  it.each(POLLUTING_KEYS)('treats ?%s= as an ordinary scalar key', (key) => {
    const query = parseQuery(`?${key}=1`);
    // The assertion that fails against the pre-fix code: it produced [fn, '1'].
    expect(query[key]).toBe('1');
    expect(Array.isArray(query[key])).toBe(false);
    expect(Object.hasOwn(query, key)).toBe(true);
  });

  it.each(POLLUTING_KEYS)('still collects genuinely repeated ?%s= into an array', (key) => {
    const query = parseQuery(`?${key}=1&${key}=2`);
    expect(query[key]).toEqual(['1', '2']);
  });

  it('does not let ?__proto__= replace the object prototype', () => {
    const query = parseQuery('?__proto__=a');
    expect(Object.getPrototypeOf(query)).toBe(null);
    expect(Object.hasOwn(query, '__proto__')).toBe(true);
    expect(query['__proto__' as keyof typeof query]).toBe('a');
  });

  it('does not let ?__proto__= pollute other objects', () => {
    parseQuery('?__proto__[polluted]=yes&__proto__=x');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('round-trips a polluting key back through stringifyQuery', () => {
    // stringifyQuery uses Object.keys (own, enumerable), so a null-prototype
    // object serialises exactly like a plain one — no key gained or lost.
    expect(stringifyQuery(parseQuery('?constructor=1&page=2'))).toBe('constructor=1&page=2');
  });

  it('leaves ordinary keys untouched', () => {
    const query = parseQuery('?page=2&sort=-price&tag=a&tag=b');
    expect(query.page).toBe('2');
    expect(query.sort).toBe('-price');
    expect(query.tag).toEqual(['a', 'b']);
  });
});

describe('defaultAffects — an undeclared query key must not force a refetch', () => {
  const record = { name: 'r', load: 'rows:products', queryDefs: {} } as never;
  const handlers = { prefixes: { 'rows:': () => [] } } as never;

  it.each(POLLUTING_KEYS)('does not treat ?%s= as a declared param', (key) => {
    // Pre-fix this used `key in record.queryDefs`, which walks the prototype
    // chain, so any of these reported true and refetched the record's loader.
    expect(defaultAffects(record, [key], handlers)).toBe(false);
  });

  it('still ignores a genuinely undeclared key', () => {
    expect(defaultAffects(record, ['nope'], handlers)).toBe(false);
  });

  it('still refetches for declared keys and the pagination trio', () => {
    const declared = { name: 'r', load: 'rows:products', queryDefs: { status: {} } } as never;
    expect(defaultAffects(declared, ['status'], handlers)).toBe(true);
    expect(defaultAffects(record, ['page'], handlers)).toBe(true);
    expect(defaultAffects(record, ['per_page'], handlers)).toBe(true);
    expect(defaultAffects(record, ['sort'], handlers)).toBe(true);
  });
});
