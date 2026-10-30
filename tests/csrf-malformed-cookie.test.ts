/**
 * A malformed XSRF-TOKEN cookie reads as no cookie: the next source answers, nothing throws.
 * Why: a value that is not percent-encoding is no token to send, and decoding it must not throw out of every csrf request before anything goes.
 * Shows: a lone or cut escape does not throw and the hidden input answers, or no token at all; a well-formed cookie decodes and goes as X-XSRF-TOKEN.
 * See: audit HT-24.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { invalidateCsrfCache, readCsrfToken } from '../src/http';

/** A document with this cookie string and, optionally, a hidden `_token` input. */
function page(cookie: string, input?: string): void {
  vi.stubGlobal('document', {
    cookie,
    querySelector: (sel: string) => (sel === 'input[name="_token"]' && input ? { value: input } : null),
  });
  invalidateCsrfCache();
}

afterEach(() => { vi.unstubAllGlobals(); invalidateCsrfCache(); });

describe('a malformed XSRF-TOKEN cookie', () => {
  it('does not throw, and the hidden input answers', () => {
    page('XSRF-TOKEN=%', 'from-input');
    expect(readCsrfToken()).toEqual({ token: 'from-input', headerName: 'X-CSRF-TOKEN' });
  });

  it('with no other source, reads as no token', () => {
    page('XSRF-TOKEN=%E0%A4%A');
    expect(readCsrfToken()).toBeNull();
  });

  it('control: a well-formed cookie is decoded and sent as X-XSRF-TOKEN', () => {
    page('XSRF-TOKEN=ok%20token', 'from-input');
    expect(readCsrfToken()).toEqual({ token: 'ok token', headerName: 'X-XSRF-TOKEN' });
  });
});
