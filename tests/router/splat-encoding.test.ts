/**
 * A `*` splat (`params.pathMatch`) is decoded segment by segment by resolve and encoded segment by segment, slashes kept, by buildPath and interpolateLoad.
 * Why: if the splat were decoded or encoded as a whole, no value would work for both a link and a load: a link would break at `#` or `?`, and a load would send its slashes as `%2F` or double-encode.
 * Shows: resolve decodes `a%20b/c%23d` to `a b/c#d`; buildPath encodes `a b/c#d?e%f` per segment and keeps slashes; a resolved URL builds back to itself; interpolateLoad encodes the splat once with slashes kept, while a param stays one encoded segment.
 * See: log s36.11
 */
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
