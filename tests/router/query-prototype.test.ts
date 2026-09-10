/**
 * Query objects must not inherit from Object.prototype.
 *
 * `parseQuery` built into a `{}` and then read `query[key]` to detect a repeated
 * key. On a plain object that read walks the prototype chain, so any query key
 * named after an Object.prototype member came back DEFINED and took the
 * "repeated key" branch - turning a scalar into an array whose first element was
 * the inherited function. `?__proto__=` was worse: the assignment went through
 * the `__proto__` setter, so the key never became an own property and the parsed
 * object's prototype was replaced.
 *
 * Reachable from a plain link - no privileged caller required. Same bug class
 * v1.15.0 fixed in the MCP `tools/call` gate (`Object.hasOwn`), which is why
 * this one is pinned rather than trusted to review.
 *
 * THE SECOND HALF OF THIS FILE exists because pinning `parseQuery` alone was
 * not enough: `setQuery` rebuilt the merged query with a SPREAD, and spreading
 * a null-prototype object produces a plain one. So the property held after
 * `navigate()` and was lost after the first typed query write - the two arms
 * disagreeing is exactly what the engine says must never happen. Asserted
 * through the REAL router (real table, real engine, memory history) rather
 * than against the helper, because the helper was never the part that broke.
 */

import { describe, expect, it } from 'vitest';
import { START_LOCATION } from '../../src/router/engine';
import { createMemoryHistory } from '../../src/router/history';
import { createRouter } from '../../src/router/index';
import { defaultAffects } from '../../src/router/loaders';
import type { RouteRecord } from '../../src/router/types';
import { parseQuery, stringifyQuery } from '../../src/router/url';

const POLLUTING_KEYS = ['constructor', 'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf'];

describe('parseQuery - prototype safety', () => {
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
    // object serialises exactly like a plain one - no key gained or lost.
    expect(stringifyQuery(parseQuery('?constructor=1&page=2'))).toBe('constructor=1&page=2');
  });

  it('leaves ordinary keys untouched', () => {
    const query = parseQuery('?page=2&sort=-price&tag=a&tag=b');
    expect(query.page).toBe('2');
    expect(query.sort).toBe('-price');
    expect(query.tag).toEqual(['a', 'b']);
  });
});

describe('defaultAffects - an undeclared query key must not force a refetch', () => {
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

const ROWS: RouteRecord[] = [
  { name: 'products', path: '/products', component: 'Products', query: { page: { type: 'int', default: 1 } } },
];

function makeRouter() {
  return createRouter({
    history: createMemoryHistory(''),
    routes: ROWS,
    components: { Products: { render: () => null } } as never,
    links: false,
    scroll: false,
    onError: () => {},
  });
}

describe('location.query prototype - uniform across BOTH commit paths', () => {
  it('is prototype-free after a path navigation', async () => {
    const router = makeRouter();
    await router.isReady();
    await router.push('/products?page=2');
    expect(Object.getPrototypeOf(router.currentRoute.value.location.query)).toBe(null);
  });

  it('is prototype-free after a typed query write', async () => {
    const router = makeRouter();
    await router.isReady();
    await router.push('/products');
    router.setQuery({ page: 3 });
    // Pre-fix this was Object.prototype: setQuery spread the query into a `{}`.
    expect(Object.getPrototypeOf(router.currentRoute.value.location.query)).toBe(null);
  });

  it('does not answer for an unset polluting key after a query write', async () => {
    const router = makeRouter();
    await router.isReady();
    await router.push('/products');
    router.setQuery({ page: 3 });
    const query = router.currentRoute.value.location.query as Record<string, unknown>;
    // Pre-fix: [Function Object].
    expect(query.constructor).toBeUndefined();
    expect(query.toString).toBeUndefined();
  });

  it('lands a __proto__ query write as an own key instead of losing it', async () => {
    const router = makeRouter();
    await router.isReady();
    await router.push('/products');
    // COMPUTED key, deliberately: a `{ __proto__: 'x' }` literal is the
    // prototype-setting syntax and never creates a key at all. `useQueryParam`
    // writes `{ [key]: value }`, so a computed key is the shape that actually
    // reaches setQuery from the public surface.
    router.setQuery({ ['__proto__']: 'x' });
    const query = router.currentRoute.value.location.query;
    // Pre-fix the inherited setter swallowed the write: no own key, and the
    // value never reached the URL.
    expect(Object.hasOwn(query, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(query)).toBe(null);
    expect(router.currentRoute.value.location.fullPath).toContain('__proto__=x');
  });

  it('does not pollute Object.prototype through a query write', async () => {
    const router = makeRouter();
    await router.isReady();
    await router.push('/products');
    router.setQuery({ ['__proto__']: 'x' });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect((Object.prototype as Record<string, unknown>).x).toBeUndefined();
  });
});

/**
 * The third arm, and the one the module SHIPS: START_LOCATION.
 *
 * Both arms of resolveLocation, cleanQueryPatch and setQuery go out of their way
 * to stay prototype-free, on the stated grounds that "a consumer must not have
 * to know which branch built the query". The location every router starts on was
 * a literal `{}`, so the property held everywhere except before the first
 * navigation - which is exactly when a consumer is most likely to read a query
 * it has not populated yet.
 *
 * It is also a module-level singleton, exported publicly and shared by every
 * router in the process, and `Object.freeze` reaches one level - so its nested
 * objects were writable globals.
 */
describe('START_LOCATION', () => {
  it('carries a prototype-free query like every other location', () => {
    expect(Object.getPrototypeOf(START_LOCATION.query)).toBeNull();
    expect('constructor' in START_LOCATION.query).toBe(false);
  });

  it('is frozen all the way down, being a shared global', () => {
    expect(Object.isFrozen(START_LOCATION)).toBe(true);
    expect(Object.isFrozen(START_LOCATION.params)).toBe(true);
    expect(Object.isFrozen(START_LOCATION.query)).toBe(true);
    expect(Object.isFrozen(START_LOCATION.meta)).toBe(true);
    expect(Object.isFrozen(START_LOCATION.matched)).toBe(true);
  });

  it('refuses a write that used to poison every later router', () => {
    expect(() => {
      (START_LOCATION.params as Record<string, unknown>).id = 'poisoned';
    }).toThrow();
    expect(START_LOCATION.params).toEqual({});
  });
});
