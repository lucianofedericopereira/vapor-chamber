// A deduped GET: each caller's own signal governs its own promise, never another's.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHttpClient } from '../src/http';
import { createAsyncCommandBus } from '../src/command-bus';
import { supersede } from '../src/plugins-extra';

// A real server and Node's real fetch: it answers { n } after DELAY ms, n = requests
// so far, and counts the requests a client aborted before the answer.
// An abort is counted only if it reaches the server before the answer, so DELAY
// is the window a loaded machine has between a request arriving and the test's
// abort(); 40 ms lost that race once under a throttled gate (log s35.65).
const DELAY = 250;
let server: Server;
let base = '';
let requests = 0;
let abortedOnServer = 0;
beforeAll(async () => {
  server = createServer((req, res) => {
    const n = ++requests;
    const t = setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ n }));
    }, DELAY);
    res.on('close', () => { if (!res.writableEnded) { clearTimeout(t); abortedOnServer++; } });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => { requests = 0; abortedOnServer = 0; });

const settle = (p: Promise<unknown>) => p.then((r: any) => ({ ok: true, data: r.data }), (e: any) => ({ ok: false, code: e?.code }));
const client = () => createHttpClient({ baseURL: base, retry: 0 });
/** Wait for `cond`, up to 2 s; fail naming it rather than return as if it held. */
const until = async (cond: () => boolean) => {
  for (const end = Date.now() + 2000; !cond(); await new Promise((r) => setTimeout(r, 5))) {
    if (Date.now() > end) throw new Error(`until: still false after 2 s: ${cond}`);
  }
};

