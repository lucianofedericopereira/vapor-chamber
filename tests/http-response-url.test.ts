/**
 * HttpResponse carries Fetch's `url` and `redirected`, against a real redirect.
 * Why: an app redirected by its server could not learn where it ended up, and a Cache Groups map keyed by URL needs the final URL.
 * Shows: a followed 302 gives the final url and redirected true; no redirect gives the requested url and false; postCommand keeps the POST through a 307 and reports where it landed.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHttpClient, postCommand } from '../src/http';

// A real server: a stubbed Response has no url.
let server: Server;
let base = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/from') { res.writeHead(302, { location: '/to' }); res.end(); return; }
    if (req.url === '/cmd-from') { res.writeHead(307, { location: '/cmd-to' }); res.end(); return; }
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ at: req.url, method: req.method }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('HttpResponse.url and redirected', () => {
  it('the client: a followed redirect gives the final url and redirected true', async () => {
    const res = await createHttpClient().get<{ at: string }>(`${base}/from`);
    expect(res.data.at).toBe('/to');
    expect(res.url).toBe(`${base}/to`);
    expect(res.redirected).toBe(true);
  });

  it('the client: no redirect gives the url asked for and redirected false', async () => {
    const res = await createHttpClient().get(`${base}/to`);
    expect(res.url).toBe(`${base}/to`);
    expect(res.redirected).toBe(false);
  });

  it('postCommand: a 307 keeps the POST and reports where it landed', async () => {
    const res = await postCommand<{ at: string; method: string }>(`${base}/cmd-from`, { command: 'x' });
    expect(res.data).toEqual({ at: '/cmd-to', method: 'POST' });
    expect(res.url).toBe(`${base}/cmd-to`);
    expect(res.redirected).toBe(true);
  });
});
