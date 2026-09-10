import { describe, expect, it } from 'vitest';
import { normalizeBase, resolveBase, stripBase } from '../../src/router/history';

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

  // Every case above supplies `pathname` explicitly, so the `??` fallback -
  // and specifically its no-`window` arm - was never taken. This file has no
  // `@vitest-environment` docblock, so it runs under the default `node`
  // environment where `window` genuinely does not exist: the SSR shape.
  describe('no pathname and no window (SSR)', () => {
    it('falls back to an empty pathname rather than throwing on `window`', () => {
      expect(typeof window).toBe('undefined'); // pin the precondition

      // Nothing to read a locale from, so the prefix alone decides the base.
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
    // index.ts carried a private lookalike that returned `/${base}` unchanged
    // when the base had no leading slash - so `'admin/'` normalized to
    // `/admin/` there and `/admin` here. The memory-history fallback stripped
    // with one and stored the other.
    expect(normalizeBase('admin/')).toBe('/admin');
    expect(normalizeBase('/admin/')).toBe('/admin');
    expect(normalizeBase('admin')).toBe('/admin');
    expect(normalizeBase('a/b/')).toBe('/a/b');
    expect(normalizeBase('')).toBe('');
    expect(normalizeBase(undefined)).toBe('');
  });

  it('is the base stripBase can actually match', () => {
    // The consequence of the divergence, stated directly: the lookalike's
    // output made stripBase answer null, and the fallback seeded '/' - an
    // embedded preview rendering the wrong route.
    expect(stripBase('/admin/x', normalizeBase('admin/'))).toBe('/x');
    expect(stripBase('/admin/x', '/admin/')).toBeNull();
  });
});
