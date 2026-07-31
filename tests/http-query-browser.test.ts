// @vitest-environment happy-dom
/**
 * Covers src/http-query.ts's browser-path branches (lines 28-29). Every other
 * caller of buildFullUrl runs in the plain 'node' vitest environment (no
 * `window`), so both ternaries there only ever took their SSR-fallback side:
 *   - `typeof window !== 'undefined' ? window.location.origin : ...` — the
 *     `window` global was never actually defined anywhere else.
 *   - `url.startsWith('http') ? undefined : origin` — every existing call
 *     passes a relative path, never an already-absolute URL.
 */
import { describe, it, expect } from 'vitest';
import { buildFullUrl } from '../src/http-query';

describe('buildFullUrl — browser environment (window defined)', () => {
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
