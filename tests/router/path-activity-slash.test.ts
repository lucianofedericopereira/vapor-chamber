/**
 * `pathActivity` on an empty path, the root, and a path with and without its trailing slash.
 * Why: a link and the current path that differ only by a trailing slash must read as the same page, or a menu loses its active item.
 * Shows: `''` reads as `/`, `/a/` as `/a`, and `/` stays no prefix of another path; the empty path is the only test reaching that arm of `noTrailingSlash`.
 */
import { describe, expect, it } from 'vitest';
import { pathActivity } from '../../src/router/url';

describe('pathActivity: the trailing slash', () => {
  it('reads an empty path as the root, and the root as itself', () => {
    expect(pathActivity('', '/')).toEqual({ exact: true, active: true });
    expect(pathActivity('/', '')).toEqual({ exact: true, active: true });
    expect(pathActivity('/', '/a')).toEqual({ exact: false, active: false });
  });

  it('reads /a/ and /a as one path', () => {
    expect(pathActivity('/a/', '/a')).toEqual({ exact: true, active: true });
    expect(pathActivity('/a', '/a/')).toEqual({ exact: true, active: true });
    expect(pathActivity('/a/', '/a/b')).toEqual({ exact: false, active: true });
  });
});
