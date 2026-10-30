/**
 * `cacheMode` on the HTTP client's own store: no-cache validates, reload reads past the copy, no-store skips the store.
 * Why: if the store ignored cacheMode, a read that must be current (a router refresh) could not say so and would get a fresh stored copy.
 * Shows: with a fresh copy, no-cache sends its ETag and a 304 answers the stored copy, a changed answer is read and stored, reload sends no ETag and stores, no-store neither reads nor stores, and no-cache with nothing stored or no ETag sends a plain request.
 * See: audit M2, WHATWG Fetch (cache mode).
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHttpClient } from '../src/http';

/** `/e` answers `{ v }` with ETag "e<v>" and a 304 on a match; `/plain` has no ETag. */
const s = { v: 1, sent: [] as Array<string | undefined> };
let server: Server;
let base = '';
beforeAll(async () => {
  server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const inm = req.headers['if-none-match'];
      s.sent.push(inm);
      const tag = `"e${s.v}"`;
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (req.url !== '/plain') headers.etag = tag;
      if (req.url !== '/plain' && inm === tag) {
        res.writeHead(304, headers);
        res.end();
        return;
      }
      res.writeHead(200, headers);
      res.end(JSON.stringify({ v: s.v }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => { Object.assign(s, { v: 1, sent: [] }); });

const fresh = { cache: { ttl: 60_000 } };

describe("cacheMode over the client's own store", () => {
  it('control: a fresh stored copy answers with nothing sent', async () => {
    const http = createHttpClient({ baseURL: base });
    await http.get('/e', fresh);
    await http.get('/e', fresh);
    expect(s.sent).toEqual([undefined]);
  });

  it("no-cache asks the server with the copy's ETag; a 304 answers the stored copy", async () => {
    const http = createHttpClient({ baseURL: base });
    const first = await http.get<{ v: number }>('/e', fresh);
    const again = await http.get<{ v: number }>('/e', { ...fresh, cacheMode: 'no-cache' });
    expect({ sent: s.sent, same: again.data === first.data, stale: again.stale }).toEqual({ sent: [undefined, '"e1"'], same: true, stale: undefined });
  });

  it('no-cache reads a changed answer and stores it', async () => {
    const http = createHttpClient({ baseURL: base });
    await http.get('/e', fresh);
    s.v = 2;
    const changed = await http.get<{ v: number }>('/e', { ...fresh, cacheMode: 'no-cache' });
    const next = await http.get<{ v: number }>('/e', fresh);
    expect({ changed: changed.data.v, next: next.data.v, sent: s.sent.length }).toEqual({ changed: 2, next: 2, sent: 2 });
  });

  it('a 304 to a no-cache read the cache was cleared across answers the copy but does not store it again', async () => {
    const http = createHttpClient({ baseURL: base });
    const first = await http.get<{ v: number }>('/e', fresh);
    const refresh = http.get<{ v: number }>('/e', { ...fresh, cacheMode: 'no-cache' });
    http.clearCache();
    const answered = await refresh;
    await http.get('/e', fresh);
    // The third read finds nothing stored, so it sends no ETag.
    expect({ same: answered.data === first.data, sent: s.sent }).toEqual({ same: true, sent: [undefined, '"e1"', undefined] });
  });

  it('reload reads past the copy without its ETag and stores the answer', async () => {
    const http = createHttpClient({ baseURL: base });
    await http.get('/e', fresh);
    s.v = 2;
    const read = await http.get<{ v: number }>('/e', { ...fresh, cacheMode: 'reload' });
    const next = await http.get<{ v: number }>('/e', fresh);
    expect({ sent: s.sent, read: read.data.v, next: next.data.v }).toEqual({ sent: [undefined, undefined], read: 2, next: 2 });
  });

  it('no-store neither reads nor stores', async () => {
    const http = createHttpClient({ baseURL: base });
    await http.get('/e', fresh);
    s.v = 2;
    const read = await http.get<{ v: number }>('/e', { ...fresh, cacheMode: 'no-store' });
    const next = await http.get<{ v: number }>('/e', fresh);
    expect({ read: read.data.v, next: next.data.v, sent: s.sent.length }).toEqual({ read: 2, next: 1, sent: 2 });
  });

  it('no-cache with nothing stored, or a copy with no ETag, sends a plain request', async () => {
    const http = createHttpClient({ baseURL: base });
    await http.get('/plain', { ...fresh, cacheMode: 'no-cache' });
    await http.get('/plain', { ...fresh, cacheMode: 'no-cache' });
    expect(s.sent).toEqual([undefined, undefined]);
  });
});
