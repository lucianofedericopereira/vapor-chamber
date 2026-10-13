/** A malformed XSRF-TOKEN cookie reads as no cookie: the next source answers, nothing throws (audit HT-24). Note at the end. */
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

/*
 * Found by the release audit (row HT-24). The cookie was decoded with a bare
 * decodeURIComponent, so a value that is not percent-encoding (a lone `%`,
 * a cut multi-byte sequence) threw URIError out of every `csrf: true` request,
 * postCommand and the client alike, before anything was sent (probe on dist,
 * scratchpad probe-ht24.mjs). A value the client cannot decode is not a token
 * it can send, so it reads as no cookie and the read goes on to the next
 * source, as it does when the cookie is absent. A server then answers 419 for
 * a missing token, and the 419 refresh sets a fresh cookie.
 */
