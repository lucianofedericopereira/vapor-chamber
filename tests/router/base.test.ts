/**
 * resolveBase and normalizeBase in router/history: where the router mounts, from an explicit url, a prefix and a locale segment.
 * Why: a wrong or unnormalized base makes stripBase match nothing, so an embedded app would render the wrong route; resolveBase must not throw where there is no window (SSR).
 * Shows: an explicit url wins; prefix plus a lower-cased locale, a bare prefix, an outside-prefix path and a missing prefix resolve as listed; with no pathname and no window the base falls back to the prefix or ''; normalizeBase gives one leading slash and no trailing one, and its output is what stripBase matches.
 */
import { describe, expect, it } from 'vitest';
import { normalizeBase, resolveBase, stripBase } from '@router/history';

describe('resolveBase - concept: prefix?, locale?, or explicit baseurl', () => {
  const locales = ['it', 'en'];

  it('explicit url wins outright', () => {
    expect(resolveBase({ url: '/whatever/', prefix: '/admin', locales, pathname: '/admin/it/x' })).toBe('/whatever');
  });

  it('prefix + locale after it', () => {
    expect(resolveBase({ prefix: '/admin', locales, pathname: '/admin/it/catalog' })).toBe('/admin/it');
    expect(resolveBase({ prefix: '/admin', locales, pathname: '/admin/EN/catalog' })).toBe('/admin/en');
  });

  it('locale segment is optional - bare prefix mounts at prefix', () => {
    expect(resolveBase({ prefix: '/admin', locales, pathname: '/admin/catalog' })).toBe('/admin');
    expect(resolveBase({ prefix: '/admin', locales, pathname: '/admin' })).toBe('/admin');
  });

  it('prefix is configurable, never assumed', () => {
    expect(resolveBase({ prefix: 'backend', locales, pathname: '/backend/en/x' })).toBe('/backend/en');
  });

  it('no prefix: URL starts with the locale', () => {
    expect(resolveBase({ locales, pathname: '/en/checkout' })).toBe('/en');
    expect(resolveBase({ locales, pathname: '/checkout' })).toBe('');
  });

  it('outside the prefix still mounts at the prefix', () => {
    expect(resolveBase({ prefix: '/admin', locales, pathname: '/shop/x' })).toBe('/admin');
  });

  // The file has no environment pragma, so it runs under node, where window does not exist.
  describe('no pathname and no window (SSR)', () => {
    it('falls back to an empty pathname rather than throwing on `window`', () => {
      expect(typeof window).toBe('undefined'); // the precondition

      // No pathname to read a locale from: the prefix alone decides.
      expect(resolveBase({ locales })).toBe('');
      expect(resolveBase({ prefix: '/admin', locales })).toBe('/admin');
      expect(resolveBase({})).toBe('');
    });

    it('still lets an explicit url win without consulting the environment', () => {
      expect(resolveBase({ url: '/from-server/' })).toBe('/from-server');
    });
  });
});

describe('one normalizer, not two', () => {
  it('normalizeBase strips a trailing slash whether or not there is a leading one', () => {
    expect(normalizeBase('admin/')).toBe('/admin');
    expect(normalizeBase('/admin/')).toBe('/admin');
    expect(normalizeBase('admin')).toBe('/admin');
    expect(normalizeBase('a/b/')).toBe('/a/b');
    expect(normalizeBase('')).toBe('');
    expect(normalizeBase(undefined)).toBe('');
  });

  it('is the base stripBase can actually match', () => {
    // A base that keeps its trailing slash makes stripBase answer null.
    expect(stripBase('/admin/x', normalizeBase('admin/'))).toBe('/x');
    expect(stripBase('/admin/x', '/admin/')).toBeNull();
  });
});
