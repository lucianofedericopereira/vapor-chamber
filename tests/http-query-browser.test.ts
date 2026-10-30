// @vitest-environment happy-dom
/**
 * buildFullUrl in src/http-query.ts when `window` is defined (happy-dom).
 * Why: in a browser a relative URL would resolve against the wrong origin, or an absolute URL would get the page origin prepended. Also the only file reaching the `window` arm of buildFullUrl, so the 100% floor needs it.
 * Shows: a relative path starts with window.location.origin and carries the query; an absolute URL is kept as given and carries the query.
 */
import { describe, it, expect } from 'vitest';
import { buildFullUrl } from '../src/http-query';

describe('buildFullUrl - browser environment (window defined)', () => {
  it('resolves relative URLs against window.location.origin', () => {
    const url = buildFullUrl('/api/search', undefined, { q: 'coffee' });
    expect(url.startsWith(window.location.origin)).toBe(true);
    expect(new URL(url).searchParams.get('q')).toBe('coffee');
  });

  it('does not need an origin when the URL is already absolute', () => {
    const url = buildFullUrl('http://api.example.com/search', undefined, { q: 'tea' });
    expect(url.startsWith('http://api.example.com/search')).toBe(true);
    expect(new URL(url).searchParams.get('q')).toBe('tea');
  });
});
