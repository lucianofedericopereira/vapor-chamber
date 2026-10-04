/** The HTTP client's cache against an invalidation and a write. The long note is at the end. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHttpClient } from '../src/http';

afterEach(() => vi.unstubAllGlobals());

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A server holding one value per URL; `hold` keeps the next GET open until `release()`. */
function server() {
  const s = { values: new Map<string, string>(), gets: 0, writes: 0, writeStatus: 200, hold: false, release: () => {} };
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method !== 'GET') {
      s.writes++;
      if (s.writeStatus < 400) s.values.set(url, 'new');
      return json({ ok: 1 }, s.writeStatus);
    }
    s.gets++;
    const answer = s.values.get(url) ?? 'old';
    if (s.hold) {
      s.hold = false;
      await new Promise<void>((r) => (s.release = r));
    }
    return json({ v: answer });
  });
  return s;
}
const v = (r: { data: unknown }) => (r.data as { v: string }).v;

describe('invalidateCache against a read in flight', () => {
  it('control: with nothing in flight, the next read fetches', async () => {
    const s = server();
    const http = createHttpClient();
    await http.get('/a', { cache: true });
    s.values.set('/a', 'new');
    http.invalidateCache('/a');
    expect(v(await http.get('/a', { cache: true }))).toBe('new');
    expect(s.gets).toBe(2);
  });

  it('a read out before the invalidation is returned, not stored; a read after it fetches', async () => {
    const s = server();
    const http = createHttpClient();
    s.hold = true;
    const first = http.get('/a', { cache: true });
    await new Promise((r) => setTimeout(r, 0));
    s.values.set('/a', 'new');
    http.invalidateCache('/a');
    const second = http.get('/a', { cache: true });
    s.release();
    const [a, b] = await Promise.all([first, second]);
    expect([v(a), v(b)]).toEqual(['old', 'new']);
    expect(s.gets).toBe(2);
    expect(v(await http.get('/a', { cache: true }))).toBe('new');
    expect(s.gets).toBe(2);
  });

  it('clearCache() is an invalidation of everything: the same rule', async () => {
    const s = server();
    const http = createHttpClient();
    s.hold = true;
    const first = http.get('/a', { cache: true });
    await new Promise((r) => setTimeout(r, 0));
    s.values.set('/a', 'new');
    http.clearCache();
    const second = http.get('/a', { cache: true });
    s.release();
    const [a, b] = await Promise.all([first, second]);
    expect([v(a), v(b)]).toEqual(['old', 'new']);
    expect(v(await http.get('/a', { cache: true }))).toBe('new');
    expect(s.gets).toBe(2);
  });

  it('a read out before an invalidation of another URL is returned and stored', async () => {
    const s = server();
    const http = createHttpClient();
    s.hold = true;
    const first = http.get('/a', { cache: true });
    await new Promise((r) => setTimeout(r, 0));
    http.invalidateCache('/b');
    s.release();
    expect(v(await first)).toBe('old');
    await http.get('/a', { cache: true });
    expect(s.gets).toBe(1);
  });
});

describe('a successful unsafe request invalidates exactly its URL', () => {
  it('control: the cache serves a second GET from memory', async () => {
    const s = server();
    const http = createHttpClient();
    await http.get('/cart/1', { cache: true });
    await http.get('/cart/1', { cache: true });
    expect(s.gets).toBe(1);
  });

  for (const method of ['post', 'put', 'patch', 'delete'] as const) {
    it(`${method}: the next GET of its URL fetches; another URL stays cached`, async () => {
      const s = server();
      const http = createHttpClient();
      await http.get('/cart/1', { cache: true });
      await http.get('/cart/12', { cache: true });
      if (method === 'delete') await http.delete('/cart/1');
      else await http[method]('/cart/1', { n: 1 });
      expect(v(await http.get('/cart/1', { cache: true }))).toBe('new');
      await http.get('/cart/12', { cache: true });
      expect(s.gets).toBe(3);
    });
  }

  it('a failed write invalidates nothing', async () => {
    const s = server();
    s.writeStatus = 422;
    const http = createHttpClient();
    await http.get('/cart/1', { cache: true });
    await expect(http.put('/cart/1', { n: 1 })).rejects.toThrow();
    expect(v(await http.get('/cart/1', { cache: true }))).toBe('old');
    expect(s.gets).toBe(1);
  });
});

/*
 * External items 10 and 11 of the 1.26 evaluation (log s35.41).
 *
 * Item 10. The client stored a response when it landed, whatever happened
 * while it was on the wire, and `invalidateCache` did not touch the dedupe
 * map. A read in flight across an invalidation therefore undid it twice: a
 * read made after the invalidation joined the old request, and the old
 * answer was stored when it landed. `invalidateCache` now drops the matching
 * in-flight keys, and a response is stored only if no invalidation of ITS
 * URL happened while it was on the wire; it is still returned to its callers
 * either way. `clearCache()` had the same bug (found fixing this one: it kept
 * the in-flight keys on purpose) and now follows the same rule.
 * The first shape of the fix kept one invalidation generation per client, so
 * an invalidation of `/b`, or any write that resolved, also kept a read of
 * `/a` in flight from being stored: one extra fetch, never stale data, but on
 * every overlapping read of an app that writes often. The perf-1.26 audit
 * replaced it with a ticket per cacheable read, marked only by an
 * invalidation that matches its URL (the third test here, and
 * tests/http-cache-unrelated-invalidation.test.ts).
 *
 * Item 11. A write did not invalidate its own URL, so a cached GET kept
 * answering the value from before it. RFC 9111 section 4.4: a cache
 * invalidates the target URI on a non-error response to an unsafe method.
 * Only a 2xx reaches the point where the client stores responses (a non-ok
 * response is thrown by the retry loop, and fetch follows a 3xx), so the
 * rule is "a write that resolved". The match is the exact URL, not the
 * substring `invalidateCache('/cart/1')` would take, so `/cart/12` stays.
 */
