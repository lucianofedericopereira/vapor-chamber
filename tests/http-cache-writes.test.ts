/**
 * The HTTP client's cache against an invalidation and a write.
 * Why: a read in flight across an invalidation would store its old answer on landing (and a later read would join it), and a write that left its own URL cached would keep answering the value from before it.
 * Shows: a read out before an invalidation of its URL (a write or clearCache()) is returned but not stored while a later read fetches; a write to another URL leaves it stored; a successful post, put, patch or delete invalidates exactly its URL (not /cart/12 for /cart/1); a failed write invalidates nothing.
 * See: log s35.41, RFC 9111 section 4.4, tests/http-cache-unrelated-invalidation.test.ts.
 */
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

describe('an invalidation (a write) against a read in flight', () => {
  it('control: with nothing in flight, the next read fetches', async () => {
    const s = server();
    const http = createHttpClient();
    await http.get('/a', { cache: true });
    s.values.set('/a', 'new');
    await http.post('/a', {});
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
    await http.post('/a', {});
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

  it('a read out before a write to another URL is returned and stored', async () => {
    const s = server();
    const http = createHttpClient();
    s.hold = true;
    const first = http.get('/a', { cache: true });
    await new Promise((r) => setTimeout(r, 0));
    await http.post('/b', {});
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
