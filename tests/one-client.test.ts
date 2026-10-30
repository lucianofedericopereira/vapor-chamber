/**
 * One client: the HTTP client's re-sends use the bus's term (`maxAttempts`) and rule (`retryClass`), and a request key is built only for a read that dedupes or caches.
 * Why: a client with its own re-send count beside the bus's would multiply attempts for a command (client times bus), and a key built for every request would cost a write work it never uses.
 * Shows: against a real `node:http` server answering 503 with `Retry-After: 0`, a GET is sent 3 times by default, a write once, `retry: false` once, `maxAttempts` 4/1/2 give 4/1/2 requests, and `retry: {}` lets a write land on the third attempt; `httpTransport` through an app client that re-sends writes sends a command once; the key writer runs once for a deduping or caching GET and never for a write or an uncached, undeduped GET.
 * See: log s36.50.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAsyncCommandBus } from '../src/command-bus';
import { createHttpClient } from '../src/http';
import { httpTransport } from '../src/transports';

/** Each path answers 503 (`Retry-After: 0`) `fail` times, then 200. Every request is counted. */
const s = { fail: 0, seen: [] as string[] };
let server: Server;
let base = '';
beforeAll(async () => {
  server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      s.seen.push(`${req.method} ${req.url}`);
      if (s.fail > 0) {
        s.fail--;
        res.writeHead(503, { 'content-type': 'application/problem+json', 'retry-after': '0' });
        res.end(JSON.stringify({ status: 503, code: 'busy' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ state: 1 }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => Object.assign(s, { fail: 0, seen: [] }));

/** The requests one call made, and whether it ended in a response. */
const sent = async (call: Promise<unknown>) => {
  const ok = await call.then(() => true, () => false);
  return { requests: s.seen.length, ok };
};

describe("the client's re-sends: the bus's bound (maxAttempts), the bus's rule (retryClass)", () => {
  it('control: a GET is sent three times by default (two re-sends)', async () => {
    s.fail = 5;
    expect(await sent(createHttpClient({ baseURL: base }).get('/r'))).toEqual({ requests: 3, ok: false });
  });

  it('control: a write is sent once by default', async () => {
    s.fail = 5;
    expect(await sent(createHttpClient({ baseURL: base }).post('/w', { a: 1 }))).toEqual({ requests: 1, ok: false });
  });

  it('control: `retry: false` sends a GET once', async () => {
    s.fail = 5;
    expect(await sent(createHttpClient({ baseURL: base }).get('/r', { retry: false }))).toEqual({ requests: 1, ok: false });
  });

  it('`retry: { maxAttempts: 4 }` on a call: four attempts in total', async () => {
    s.fail = 5;
    expect(await sent(createHttpClient({ baseURL: base }).get('/r', { retry: { maxAttempts: 4 } }))).toEqual({ requests: 4, ok: false });
  });

  it('`retry: { maxAttempts: 1 }`: the first attempt only', async () => {
    s.fail = 5;
    expect(await sent(createHttpClient({ baseURL: base }).get('/r', { retry: { maxAttempts: 1 } }))).toEqual({ requests: 1, ok: false });
  });

  it('a client default: `createHttpClient({ retry: { maxAttempts: 2 } })`', async () => {
    s.fail = 5;
    expect(await sent(createHttpClient({ baseURL: base, retry: { maxAttempts: 2 } }).get('/r'))).toEqual({ requests: 2, ok: false });
  });

  it('`retry: {}` turns a write on under the rule: a transient 503 is re-sent, the third attempt lands', async () => {
    s.fail = 2;
    expect(await sent(createHttpClient({ baseURL: base }).post('/w', { a: 1 }, { retry: {} }))).toEqual({ requests: 3, ok: true });
  });
});

describe('the transport through the app client: sent once, the bus re-sends', () => {
  it('control: an app client that re-sends writes still sends a command once', async () => {
    s.fail = 5;
    const app = createHttpClient({ retry: { maxAttempts: 3 } });
    const bus = createAsyncCommandBus({ retry: false, transport: httpTransport({ endpoint: `${base}/vc`, httpClient: app }) });
    const r = await bus.dispatch('orderSave', { id: 1 });
    expect({ ok: r.ok, requests: s.seen.length }).toEqual({ ok: false, requests: 1 });
  });
});

describe('keys: built only for a read that dedupes or caches', () => {
  // The key writer is the only JSON.stringify call with a replacer on these paths (src/canonical.ts keyTextFor), so counting those calls counts keys.
  let keyed = 0;
  beforeEach(() => {
    keyed = 0;
    const stringify = JSON.stringify;
    vi.spyOn(JSON, 'stringify').mockImplementation(((value: unknown, replacer?: unknown, space?: unknown) => {
      if (typeof replacer === 'function') keyed++;
      return stringify(value, replacer as never, space as never);
    }) as typeof JSON.stringify);
  });
  afterEach(() => vi.restoreAllMocks());

  it('control: a GET that dedupes builds its key', async () => {
    await createHttpClient({ baseURL: base }).get('/r');
    expect(keyed).toBe(1);
  });

  it('control: a GET that caches, with no dedupe, builds its key', async () => {
    await createHttpClient({ baseURL: base }).get('/r', { dedupe: false, cache: true });
    expect(keyed).toBe(1);
  });

  it('a write builds none', async () => {
    await createHttpClient({ baseURL: base }).post('/w', { a: 1 });
    expect(keyed).toBe(0);
  });

  it('a GET that neither dedupes nor caches builds none', async () => {
    await createHttpClient({ baseURL: base }).get('/r', { dedupe: false });
    expect(keyed).toBe(0);
  });
});
