/**
 * The HTTP client's cache and in-flight dedupe key a response by the request headers as well as the URL.
 * Why: headers such as Authorization and Accept-Language change the answer, so a key on the URL alone would serve one user's /me to another or Italian copy to an English request.
 * Shows: different Authorization or Accept-Language values fetch separately, the same headers hit the cache, header order and case do not matter (cache and in-flight), and a write to the URL drops every header variant.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHttpClient } from '../src/http';

function stubEcho() {
  let fetches = 0;
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    fetches++;
    const h = new Headers(init.headers);
    return new Response(JSON.stringify({ who: h.get('Authorization'), lang: h.get('Accept-Language'), n: fetches }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
  return () => fetches;
}
afterEach(() => { vi.unstubAllGlobals(); });

describe('http cache - request headers are part of the key', () => {
  it("never serves one Authorization's answer to another", async () => {
    stubEcho();
    const http = createHttpClient({ baseURL: 'https://api.test' });
    const alice = await http.get('/me', { cache: true, headers: { Authorization: 'Bearer alice' } });
    const bob = await http.get('/me', { cache: true, headers: { Authorization: 'Bearer bob' } });
    expect((alice.data as any).who).toBe('Bearer alice');
    expect((bob.data as any).who).toBe('Bearer bob');
  });

  it('keys a language switch apart', async () => {
    stubEcho();
    const http = createHttpClient({ baseURL: 'https://api.test' });
    await http.get('/products', { cache: true, headers: { 'Accept-Language': 'it' } });
    const en = await http.get('/products', { cache: true, headers: { 'Accept-Language': 'en' } });
    expect((en.data as any).lang).toBe('en');
  });

  it('still hits for the same URL and headers', async () => {
    const fetches = stubEcho();
    const http = createHttpClient({ baseURL: 'https://api.test' });
    await http.get('/me', { cache: true, headers: { Authorization: 'Bearer alice' } });
    await http.get('/me', { cache: true, headers: { Authorization: 'Bearer alice' } });
    expect(fetches()).toBe(1);
  });

  it('keys the same headers alike in any order or case (one request on the wire)', async () => {
    const fetches = stubEcho();
    const http = createHttpClient({ baseURL: 'https://api.test' });
    await http.get('/me', { cache: true, headers: { Authorization: 'Bearer alice', 'Accept-Language': 'en' } });
    await http.get('/me', { cache: true, headers: { 'accept-language': 'en', authorization: 'Bearer alice' } });
    expect(fetches()).toBe(1);
    // Control: another value is another request.
    await http.get('/me', { cache: true, headers: { authorization: 'Bearer alice', 'accept-language': 'it' } });
    expect(fetches()).toBe(2);
  });

  it('shares one read in flight for the same headers in another order or case', async () => {
    const fetches = stubEcho();
    const http = createHttpClient({ baseURL: 'https://api.test' });
    await Promise.all([
      http.get('/me', { headers: { Authorization: 'Bearer alice', 'Accept-Language': 'en' } }),
      http.get('/me', { headers: { 'accept-language': 'en', AUTHORIZATION: 'Bearer alice' } }),
    ]);
    expect(fetches()).toBe(1);
  });

  it('a write to the URL drops every header variant', async () => {
    const fetches = stubEcho();
    const http = createHttpClient({ baseURL: 'https://api.test' });
    await http.get('/me', { cache: true, headers: { Authorization: 'Bearer alice' } });
    await http.get('/me', { cache: true, headers: { Authorization: 'Bearer bob' } });
    await http.post('/me', {});
    await http.get('/me', { cache: true, headers: { Authorization: 'Bearer alice' } });
    await http.get('/me', { cache: true, headers: { Authorization: 'Bearer bob' } });
    expect(fetches()).toBe(5);
  });
});
