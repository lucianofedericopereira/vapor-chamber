// A splat comes back decoded and is encoded segment by segment on the way out.
import { describe, expect, it } from 'vitest';
import { createRouteTable } from '@router/table';
import { interpolateLoad } from '@router/loaders';
import type { RouteLocation } from '@router/types';

const table = createRouteTable([
  { name: 'files', path: '/files/*', component: 'F' },
  { name: 'user', path: '/users/:id', component: 'U' },
]);
const at = (params: Record<string, unknown>) => ({ params, query: {}, matched: [] }) as unknown as RouteLocation;

describe('the splat, as resolve, buildPath and interpolateLoad read it', () => {
  it('resolve decodes it segment by segment, as it decodes a param', () => {
    expect(table.resolve('/files/a%20b/c%23d')?.params.pathMatch).toBe('a b/c#d');
    expect(table.resolve('/users/a%20b%23c')?.params.id).toBe('a b#c'); // control
  });

  it('buildPath encodes each segment and keeps the slashes', () => {
    expect(table.buildPath(table.getRecord('files')!, { pathMatch: 'a b/c#d?e%f' })).toBe('/files/a%20b/c%23d%3Fe%25f');
    expect(table.buildPath(table.getRecord('files')!, { pathMatch: 'a/b/c' })).toBe('/files/a/b/c'); // control
  });

  it('a resolved URL builds back to itself', () => {
    const url = '/files/a%20b/c%23d';
    const hit = table.resolve(url)!;
    expect(table.buildPath(hit.record, hit.params)).toBe(url);
  });

  it('interpolateLoad encodes it once and keeps the slashes', () => {
    expect(interpolateLoad('/api/files/{pathMatch}', at({ pathMatch: 'a b/c#d' }), {})).toBe('/api/files/a%20b/c%23d');
    expect(interpolateLoad('/api/users/{id}', at({ id: 'a b/c' }), {})).toBe('/api/users/a%20b%2Fc'); // control: a param is one segment
  });
});

/*
 * RouteTable.resolve's docblock says captured params come back decoded, and a
 * `*` splat is captured as `params.pathMatch`. resolve skipped decoding it,
 * buildPath wrote it raw, and interpolateLoad encoded it whole, slashes
 * included. So no value worked for both a link and a load: decoded, the link
 * broke at `#` or `?`; encoded, the load sent `%2520`; either way the load's
 * slashes went out as `%2F`. The splat is a path, as vue-router reads it:
 * decoded per segment, encoded per segment, `/` kept. Owner report, audit
 * log s36.11.
 */
