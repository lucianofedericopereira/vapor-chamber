/**
 * FIXTURE: a 419 on a page whose `<meta name="csrf-token">` has gone stale.
 * Why: the meta token is rendered once per page and goes stale when the session rotates; Laravel reads X-CSRF-TOKEN first, so the fresh cookie must be the only csrf header.
 * Shows: the retry carries the fresh X-XSRF-TOKEN and no stale X-CSRF-TOKEN; a meta-only page refreshes from the DOM; with no document, transport:missing:csrf, no crash.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invalidateCsrfCache, postCommand } from '../src/http';

function mockResponse(status: number) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { entries: () => [], get: () => null },
    json: async () => ({}), text: async () => JSON.stringify(({})),
  };
}

describe('postCommand - 419 refresh uses the fresh cookie as the only csrf header', () => {
  let cookie: string;
  let sent: Array<Record<string, string>>;

  beforeEach(() => {
    invalidateCsrfCache();
    cookie = 'XSRF-TOKEN=stale-cookie';
    sent = [];
    vi.stubGlobal('document', {
      querySelector: (sel: string) =>
        sel === 'meta[name="csrf-token"]' ? { content: 'stale-meta-token' } : null,
      get cookie() {
        return cookie;
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    invalidateCsrfCache();
  });

  /** A fetch that 419s the first POST, refreshes the cookie, then 200s; snapshots headers, as postCommand reuses one object across the retry. */
  function stubFetch() {
    let posts = 0;
    const fetchMock = vi.fn((url: string, init: { headers?: Record<string, string> }) => {
      if (url === '/sanctum/csrf-cookie') {
        cookie = 'XSRF-TOKEN=fresh-cookie-token'; // Laravel's Set-Cookie on the refresh
        return Promise.resolve(mockResponse(200));
      }
      posts++;
      sent.push({ ...(init.headers ?? {}) });
      return Promise.resolve(mockResponse(posts === 1 ? 419 : 200));
    });
    vi.stubGlobal('fetch', fetchMock);
  }

  it('retries with the fresh X-XSRF-TOKEN and drops the stale X-CSRF-TOKEN', async () => {
    stubFetch();
    // csrf on drives the refresh path; the initial request carries the stale
    // meta token under X-CSRF-TOKEN (readCsrfToken reads the meta tag first).
    const res = await postCommand('/api/cmd', { a: 1 }, { retry: false, csrf: true });
    expect(res.ok).toBe(true);
    expect(sent).toHaveLength(2);

    // The initial request carried the stale meta token.
    expect(sent[0]['X-CSRF-TOKEN']).toBe('stale-meta-token');
    // The retry carries the fresh cookie token, and ONLY it - the stale
    // X-CSRF-TOKEN, which Laravel would read first, is gone.
    expect(sent[1]['X-XSRF-TOKEN']).toBe('fresh-cookie-token');
    expect(sent[1]['X-CSRF-TOKEN']).toBeUndefined();
  });

  it('a meta-only page (no cookie) still refreshes from the DOM', async () => {
    cookie = '';
    let posts = 0;
    const fetchMock = vi.fn((url: string, init: { headers?: Record<string, string> }) => {
      if (url === '/sanctum/csrf-cookie') return Promise.resolve(mockResponse(200));
      posts++;
      sent.push({ ...(init.headers ?? {}) });
      return Promise.resolve(mockResponse(posts === 1 ? 419 : 200));
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await postCommand('/api/cmd', {}, { retry: false, csrf: true });
    expect(res.ok).toBe(true);
    expect(sent[1]['X-CSRF-TOKEN']).toBe('stale-meta-token');
  });
});

describe('postCommand - 419 refresh with no document (a server)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    invalidateCsrfCache();
  });

  it('does not crash when document is undefined and there is no cookie', async () => {
    // A 419 on a server: readCsrfFromCookie guards `typeof document`, and the
    // fallback is readCsrfToken (also guarded), so nothing touches
    // document.querySelector. refreshCsrfOnce then throws "no token found".
    invalidateCsrfCache();
    vi.stubGlobal('document', undefined);
    let posts = 0;
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url === '/sanctum/csrf-cookie') return Promise.resolve(mockResponse(200));
      posts++;
      return Promise.resolve(mockResponse(posts === 1 ? 419 : 200));
    }));
    await expect(postCommand('/api/cmd', {}, { retry: false, csrf: true })).rejects.toMatchObject({ code: 'transport:missing:csrf' });
  });
});
