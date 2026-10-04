// HttpResponse carries Fetch's `url` and `redirected`, against a real redirect (#17).
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHttpClient, postCommand } from '../src/http';

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

/*
 * Decision 12 of the 1.26 list: IN, because the client was plainly wrong and
 * no plugin could fix it. Fetch's Response has `url` (the final URL, after
 * redirects) and `redirected`; the client built its HttpResponse without
 * them, so an app redirected by its server could not learn where it ended up
 * (a Cache Groups map keyed by URL, the panel's case, needs exactly this). The
 * acceptance needs a real redirect: a stubbed Response has no url. Typed
 * optional (an app's own httpClient for a bridge may not set them); both
 * builders always do, so every real response has one shape.
 */