describe('deduped GET with signals', () => {
  it('control: two signalled callers, nobody aborts: one request, both answered', async () => {
    const http = client();
    const [ra, rb] = await Promise.all([
      settle(http.get('/q', { signal: new AbortController().signal })),
      settle(http.get('/q', { signal: new AbortController().signal })),
    ]);
    expect(requests).toBe(1);
    expect(ra).toEqual({ ok: true, data: { n: 1 } });
    expect(rb).toEqual({ ok: true, data: { n: 1 } });
  });

  it('the leader aborts: the follower still gets the response, the request is not aborted', async () => {
    const http = client();
    const a = new AbortController();
    const pa = settle(http.get('/q', { signal: a.signal })), pb = settle(http.get('/q', { signal: new AbortController().signal }));
    a.abort();
    expect(await pa).toEqual({ ok: false, code: 'transport:aborted:request' });
    expect(await pb).toEqual({ ok: true, data: { n: 1 } });
    expect([requests, abortedOnServer]).toEqual([1, 0]);
  });

  it('a follower aborts: its own promise rejects at once, the leader is answered', async () => {
    const http = client();
    const b = new AbortController();
    const pa = settle(http.get('/q', { signal: new AbortController().signal })), pb = settle(http.get('/q', { signal: b.signal }));
    b.abort();
    const first = await Promise.race([pb, new Promise((r) => setTimeout(() => r('late'), DELAY / 4))]);
    expect(first).toEqual({ ok: false, code: 'transport:aborted:request' });
    expect(await pa).toEqual({ ok: true, data: { n: 1 } });
    expect([requests, abortedOnServer]).toEqual([1, 0]);
  });

  it('every holder aborts: the request is aborted, and a later caller starts a fresh one', async () => {
    const http = client();
    const a = new AbortController(), b = new AbortController();
    const pa = settle(http.get('/q', { signal: a.signal })), pb = settle(http.get('/q', { signal: b.signal }));
    await until(() => requests === 1);
    a.abort(); b.abort();
    const pc = settle(http.get('/q', { signal: new AbortController().signal }));
    expect(await pa).toEqual({ ok: false, code: 'transport:aborted:request' });
    expect(await pb).toEqual({ ok: false, code: 'transport:aborted:request' });
    expect(await pc).toEqual({ ok: true, data: { n: 2 } });
    await until(() => abortedOnServer === 1);
    expect([requests, abortedOnServer]).toEqual([2, 1]);
  });

  it('a caller without a signal holds the request: a signalled leader aborting does not cancel it', async () => {
    const http = client();
    const a = new AbortController();
    const pa = settle(http.get('/q', { signal: a.signal })), pb = settle(http.get('/q'));
    a.abort();
    expect(await pa).toEqual({ ok: false, code: 'transport:aborted:request' });
    expect(await pb).toEqual({ ok: true, data: { n: 1 } });
    expect([requests, abortedOnServer]).toEqual([1, 0]);
  });

  it('a leader without a signal: a signalled follower aborting rejects only itself', async () => {
    const http = client();
    const b = new AbortController();
    const pa = settle(http.get('/q')), pb = settle(http.get('/q', { signal: b.signal }));
    b.abort();
    expect(await pb).toEqual({ ok: false, code: 'transport:aborted:request' });
    expect(await pa).toEqual({ ok: true, data: { n: 1 } });
    expect([requests, abortedOnServer]).toEqual([1, 0]);
  });

  it('a follower whose signal is already aborted rejects, and the leader is answered', async () => {
    const http = client();
    const pa = settle(http.get('/q', { signal: new AbortController().signal }));
    const pb = settle(http.get('/q', { signal: AbortSignal.abort() }));
    expect(await pb).toEqual({ ok: false, code: 'transport:aborted:request' });
    expect(await pa).toEqual({ ok: true, data: { n: 1 } });
    expect(requests).toBe(1);
  });

  it('a leader whose signal is already aborted is not joined: the next caller fetches', async () => {
    const http = client();
    const pa = settle(http.get('/q', { signal: AbortSignal.abort() }));
    const pb = settle(http.get('/q', { signal: new AbortController().signal }));
    expect(await pa).toEqual({ ok: false, code: 'transport:aborted:request' });
    expect(await pb).toEqual({ ok: true, data: { n: 1 } });
    expect(requests).toBe(1);
  });

  it('after an invalidation, the old read\'s last abort leaves the new read joinable', async () => {
    const http = client();
    const a = new AbortController();
    const pa = settle(http.get('/q', { signal: a.signal }));
    await until(() => requests === 1);
    http.clearCache();
    const pb = settle(http.get('/q', { signal: new AbortController().signal }));
    a.abort();
    const pc = settle(http.get('/q', { signal: new AbortController().signal }));
    expect(await pa).toEqual({ ok: false, code: 'transport:aborted:request' });
    expect(await pb).toEqual({ ok: true, data: { n: 2 } });
    expect(await pc).toEqual({ ok: true, data: { n: 2 } });
    expect(requests).toBe(2);
  });

  it('dedupe: false keeps every caller on its own request', async () => {
    const http = client();
    const a = new AbortController();
    const pa = settle(http.get('/q', { signal: a.signal, dedupe: false })), pb = settle(http.get('/q', { dedupe: false }));
    await until(() => requests === 2);
    a.abort();
    expect(await pa).toEqual({ ok: false, code: 'transport:aborted:request' });
    expect(await pb).toEqual({ ok: true, data: { n: 2 } });
    await until(() => abortedOnServer === 1);
    expect([requests, abortedOnServer]).toEqual([2, 1]);
  });
});

describe('supersede with a handler that passes cmd.signal to the client', () => {
  it('the newer dispatch is answered, the older one is aborted', async () => {
    const http = client();
    const bus = createAsyncCommandBus();
    bus.use(supersede({ actions: ['search'] }));
    bus.register('search', async (cmd) => (await http.get('/q', { signal: cmd.signal })).data);
    const [x, y] = await Promise.all([bus.dispatch('search', 'box'), bus.dispatch('search', 'box')]);
    expect(x.ok).toBe(false);
    expect(y.ok).toBe(true);
    expect(y.value).toEqual({ n: requests });
  });
});

// Long form. Before this fix the dedupe key (method, responseType, URL) let a second
// caller return the first caller's promise as is: the follower's signal was never
// read, and the leader's signal aborted the one request both were waiting on. So a
// follower was cancelled by someone else's abort and could not cancel with its own.
// supersede hit it on every use: the handler's http.get under the second dispatch
// joined the request the plugin had just aborted. The documented `signal` is per
// request ("External abort signal (e.g. from component unmount)"), so sharing the
// abort was never the contract; sharing the outcome is (the serveStaleOnError
// follower test in http-client.test.ts). Found downstream, 2026-10-01.
// Real fetch against a real server, not a stub: the server's own counters say how
// many requests went out and which were aborted mid-flight, so no fake Response or
// fake abort behaviour can make a case pass that the platform would fail.
