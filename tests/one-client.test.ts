/** One client (plan 1.32 step 3d): the client's re-sends under the bus's bound, keys only for a read that needs one. The long note is at the end. */
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
  // The client's key writer is JSON.stringify with a replacer (src/canonical.ts keyTextFor);
  // a body is encoded without one.
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

/*
 * Plan 1.32 step 3d (.probes/step-3d-pickup.md, log 36.50). Before it the client
 * had a re-send count of its own (`retry`: 2 for a GET, 0 for any other method)
 * beside the bus's bound (`maxAttempts`). Now `retry` takes the bus's term:
 * `{ maxAttempts }` (attempts in total, default 3, the first included) or `false`.
 * Whether a failure is re-sent stays the bus's rule (`retryClass`): a transient
 * one for any method, an uncertain one for a GET or a keyed request. A GET is on by
 * default and a write off, as before: nobody declared otherwise. A 503 with
 * `Retry-After: 0` is transient and waits nothing, so each case counts requests
 * on a real `node:http` server without sleeping.
 *
 * The transport sends a command once through an app's client (`retry: false`):
 * the bus re-sends it, so the two never multiply, whatever the client's default.
 *
 * Keys: the client keyed every request, a write included, before it knew the
 * request was a read (plan-transport-owned.md revision 9 F). The key writer is the
 * only JSON.stringify call with a replacer on these paths, so counting those calls
 * counts keys.
 */
