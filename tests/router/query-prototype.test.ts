/**
 * Query objects must not inherit from Object.prototype, on every path that builds them.
 * Why: a link such as `?constructor=1` or `?__proto__=` must not turn a scalar into an array holding an inherited function, replace the query's prototype, force a loader refetch, or be lost on a typed query write; no privileged caller is needed to reach it.
 * Shows: parseQuery and setQuery give null-prototype queries, treat polluting keys as ordinary own keys and pollute nothing; defaultAffects ignores undeclared polluting keys; START_LOCATION has a prototype-free query and is frozen all the way down. Router cases run through a real router with memory history.
 * See: src/dict.ts
 */
import { describe, expect, it } from 'vitest';
import { START_LOCATION } from '@router/engine';
import { createMemoryHistory } from '@router/history';
import { defaultAffects } from '@router/loaders';
import type { RouteRecord } from '@router/types';
import { parseQuery, stringifyQuery } from '@router/url';
import { makeRouter as fixtureRouter } from './fixture';

const POLLUTING_KEYS = ['constructor', 'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf'];

describe('parseQuery - prototype safety', () => {
  it('has a null prototype', () => {
    expect(Object.getPrototypeOf(parseQuery('?a=1'))).toBe(null);
    expect(Object.getPrototypeOf(parseQuery(''))).toBe(null);
  });

  it.each(POLLUTING_KEYS)('treats ?%s= as an ordinary scalar key', (key) => {
    const query = parseQuery(`?${key}=1`);
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
    // stringifyQuery uses Object.keys, so a null-prototype object serialises like a plain one.
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
    // Membership must be an own-key test: `in` walks the prototype chain.
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
  return fixtureRouter({
    history: createMemoryHistory(''),
    routes: ROWS,
    components: { Products: { render: () => null } } as never,
    links: false,
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
    expect(Object.getPrototypeOf(router.currentRoute.value.location.query)).toBe(null);
  });

  it('does not answer for an unset polluting key after a query write', async () => {
    const router = makeRouter();
    await router.isReady();
    await router.push('/products');
    router.setQuery({ page: 3 });
    const query = router.currentRoute.value.location.query as Record<string, unknown>;
    expect(query.constructor).toBeUndefined();
    expect(query.toString).toBeUndefined();
  });

  it('lands a __proto__ query write as an own key instead of losing it', async () => {
    const router = makeRouter();
    await router.isReady();
    await router.push('/products');
    // Computed key on purpose: a `{ __proto__: 'x' }` literal sets the prototype and creates no key; useQueryParam writes `{ [key]: value }`.
    router.setQuery({ ['__proto__']: 'x' });
    const query = router.currentRoute.value.location.query;
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

// START_LOCATION is the location every router starts on: a consumer must not have to know which branch built the query.
// It is a public module-level singleton shared by every router, and Object.freeze reaches one level only.
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

  it('refuses a write that would poison every later router', () => {
    expect(() => {
      (START_LOCATION.params as Record<string, unknown>).id = 'poisoned';
    }).toThrow();
    expect(START_LOCATION.params).toEqual({});
  });
});
