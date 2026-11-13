/**
 * A param or placeholder name from the routes payload is never answered by Object.prototype.
 * Why: the names arrive in a fetched or inlined routes payload, and `params` and `queryDefs` are plain objects; read with `obj[name]`, an absent name such as `constructor` or `toString` found the inherited function and built its source text into a link or a loader URL.
 * Shows: buildPath leaves out an absent optional param named after an inherited member, and refuses an absent required one as router:missing:param; interpolateLoad blanks a placeholder named after an inherited member, as it blanks any unknown key; a present param of that name is still used.
 * See: src/dict.ts, tests/router/component-key-prototype.test.ts, tests/router/loaders.test.ts
 */
import { describe, expect, it } from 'vitest';
import { dict } from '../../src/dict';
import { isRouterError } from '@router/errors';
import { interpolateLoad } from '@router/loaders';
import { createRouteTable } from '@router/table';
import type { RouteLocation } from '@router/types';

const POLLUTING_KEYS = ['constructor', 'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf'];

/** A location as the engine builds it: `params` a plain object, `query` a dict (src/router/engine.ts, `parseQuery`). */
function locationWith(params: Record<string, string | number> = {}): RouteLocation {
  return { name: 'x', path: '/x', fullPath: '/x', params, query: dict(), hash: '', matched: [], meta: {} };
}

describe('buildPath - a param name from the payload', () => {
  it.each(POLLUTING_KEYS)('leaves out an absent optional param named %s', (key) => {
    const table = createRouteTable([{ name: 'row', path: `/row/:${key}?`, component: 'R' }]);
    expect(table.buildPath(table.getRecord('row')!, {})).toBe('/row');
  });

  it.each(POLLUTING_KEYS)('refuses an absent required param named %s', (key) => {
    const table = createRouteTable([{ name: 'row', path: `/row/:${key}`, component: 'R' }]);
    let thrown: unknown;
    try {
      table.buildPath(table.getRecord('row')!, {});
    } catch (error) {
      thrown = error;
    }
    expect(isRouterError(thrown, 'router:missing:param')).toBe(true);
  });

  it('still uses a present param of that name', () => {
    const table = createRouteTable([{ name: 'row', path: '/row/:toString', component: 'R' }]);
    expect(table.buildPath(table.getRecord('row')!, { toString: 'x' } as never)).toBe('/row/x');
  });
});

describe('interpolateLoad - a placeholder name from the payload', () => {
  it.each(POLLUTING_KEYS)('blanks {%s} when no param or query carries it', (key) => {
    expect(interpolateLoad(`/api?v={${key}}`, locationWith(), {})).toBe('/api?v=');
  });

  it('control: an ordinary unknown key is blank too', () => {
    expect(interpolateLoad('/api?v={nope}', locationWith(), {})).toBe('/api?v=');
  });
});
