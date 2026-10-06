/** A write's answer also invalidates the Location and Content-Location it names, on its own origin (plan 1.27 D4.S5). Rationale at the end. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHttpClient } from '../src/http';

afterEach(() => vi.unstubAllGlobals());

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/** GETs answer their count; a write answers `status` with `headers`. `hold` keeps the next GET open until `release()`. */
function server(status = 201, headers: Record<string, string> = {}) {
  const s = { gets: 0, hold: false, release: () => {} };
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    if ((init?.method ?? 'GET') !== 'GET') return json({ ok: 1 }, status, headers);
    const n = ++s.gets;
    if (s.hold) {
      s.hold = false;
      await new Promise<void>((r) => (s.release = r));
    }
    return json({ v: n });
  });
  return s;
}

const ITEM = 'http://localhost/api/items/1';
const v = (r: { data: unknown }) => (r.data as { v: number }).v;

/** Cache ITEM, POST to the collection, GET ITEM again: the count of GETs. */
async function afterCreate(headers: Record<string, string>, item = ITEM, status = 201) {
  const s = server(status, headers);
  const http = createHttpClient();
  await http.get(item, { cache: true });
  await http.post('http://localhost/api/items', { name: 'x' }).catch(() => {});
  await http.get(item, { cache: true });
  return s.gets;
}

describe('a write answer names a URI on its origin: it is invalidated', () => {
  it('Location, absolute', async () => {
    expect(await afterCreate({ location: ITEM })).toBe(2);
  });

  it('Location, relative to the target', async () => {
    expect(await afterCreate({ location: '/api/items/1' })).toBe(2);
    expect(await afterCreate({ location: 'items/1' })).toBe(2);
  });

  it('Content-Location', async () => {
    expect(await afterCreate({ 'content-location': '/api/items/1' })).toBe(2);
  });

  it('a fragment names the same resource', async () => {
    expect(await afterCreate({ location: '/api/items/1#top' })).toBe(2);
  });

  it('a cached relative URL, against the page the client runs on', async () => {
    vi.stubGlobal('location', { href: 'http://localhost/app/page' });
    const s = server(201, { location: '/api/items/1' });
    const http = createHttpClient();
    await http.get('/api/items/1', { cache: true });
    await http.post('/api/items', { name: 'x' });
    await http.get('/api/items/1', { cache: true });
    expect(s.gets).toBe(2);
  });

  it('a read in flight is not joined after the write', async () => {
    const s = server(201, { location: ITEM });
    const http = createHttpClient();
    s.hold = true;
    const first = http.get(ITEM);
    await new Promise((r) => setTimeout(r, 0));
    await http.post('http://localhost/api/items', { name: 'x' });
    const second = http.get(ITEM);
    s.release();
    const [, b] = await Promise.all([first, second]);
    expect([s.gets, v(b)]).toEqual([2, 2]);
  });
});

describe('controls', () => {
  it('no Location: the cache serves the entry', async () => {
    expect(await afterCreate({})).toBe(1);
  });

  it('a Location on another origin: its entry stays (RFC 9111 MUST NOT)', async () => {
    expect(await afterCreate({ location: 'http://other.example/api/items/1' }, 'http://other.example/api/items/1')).toBe(1);
  });

  it('a failed write invalidates nothing, Location or not', async () => {
    expect(await afterCreate({ location: ITEM }, ITEM, 422)).toBe(1);
  });

  it('no base outside a browser: a relative write keeps the target-only match', async () => {
    const s = server(201, { location: '/api/items/1' });
    const http = createHttpClient();
    await http.get('/api/items/1', { cache: true });
    await http.post('/api/items', { name: 'x' });
    await http.get('/api/items/1', { cache: true });
    expect(s.gets).toBe(1);
  });

  it('a read in flight with no Location in the answer is still joined', async () => {
    const s = server(201, {});
    const http = createHttpClient();
    s.hold = true;
    const first = http.get(ITEM);
    await new Promise((r) => setTimeout(r, 0));
    await http.post('http://localhost/api/items', { name: 'x' });
    const second = http.get(ITEM);
    s.release();
    await Promise.all([first, second]);
    expect(s.gets).toBe(1);
  });
});

/*
 * RFC 9111 4.4: a cache MUST invalidate the target URI on a non-error answer
 * to an unsafe method (the client did, tests/http-cache-writes.test.ts), and
 * MAY invalidate the URIs in Location and Content-Location, but MUST NOT when
 * their origin differs from the target's ("This helps prevent
 * denial-of-service attacks"). A POST that creates /api/items/1 and says so
 * in Location left a cached GET of it answering from before (audit S5, probe
 * L2). A relative value resolves against the target URI (RFC 9110 10.2.2,
 * 8.7); a cached relative URL against the base fetch itself uses. Outside a
 * browser there is no base and fetch refuses a relative URL, so only the
 * released target match applies there. The matcher is the one invalidation
 * already uses for entries, read tickets and reads in flight (log s35.169),
 * so a named URI is treated exactly like the target. Log s35.187.
 */
