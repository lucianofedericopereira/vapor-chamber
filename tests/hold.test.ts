/**
 * The hold: after a limited answer (429, 503) that declares a wait, the action is held on its transport until the wait ends.
 * Why: without the hold every later command for that action goes to the wire inside the wait and meets the same 429; the scope is the action on its transport because a 429 does not say what it covers, and a verdict with a wait (409) is one request's state, not a limit.
 * Shows: a command inside the wait is refused unsent as transport:limited:held with the time left in retryIn (http, batch, custom httpClient, WebSocket); other actions, other transports, non-limited answers and answers with no wait hold nothing; the retry waits the hold out, returns it past maxDelay, and abort or dispose ends the wait; the outbox keeps a held replay and flushes it after the time left.
 * See: log 36.42, RFC 6585 section 4.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type BusError, createAsyncCommandBus, type CommandResult, type RetryOptions } from '../src/command-bus';
import { createOutbox } from '../src/outbox';
import { httpTransport, wsTransport } from '../src/transports';
import { MockWebSocket } from './backend-stubs';

/** 2026-10-16 12:00:00 UTC, a whole second. */
const NOW = Date.UTC(2026, 9, 16, 12);

/**
 * The server limits every request until `until` (its clock is the test's): a
 * `status` answer with the headers `declare` gives for the ms left, else 200.
 * `/batch` answers each command in a 200, or the whole batch when `whole`.
 * Every command it receives is in `seen`, with the time it arrived.
 */
