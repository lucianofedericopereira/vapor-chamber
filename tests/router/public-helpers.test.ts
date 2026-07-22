/**
 * The router's exported helpers, tested against their PUBLIC contract.
 *
 * All four are heavily used inside the router, so they were already covered
 * incidentally — but a preset author calls `routerError()` directly (that is
 * how `router-fetch` reports `load_failed`), a Blade shell computes its base
 * with `normalizeBase`/`stripBase`, and `HARD_NAV_CODES` decides whether a
 * failed navigation hands the URL back to the server. Incidental coverage
 * pins none of that: it would stay green while the shape changed underneath.
 */
import { describe, expect, it } from 'vitest';
import { HARD_NAV_CODES, isRouterError, routerError } from '../../src/router/errors';
import { normalizeBase, stripBase } from '../../src/router/history';

describe('routerError — the error constructor presets use', () => {
  it('produces a narrowable RouterError with a machine-readable code', () => {
    const error = routerError('load_failed', 'loader blew up');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('RouterError');
    expect(error.code).toBe('load_failed');
    expect(isRouterError(error)).toBe(true);
    expect(isRouterError(error, 'load_failed')).toBe(true);
    expect(isRouterError(error, 'unmatched')).toBe(false);
  });

  it('prefixes the message so a bare console log identifies the source', () => {
    expect(routerError('unmatched', 'no row').message).toBe('[vapor-chamber-router] no row');
  });

  it('carries `cause` and `to` when supplied, and omits `to` when not', () => {
    const cause = new Error('socket hung up');
    const to = { path: '/items', fullPath: '/items' } as never;
    const withExtras = routerError('load_failed', 'fetch failed', { cause, to });
    expect(withExtras.cause).toBe(cause);
    expect(withExtras.to).toBe(to);
    expect(routerError('aborted', 'guard said no').to).toBeUndefined();
  });

  it('isRouterError rejects plain errors and non-errors', () => {
    expect(isRouterError(new Error('nope'))).toBe(false);
    expect(isRouterError('load_failed')).toBe(false);
    expect(isRouterError(null)).toBe(false);
  });
});

describe('HARD_NAV_CODES — which failures the server gets the last word on', () => {
  it('contains exactly the codes a full page load can recover', () => {
    // Adding or removing a code here silently changes navigation behaviour:
    // members hand the URL to the server, everything else stays client-side.
    expect([...HARD_NAV_CODES].sort()).toEqual(['blade_fetch_failed', 'component_load_failed', 'unmatched']);
  });

  it('excludes normal-flow refusals, which must never hard-navigate', () => {
    for (const code of ['aborted', 'cancelled', 'load_failed', 'missing_param'] as const) {
      expect(HARD_NAV_CODES.has(code)).toBe(false);
    }
  });
});

describe('normalizeBase', () => {
  it('gives a leading slash and no trailing slash', () => {
    expect(normalizeBase('admin')).toBe('/admin');
    expect(normalizeBase('/admin/')).toBe('/admin');
    expect(normalizeBase('/admin')).toBe('/admin');
    expect(normalizeBase('admin/panel/')).toBe('/admin/panel');
  });

  it('collapses root-ish values to the empty base', () => {
    // '' rather than '/', so `base + path` never double-slashes.
    expect(normalizeBase('')).toBe('');
    expect(normalizeBase('/')).toBe('');
  });
});

describe('stripBase', () => {
  it('removes the base and always leaves a rooted path', () => {
    expect(stripBase('/admin/items', '/admin')).toBe('/items');
    expect(stripBase('/admin/', '/admin')).toBe('/');
    expect(stripBase('/admin', '/admin')).toBe('/'); // the base itself, no trailing slash
  });

  it('is a no-op for an empty base', () => {
    expect(stripBase('/items', '')).toBe('/items');
  });

  it('returns null when the path is outside the base', () => {
    // This is what tells link interception "not ours — let the browser have it".
    expect(stripBase('/other/items', '/admin')).toBeNull();
    expect(stripBase('/administrator', '/admin')).toBeNull(); // prefix, not a segment
  });
});
