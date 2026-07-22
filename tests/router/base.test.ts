import { describe, expect, it } from 'vitest';
import { resolveBase } from '../../src/router/history';

describe('resolveBase — concept: prefix?, locale?, or explicit baseurl', () => {
  const locales = ['it', 'en'];

  it('explicit url wins outright', () => {
    expect(resolveBase({ url: '/whatever/', prefix: '/admin', locales, pathname: '/admin/it/x' })).toBe('/whatever');
  });

  it('prefix + locale after it', () => {
    expect(resolveBase({ prefix: '/admin', locales, pathname: '/admin/it/catalog' })).toBe('/admin/it');
    expect(resolveBase({ prefix: '/admin', locales, pathname: '/admin/EN/catalog' })).toBe('/admin/en');
  });

  it('locale segment is optional — bare prefix mounts at prefix', () => {
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
});