const s = {
  until: 0,
  status: 429,
  whole: false,
  declare: (left: number): Record<string, string> => ({ 'retry-after': String(Math.ceil(left / 1000)) }),
  seen: [] as Array<{ at: number; action: string }>,
};
let server: Server;
let base = '';
beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const at = Date.now();
      const left = s.until - at;
      const problem = { status: s.status, code: 'too_many' };
      if (req.url === '/batch') {
        const { commands } = JSON.parse(body) as { commands: Array<{ id: string; command: string }> };
        for (const c of commands) s.seen.push({ at, action: c.command });
        if (left > 0 && s.whole) {
          res.writeHead(s.status, { 'content-type': 'application/problem+json', ...s.declare(left) });
          res.end(JSON.stringify(problem));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ results: commands.map((c) => (left > 0 ? { id: c.id, status: s.status, headers: s.declare(left), problem } : { id: c.id, status: 200, state: 1 })) }));
        return;
      }
      s.seen.push({ at, action: (JSON.parse(body) as { command: string }).command });
      if (left > 0) {
        res.writeHead(s.status, { 'content-type': 'application/problem+json', ...s.declare(left) });
        res.end(JSON.stringify(problem));
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

let now = NOW;
beforeEach(() => {
  Object.assign(s, { until: 0, status: 429, whole: false, seen: [] });
  s.declare = (left) => ({ 'retry-after': String(Math.ceil(left / 1000)) });
  now = NOW;
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** The test's clock, for the hold and the server alike: `at(ms)` moves it. */
const clock = () => vi.spyOn(Date, 'now').mockImplementation(() => now);
const at = (ms: number) => { now = NOW + ms; };
const errorOf = (r: CommandResult) => r.error as BusError;
const bus = (retry: RetryOptions | false = false, endpoint = '/vc', batch = false) =>
  createAsyncCommandBus({ retry, transport: httpTransport({ endpoint: base + endpoint, batch: batch ? {} : undefined }) });

describe('a limited answer with a declared wait holds its action, unsent (retry off)', () => {
  it('the next command inside the wait is refused at once with the time left, and never sent', async () => {
    clock();
    s.until = NOW + 30_000;
    const b = bus();
    expect(errorOf(await b.dispatch('cartAdd', 1)).code).toBe('remote:limited:too_many');
    at(1_000);
    const e = errorOf(await b.dispatch('cartAdd', 2));
    expect({ code: e.code, retryIn: e.context?.retryIn, action: e.action, seen: s.seen.length })
      .toEqual({ code: 'transport:limited:held', retryIn: 29_000, action: 'cartAdd', seen: 1 });
  });

  const fields: Array<[string, (left: number) => Record<string, string>]> = [
    ['RateLimit t for a policy with no quota left', () => ({ ratelimit: '"default";r=0;t=30' })],
    ['X-RateLimit-Reset as Unix seconds', () => ({ 'x-ratelimit-reset': String(NOW / 1000 + 30) })],
  ];
  it.each(fields)('the wait the one reader reads: %s', async (_label, declare) => {
    clock();
    s.until = NOW + 30_000;
    s.declare = declare;
    const b = bus();
    await b.dispatch('cartAdd', 1);
    at(1_000);
    expect(errorOf(await b.dispatch('cartAdd', 2)).context?.retryIn).toBe(29_000);
    expect(s.seen).toHaveLength(1);
  });

  it('a 503 with Retry-After holds as a 429 does', async () => {
    clock();
    Object.assign(s, { until: NOW + 30_000, status: 503 });
    const b = bus();
    expect(errorOf(await b.dispatch('cartAdd', 1)).code).toBe('remote:limited:too_many');
    expect(errorOf(await b.dispatch('cartAdd', 2)).code).toBe('transport:limited:held');
    expect(s.seen).toHaveLength(1);
  });

  it('control: the hold ends at its time, and the command is sent', async () => {
    clock();
    s.until = NOW + 30_000;
    const b = bus();
    await b.dispatch('cartAdd', 1);
    at(30_000);
    expect(await b.dispatch('cartAdd', 2)).toMatchObject({ ok: true, value: 1 });
    expect(s.seen).toHaveLength(2);
  });

  it('control: another action on the same transport is sent (the scope is the action)', async () => {
    clock();
    s.until = NOW + 30_000;
    const b = bus();
    await b.dispatch('cartAdd', 1);
    expect(errorOf(await b.dispatch('cartRemove', 1)).code).toBe('remote:limited:too_many');
    expect(s.seen.map((x) => x.action)).toEqual(['cartAdd', 'cartRemove']);
  });

  it('control: the same action on another transport is sent', async () => {
    clock();
    s.until = NOW + 30_000;
    await bus().dispatch('cartAdd', 1);
    expect(errorOf(await bus().dispatch('cartAdd', 2)).code).toBe('remote:limited:too_many');
    expect(s.seen).toHaveLength(2);
  });

  it('control: a verdict with a wait (a 409 with Retry-After) holds nothing', async () => {
    clock();
    Object.assign(s, { until: NOW + 30_000, status: 409 });
    const b = bus();
    await b.dispatch('cartAdd', 1);
    expect(errorOf(await b.dispatch('cartAdd', 2)).code).toBe('remote:conflict:too_many');
    expect(s.seen).toHaveLength(2);
  });

  it('control: a limited answer with no declared wait holds nothing', async () => {
    clock();
    s.until = NOW + 30_000;
    s.declare = () => ({});
    const b = bus();
    await b.dispatch('cartAdd', 1);
    await b.dispatch('cartAdd', 2);
    expect(s.seen).toHaveLength(2);
  });

  it("the transport's dispose forgets its holds: the next command is sent", async () => {
    clock();
    s.until = NOW + 30_000;
    const b = bus();
    await b.dispatch('cartAdd', 1);
    b.dispose();
    expect(errorOf(await b.dispatch('cartAdd', 2)).code).toBe('remote:limited:too_many');
    expect(s.seen).toHaveLength(2);
  });
});

describe('two answers for one action', () => {
  // An app's client whose answers the test releases in its own order.
  const released = () => {
    const answers: Array<(wait: string) => void> = [];
    const httpClient = {
      post: () => new Promise((resolve) => answers.push((wait) => resolve({ ok: false, status: 429, headers: { 'retry-after': wait }, data: { status: 429, code: 'too_many' } }))),
    };
    return { answers, bus: createAsyncCommandBus({ retry: false, transport: httpTransport({ endpoint: '/vc', httpClient: httpClient as never }) }) };
  };

  it('the later end holds, whichever answer lands last: a shorter wait never shortens a hold', async () => {
    clock();
    const { answers, bus: b } = released();
    const both = Promise.all([b.dispatch('cartAdd', 1), b.dispatch('cartAdd', 2)]);
    await until(() => answers.length === 2);
    answers[1]('20');
    answers[0]('5');
    await both;
    at(10_000);
    const third = b.dispatch('cartAdd', 3);
    await settle();
    expect(answers).toHaveLength(2);
    expect(errorOf(await third).context?.retryIn).toBe(10_000);
  });

  it('a later, longer wait extends it', async () => {
    clock();
    const { answers, bus: b } = released();
    const both = Promise.all([b.dispatch('cartAdd', 1), b.dispatch('cartAdd', 2)]);
    await until(() => answers.length === 2);
    answers[0]('5');
    answers[1]('20');
    await both;
    at(10_000);
    const third = b.dispatch('cartAdd', 3);
    await settle();
    expect(answers).toHaveLength(2);
    expect(errorOf(await third).context?.retryIn).toBe(10_000);
  });
});

describe('the batching transport', () => {
  it("a batched result's own 429 holds its action", async () => {
    clock();
    s.until = NOW + 30_000;
    const b = bus(false, '/batch', true);
    expect(errorOf(await b.dispatch('cartAdd', 1)).code).toBe('remote:limited:too_many');
    at(1_000);
    expect(errorOf(await b.dispatch('cartAdd', 2)).context?.retryIn).toBe(29_000);
    expect(s.seen).toHaveLength(1);
  });

  it('a whole-batch 429 holds every action in it', async () => {
    clock();
    Object.assign(s, { until: NOW + 30_000, whole: true });
    const b = bus(false, '/batch', true);
    await Promise.all([b.dispatch('cartAdd', 1), b.dispatch('cartRemove', 1)]);
    const [x, y] = await Promise.all([b.dispatch('cartAdd', 2), b.dispatch('cartRemove', 2)]);
    expect([errorOf(x).code, errorOf(y).code]).toEqual(['transport:limited:held', 'transport:limited:held']);
    expect(s.seen).toHaveLength(2);
  });

  it('a held command does not hold back the batch it would have joined', async () => {
    clock();
    s.until = NOW + 30_000;
    const b = bus(false, '/batch', true);
    await b.dispatch('cartAdd', 1);
    s.until = 0;
    const [x, y] = await Promise.all([b.dispatch('cartAdd', 2), b.dispatch('cartRemove', 2)]);
    expect([x.ok, y.ok]).toEqual([false, true]);
    expect(s.seen.map((c) => c.action)).toEqual(['cartAdd', 'cartRemove']);
  });
});

describe("an app's own httpClient", () => {
  it('a 429 it returns holds the action', async () => {
    clock();
    let calls = 0;
    const httpClient = { post: async () => { calls++; return { ok: false, status: 429, headers: { 'Retry-After': '30' }, data: { status: 429, code: 'too_many' } }; } };
    const b = createAsyncCommandBus({ retry: false, transport: httpTransport({ endpoint: '/vc', httpClient: httpClient as never }) });
    await b.dispatch('cartAdd', 1);
    expect(errorOf(await b.dispatch('cartAdd', 2)).code).toBe('transport:limited:held');
    expect(calls).toBe(1);
  });
});

describe('a WebSocket frame', () => {
  it("a frame's own 429 holds its action: no frame is sent inside the wait", async () => {
    clock();
    let socket!: MockWebSocket;
    vi.stubGlobal('WebSocket', class extends MockWebSocket { constructor(url: string) { super(url); socket = this; } });
    const ws = wsTransport({ url: 'ws://x', reconnect: false });
    const b = createAsyncCommandBus({ retry: false, transport: ws });
    ws.connect();
    await Promise.resolve();
    const p = b.dispatch('cartAdd', 1);
    await Promise.resolve();
    const { id } = JSON.parse(socket.sent[0]) as { id: string };
    socket.receive({ id, status: 429, headers: { 'Retry-After': '30' }, problem: { status: 429, code: 'too_many' } });
    expect(errorOf(await p).code).toBe('remote:limited:too_many');
    at(1_000);
    const second = b.dispatch('cartAdd', 2);
    await settle();
    expect(socket.sent).toHaveLength(1);
    expect(errorOf(await second).context?.retryIn).toBe(29_000);
    at(30_000);
    void b.dispatch('cartAdd', 3);
    await settle();
    expect(socket.sent).toHaveLength(2);
    ws.disconnect();
  });

  it("disconnect() keeps the server's limits; the bus's dispose forgets them", async () => {
    clock();
    let socket!: MockWebSocket;
    vi.stubGlobal('WebSocket', class extends MockWebSocket { constructor(url: string) { super(url); socket = this; } });
    const ws = wsTransport({ url: 'ws://x', reconnect: false });
    const b = createAsyncCommandBus({ retry: false, transport: ws });
    ws.connect();
    await Promise.resolve();
    const p = b.dispatch('cartAdd', 1);
    await Promise.resolve();
    socket.receive({ id: (JSON.parse(socket.sent[0]) as { id: string }).id, status: 429, headers: { 'Retry-After': '30' }, problem: { status: 429, code: 'too_many' } });
    await p;
    ws.disconnect();
    ws.connect();
    await Promise.resolve();
    expect(errorOf(await b.dispatch('cartAdd', 2)).code).toBe('transport:limited:held');
    b.dispose();
    ws.connect();
    await Promise.resolve();
    void b.dispatch('cartAdd', 3);
    await settle();
    expect(socket.sent).toHaveLength(1);
    ws.disconnect();
  });
});

/** Fake timers for the retry's wait; real I/O is awaited a check at a time. */
const fakeTime = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], now: NOW });
async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 2_000 && !done(); i++) await new Promise((r) => setImmediate(r));
  expect(done()).toBe(true);
}
/** Turns of the event loop enough for a loopback request to reach the server, had one been sent. */
async function settle(): Promise<void> {
  for (let i = 0; i < 200; i++) await new Promise((r) => setImmediate(r));
}
const inWindow = () => s.seen.filter((c) => c.at < s.until).length;
/** A retrying bus whose transport a first command, sent with no retry, has already held. */
const heldBy = (maxDelay: number) => {
  const transport = httpTransport({ endpoint: `${base}/vc` });
  const b = createAsyncCommandBus({ retry: { maxDelay }, transport });
  return { b, ready: createAsyncCommandBus({ retry: false, transport }).dispatch('cartAdd', 1) };
};

