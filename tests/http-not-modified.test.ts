// A 304 resolves when the request opts in (resolveNotModified); otherwise it throws as before (panel 21).
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BusError } from '../src/command-bus';
import { createHttpClient, postCommand } from '../src/http';

let server: Server;
let base = '';
let hits = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    hits++;
    req.resume();
    req.on('end', () => {
      if (req.headers['if-none-match'] === '"v1"') {
        // Held a moment, so two concurrent reads are both in flight.
        setTimeout(() => { res.writeHead(304, { etag: '"v1"' }); res.end(); }, 20);
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json', etag: '"v1"' });
      res.end(JSON.stringify({ v: 1 }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const conditional = { headers: { 'if-none-match': '"v1"' } };

describe('resolveNotModified', () => {
  it('off (the default): a 304 throws the core failure, its status in context', async () => {
    const e = await createHttpClient().get(`${base}/r`, conditional).catch((x) => x as BusError);
    expect((e as BusError).name).toBe('BusError');
    expect((e as BusError).context?.status).toBe(304);
  });

  it('on for a request: the 304 resolves as it is', async () => {
    const res = await createHttpClient().get(`${base}/r`, { ...conditional, resolveNotModified: true });
    expect(res.status).toBe(304);
    expect(res.ok).toBe(false);
  });

  it('on for a client: every request of it resolves a 304', async () => {
    const http = createHttpClient({ resolveNotModified: true });
    expect((await http.get(`${base}/r`, conditional)).status).toBe(304);
  });

  it('postCommand opted in resolves a 304 too', async () => {
    const res = await postCommand(`${base}/cmd`, {}, { ...conditional, resolveNotModified: true });
    expect(res.status).toBe(304);
  });

  it('a plain read never joins a conditional one: each gets its own answer', async () => {
    // Different headers, different answers: the conditional read's 304 is not
    // the plain read's. Before, one key (method, type, url) joined them, and
    // the plain caller received the 304.
    const http = createHttpClient();
    const before = hits;
    const [cond, plain] = await Promise.allSettled([
      http.get(`${base}/r`, conditional),
      http.get<{ v: number }>(`${base}/r`),
    ]);
    expect(hits - before).toBe(2);
    expect(cond.status).toBe('rejected');
    expect(plain.status === 'fulfilled' && plain.value.data).toEqual({ v: 1 });
  });

  it('two reads with the same headers still share one request', async () => {
    const http = createHttpClient();
    const before = hits;
    await Promise.all([http.get(`${base}/same`, { headers: { 'x-a': '1' } }), http.get(`${base}/same`, { headers: { 'x-a': '1' } })]);
    expect(hits - before).toBe(1);
  });

  it('an opted-in read and a plain one never share a request', async () => {
    const http = createHttpClient();
    const before = hits;
    const [plain, opted] = await Promise.allSettled([
      http.get(`${base}/r`, conditional),
      http.get(`${base}/r`, { ...conditional, resolveNotModified: true }),
    ]);
    expect(hits - before).toBe(2);
    expect(plain.status).toBe('rejected');
    expect(opted.status === 'fulfilled' && opted.value.status).toBe(304);
  });
});

/*
 * Panel item 21 (owner, 2026-10-02): IN 1.26 as an OPT-IN. A 304 answers a
 * conditional request the app sent itself: "what you hold is current". The
 * shared retry loop threw it like any non-2xx, and no plugin or interceptor
 * could turn that into a resolve (onRejected returns void; the error is
 * rethrown). Resolving by default would change behaviour for anyone catching
 * it, so it is a config option, per request or per client. The dedupe key
 * carries the option, so the same answer never resolves for one caller and
 * throws for another. Not cached: the cache stores `ok` responses only.
 */
