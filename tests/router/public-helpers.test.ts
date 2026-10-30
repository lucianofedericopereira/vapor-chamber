/**
 * The router's exported helpers (routerError, isRouterError, HARD_NAV_CODES, normalizeBase, stripBase), against their public contract.
 * Why: a preset author calls routerError() directly, a Blade shell computes its base with normalizeBase/stripBase, and HARD_NAV_CODES decides whether a failed navigation hands the URL to the server; a changed shape would break them without failing the router's own tests.
 * Shows: routerError builds a narrowable error with code, cause and to; isRouterError rejects look-alikes; HARD_NAV_CODES is exactly the recoverable set; the base helpers normalise and strip as specified.
 * See: tests/router/router-codes.test.ts
 */
import { describe, expect, it } from 'vitest';
import { BusError } from '../../src/failure';
import { HARD_NAV_CODES, isRouterError, routerError } from '@router/errors';
import { normalizeBase, stripBase } from '@router/history';

describe('routerError - the error constructor presets use', () => {
  it('produces a narrowable RouterError with a machine-readable code', () => {
    const error = routerError('failed:loader', 'loader blew up');
    expect(error).toBeInstanceOf(BusError);
    expect(error.name).toBe('BusError');
    expect(error.code).toBe('router:failed:loader');
    expect(isRouterError(error)).toBe(true);
    expect(isRouterError(error, 'router:failed:loader')).toBe(true);
    expect(isRouterError(error, 'router:missing:route')).toBe(false);
  });

  it('the code names the source, so the message carries no prefix', () => {
    const error = routerError('missing:route', 'no row');
    expect(error.message).toBe('no row');
    expect(error.code).toBe('router:missing:route');
  });

  it('carries `cause` and `to` when supplied, and omits `to` when not', () => {
    const cause = new Error('socket hung up');
    const to = { path: '/items', fullPath: '/items' } as never;
    const withExtras = routerError('failed:loader', 'fetch failed', { cause, to });
    expect(withExtras.cause).toBe(cause);
    expect(withExtras.context?.to).toBe(to);
    expect(routerError('refused:guard', 'guard said no').context).toBeUndefined();
  });

  it('isRouterError rejects plain errors and non-errors', () => {
    expect(isRouterError(new Error('nope'))).toBe(false);
    expect(isRouterError('router:failed:loader')).toBe(false);
    expect(isRouterError({ code: 'router:failed:loader', name: 'BusError' })).toBe(false);
    expect(isRouterError(null)).toBe(false);
  });
});

describe('HARD_NAV_CODES - which failures the server gets the last word on', () => {
  it('contains exactly the codes a full page load can recover', () => {
    // Members hand the URL to the server, everything else stays client-side; the rule is a route, component or server HTML missing or failed.
    expect([...HARD_NAV_CODES].sort()).toEqual(['router:failed:blade', 'router:failed:component', 'router:missing:component', 'router:missing:route']);
  });

  it('excludes normal-flow refusals, which must never hard-navigate', () => {
    for (const code of ['router:refused:guard', 'router:aborted:navigation', 'router:failed:guard', 'router:exceeded:redirects', 'router:failed:loader', 'router:missing:param'] as const) {
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
    // '' rather than '/' so `base + path` never double-slashes.
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
    // null tells link interception to leave the link to the browser.
    expect(stripBase('/other/items', '/admin')).toBeNull();
    expect(stripBase('/administrator', '/admin')).toBeNull(); // prefix, not a segment
  });
});