describe('the retry waits a hold out (retry on, the default rule)', () => {
  it('a command dispatched inside the wait is sent once, after it', async () => {
    fakeTime();
    s.until = NOW + 2_000;
    const b = bus({ baseDelay: 1 });
    const first = b.dispatch('cartAdd', 1);
    await until(() => s.seen.length === 1);
    await vi.advanceTimersByTimeAsync(500);
    const second = b.dispatch('cartAdd', 2);
    await settle();
    await vi.advanceTimersByTimeAsync(1_500);
    await until(() => s.seen.length >= 3);
    expect({ inWindow: inWindow(), total: s.seen.length }).toEqual({ inWindow: 1, total: 3 });
    expect([(await first).ok, (await second).ok]).toEqual([true, true]);
  });

  it('a hold left over maxDelay is returned at once, unsent', async () => {
    clock();
    s.until = NOW + 30_000;
    const b = bus({ maxDelay: 1_000 });
    await b.dispatch('cartAdd', 1);
    const e = errorOf(await b.dispatch('cartAdd', 2));
    expect({ code: e.code, retryIn: e.context?.retryIn, seen: s.seen.length }).toEqual({ code: 'transport:limited:held', retryIn: 30_000, seen: 1 });
  });

  it("the dispatch's abort ends the wait: aborted, nothing sent", async () => {
    fakeTime();
    s.until = NOW + 30_000;
    const { b, ready } = heldBy(60_000);
    await ready;
    const ctrl = new AbortController();
    const second = b.dispatch('cartAdd', 2, undefined, { signal: ctrl.signal });
    await settle();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(s.seen).toHaveLength(1);
    ctrl.abort();
    expect(errorOf(await second).code).toBe('core:aborted:dispatch');
    b.dispose();
  });

  it("the bus's dispose ends the wait: aborted, nothing sent", async () => {
    fakeTime();
    s.until = NOW + 30_000;
    const { b, ready } = heldBy(60_000);
    await ready;
    const second = b.dispatch('cartAdd', 2);
    await settle();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(s.seen).toHaveLength(1);
    b.dispose();
    expect(errorOf(await second).code).toBe('core:aborted:dispatch');
  });
});

describe('the outbox', () => {
  it('a held replay is kept unsent, and flushed after the time left', async () => {
    fakeTime();
    s.until = NOW + 2_000;
    // One transport, two buses: a live command meets the limit and holds the action.
    const transport = httpTransport({ endpoint: `${base}/vc` });
    expect(errorOf(await createAsyncCommandBus({ retry: false, transport }).dispatch('orderA', 0)).code).toBe('remote:limited:too_many');
    let online = false;
    const outbox = createOutbox({ storage: null, isOnline: () => online });
    const b = createAsyncCommandBus({ transport, outbox });
    await b.dispatch('orderA', {});
    online = true;
    expect(await outbox.flush()).toEqual({ replayed: 0, failed: 1, rejected: 0 });
    expect(s.seen).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2_000);
    await until(() => outbox.pending.value === 0);
    expect({ inWindow: inWindow(), total: s.seen.length }).toEqual({ inWindow: 1, total: 2 });
    outbox.dispose();
  });
});
