/**
 * A stale entry's refresh sends its stored ETag; a 304 keeps the stored copy; Cache-Control: no-store is honoured.
 * Why: a refresh that dropped the ETag, or replaced the copy on a 304, would change the page's data object and re-render the router for nothing; a no-store response kept in the cache would be served after the server forbade it.
 * Shows: a stale hit refreshes with If-None-Match and a 304 resolves to the same stored data and opens a new window; a 200 replaces the copy; a joined read gets the stored response; a write during the refresh stops the 304 storing; the app's own If-None-Match is kept; a response without an ETag refreshes as a plain read; a no-store response, or a refresh answered no-store, is not kept.
 * See: tests/router/cache-groups.test.ts, Fetch 4.6
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHttpClient } from '../src/http';

/** `/e` answers `{ v }` with ETag "e<v>" and a 304 on a match; `/plain` no ETag; `/nostore` no-store. */
const s = { v: 1, conditional: [] as Array<string | undefined>, noStore: false };
let server: Server;
let base = '';
beforeAll(async () => {
  server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const inm = req.headers['if-none-match'];
      s.conditional.push(inm);
      const tag = `"e${s.v}"`;
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (req.url !== '/plain') headers.etag = tag;
      if (req.url === '/nostore' || s.noStore) headers['cache-control'] = 'private, no-store';
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
beforeEach(() => {
  Object.assign(s, { v: 1, conditional: [], noStore: false });
  // The client's windows read Date.now(): on a fake clock a 20 ms window cannot lapse
  // under load between two reads. The server and its sockets stay real.
  vi.useFakeTimers({ toFake: ['Date'] });
});
afterEach(() => { vi.useRealTimers(); });

const swr = { cache: { ttl: 20, staleTtl: 60_000 } };
const pastFresh = async (): Promise<void> => { vi.advanceTimersByTime(40); };

describe('a stale refresh with a stored ETag', () => {
  it("sends it; a 304 resolves the refresh to the stored response, its data the same object, and opens a new window", async () => {
    const http = createHttpClient({ baseURL: base });
    const first = await http.get<{ v: number }>('/e', swr);
    await pastFresh();
    const stale = await http.get<{ v: number }>('/e', swr);
    expect(stale.stale).toBe(true);
    const fresh = await stale.revalidation!;
    expect(s.conditional).toEqual([undefined, '"e1"']);
    expect({ same: fresh.data === first.data, status: fresh.status }).toEqual({ same: true, status: 200 });
    // A new window: the next read is a fresh hit, nothing sent.
    const again = await http.get('/e', swr);
    expect({ stale: again.stale, sent: s.conditional.length }).toEqual({ stale: undefined, sent: 2 });
  });

  it("the new window is the reading call's: `cache: true` re-stores the 304'd copy for the default window", async () => {
    const http = createHttpClient({ baseURL: base });
    await http.get('/e', swr);
    await pastFresh();
    const stale = await http.get('/e', { cache: true });
    await stale.revalidation;
    await pastFresh();
    const again = await http.get('/e', { cache: true });
    expect({ stale: again.stale, sent: s.conditional }).toEqual({ stale: undefined, sent: [undefined, '"e1"'] });
  });

  it('control: a changed resource answers 200, the new data replaces the copy', async () => {
    const http = createHttpClient({ baseURL: base });
    const first = await http.get<{ v: number }>('/e', swr);
    await pastFresh();
    s.v = 2;
    const fresh = await (await http.get<{ v: number }>('/e', swr)).revalidation!;
    expect({ sent: s.conditional, v: fresh.data.v, same: fresh.data === first.data }).toEqual({ sent: [undefined, '"e1"'], v: 2, same: false });
  });

  it('a read joining the refresh in flight gets the full stored response', async () => {
    const http = createHttpClient({ baseURL: base });
    const first = await http.get<{ v: number }>('/e', { ...swr });
    await pastFresh();
    const stale = await http.get<{ v: number }>('/e', swr);
    const joined = await http.get<{ v: number }>('/e');
    await stale.revalidation;
    expect({ data: joined.data, same: joined.data === first.data, sent: s.conditional.length }).toEqual({ data: { v: 1 }, same: true, sent: 2 });
  });

  it('a write to the URL while the refresh is on the wire: its 304 stores nothing', async () => {
    const http = createHttpClient({ baseURL: base });
    await http.get('/e', swr);
    await pastFresh();
    const stale = await http.get('/e', swr);
    await http.post('/e', {});
    await stale.revalidation;
    await http.get('/e', swr);
    expect(s.conditional).toEqual([undefined, '"e1"', undefined, undefined]);
  });

  it("keeps the app's own If-None-Match", async () => {
    const http = createHttpClient({ baseURL: base });
    const opts = { ...swr, headers: { 'If-None-Match': '"mine"' } };
    await http.get('/e', opts);
    await pastFresh();
    await (await http.get('/e', opts)).revalidation;
    expect(s.conditional).toEqual(['"mine"', '"mine"']);
  });
});

describe('nothing changes when the server declares neither', () => {
  it('no ETag: the refresh is a plain read, stored as released', async () => {
    const http = createHttpClient({ baseURL: base });
    await http.get('/plain', swr);
    await pastFresh();
    const fresh = await (await http.get<{ v: number }>('/plain', swr)).revalidation!;
    expect({ sent: s.conditional, v: fresh.data.v }).toEqual({ sent: [undefined, undefined], v: 1 });
  });
});

describe('Cache-Control: no-store', () => {
  it('a response that says it is not kept: the next read is sent again', async () => {
    const http = createHttpClient({ baseURL: base });
    await http.get('/nostore', { cache: true });
    await http.get('/nostore', { cache: true });
    expect(s.conditional.length).toBe(2);
  });

  it('a refresh answered no-store drops the copy it refreshed', async () => {
    const http = createHttpClient({ baseURL: base });
    await http.get('/e', swr);
    await pastFresh();
    s.v = 2;
    s.noStore = true;
    await (await http.get('/e', swr)).revalidation;
    await http.get('/e', swr);
    expect(s.conditional.length).toBe(3);
  });
});
