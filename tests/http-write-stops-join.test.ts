/** A write's invalidation stops new reads joining an older read still on the wire (plan 1.27 section 10.7). Rationale at the end. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHttpClient } from '../src/http';

afterEach(() => { vi.unstubAllGlobals(); });

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

/** Each GET answers its own number after 30 ms; a write answers at once. Returns the GET count. */
function backend() {
  let gets = 0;
  vi.stubGlobal('fetch', (_url: string, init: { method?: string }) => {
    if ((init.method ?? 'GET') === 'GET') {
      const n = ++gets;
      return new Promise((r) => setTimeout(() => r(json({ v: n })), 30));
    }
    return Promise.resolve(json({ saved: true }));
  });
  return () => gets;
}

/** GET, then `between`, then GET again while the first is on the wire. */
async function readAround(between: (http: ReturnType<typeof createHttpClient>) => Promise<unknown> | void, url = '/api/a') {
  const gets = backend();
  const http = createHttpClient();
  const first = http.get(url);
  await between(http);
  const second = http.get(url);
  const [, r] = await Promise.all([first, second]);
  return { gets: gets(), second: (r.data as { v: number }).v };
}

describe('a write to the URL', () => {
  it('stops a later GET joining the read from before it', async () => {
    expect(await readAround((h) => h.post('/api/a', { x: 1 }))).toEqual({ gets: 2, second: 2 });
  });

  it('with request headers in the key too', async () => {
    const gets = backend();
    const http = createHttpClient({ headers: { 'Accept-Language': 'it' } });
    const first = http.get('/api/a');
    await http.put('/api/a', { x: 1 });
    const second = http.get('/api/a');
    const [, r] = await Promise.all([first, second]);
    expect([gets(), (r.data as { v: number }).v]).toEqual([2, 2]);
  });
});

describe('controls', () => {
  it('with nothing in between, the second GET joins the first', async () => {
    expect(await readAround(() => {})).toEqual({ gets: 1, second: 1 });
  });

  it('invalidateCache with a substring or a RegExp stops the join', async () => {
    expect(await readAround((h) => h.invalidateCache('/api/a'))).toEqual({ gets: 2, second: 2 });
    expect(await readAround((h) => h.invalidateCache(/^\/api\/a$/))).toEqual({ gets: 2, second: 2 });
  });

  it('a write to another URL leaves the join', async () => {
    expect(await readAround((h) => h.post('/api/b', { x: 1 }))).toEqual({ gets: 1, second: 1 });
  });

  it('two reads with different headers stay apart', async () => {
    const gets = backend();
    const http = createHttpClient();
    await Promise.all([http.get('/api/a'), http.get('/api/a', { headers: { 'If-None-Match': '"e1"' } })]);
    expect(gets()).toBe(2);
  });
});

/*
 * http-cache: "A read made after this must not join one already on the
 * wire, which may answer from before"; RFC 9111 4.4 makes the target URI's
 * invalidation a MUST. The dedupe key became
 * `method:responseType:[304:]JSON(headers):fullUrl` (request headers change
 * the answer), but the invalidation still parsed the URL after the key's
 * second `:`, the old format, so a write's exact-URL match never found the
 * read in flight and a GET made after the write joined it (audit B11, D8).
 * The in-flight entry now records its URL beside the promise, and the
 * invalidation matches that URL. Log s35.169.
 */
