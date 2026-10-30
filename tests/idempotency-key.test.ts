/**
 * The Idempotency-Key sent on the wire by idempotent(), the outbox and the retry.
 * Why: the key travels as a header that proxies and logs keep, so a library-minted key must be an opaque per-request id, never command content; a re-send must reuse it and an app's own key must go out as given.
 * Shows: single and batched requests carry the dispatch id, a retry reuses it, local collapsing is unchanged, app keys are percent-encoded only when needed, and the outbox record key wins over idempotent().
 * See: draft-ietf-httpapi-idempotency-key-header-07 2.2, log 36.48.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAsyncCommandBus, type Command } from '../src/command-bus';
import { createOutbox, type Outbox, type OutboxRecord } from '../src/outbox';
import { idempotent } from '../src/plugins-extra';
import { httpTransport } from '../src/transports';
import { queueStorage, storedRecord } from './outbox-storage';

/** What the server received: one row per command, its key as sent. */
let got: Array<{ command: string; key: string | undefined }> = [];
/** Answers to give, in order, before the default 200. */
let script: number[] = [];
let server: Server;
let base = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      const status = script.shift() ?? 200;
      res.writeHead(status, { 'content-type': 'application/json' });
      if (Array.isArray(body.commands)) {
        for (const c of body.commands) got.push({ command: c.command, key: c.headers?.['Idempotency-Key'] });
        res.end(JSON.stringify({ results: body.commands.map((c: { id: string }) => ({ id: c.id, status: 200, headers: {}, state: 1 })) }));
        return;
      }
      got.push({ command: body.command, key: req.headers['idempotency-key'] as string | undefined });
      res.end(JSON.stringify(status === 200 ? { state: 1 } : { problem: { code: 'busy' } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => { got = []; script = []; });

/** A bus on the real transport; `ids` collects each dispatch's meta.id in order. */
function wired(batch = false, retry: NonNullable<Parameters<typeof createAsyncCommandBus>[0]>['retry'] = false, outbox?: Outbox) {
  const bus = createAsyncCommandBus({ retry, transport: httpTransport({ endpoint: `${base}/vc`, ...(batch ? { batch: {} } : {}) }), outbox });
  const ids: string[] = [];
  bus.use({ started: (cmd: Command) => { ids.push(cmd.meta!.id); } });
  return { bus, ids };
}

describe('idempotent(): an opaque key on the wire', () => {
  it("a single request sends the dispatch's id, no command content", async () => {
    const { bus, ids } = wired();
    bus.use(idempotent());
    await bus.dispatch('orderCreate', { sku: 'secret-1' }, { qty: 5 });
    expect(got).toEqual([{ command: 'orderCreate', key: `"${ids[0]}"` }]);
  });

  it("a batched command sends the dispatch's id in its headers member", async () => {
    const { bus, ids } = wired(true);
    bus.use(idempotent());
    await Promise.all([bus.dispatch('orderCreate', { sku: 1 }, { qty: 1 }), bus.dispatch('orderCreate', { sku: 2 }, { qty: 1 })]);
    expect(got).toEqual([{ command: 'orderCreate', key: `"${ids[0]}"` }, { command: 'orderCreate', key: `"${ids[1]}"` }]);
  });

  it('a re-send carries the same key', async () => {
    const { bus, ids } = wired(false, { baseDelay: 1, maxDelay: 1 });
    bus.use(idempotent());
    script = [503];
    expect((await bus.dispatch('orderCreate', { sku: 1 })).ok).toBe(true);
    expect(got.map((g) => g.key)).toEqual([`"${ids[0]}"`, `"${ids[0]}"`]);
  });

  it('control: a double click still collapses locally, one request', async () => {
    const { bus } = wired();
    bus.use(idempotent());
    await Promise.all([bus.dispatch('orderCreate', { sku: 1 }, { qty: 1 }), bus.dispatch('orderCreate', { sku: 1 }, { qty: 1 })]);
    await bus.dispatch('orderCreate', { sku: 1 }, { qty: 1 });
    expect(got).toHaveLength(1);
  });

  it('control: two payloads on one target are two requests with two keys', async () => {
    const { bus } = wired();
    bus.use(idempotent());
    await bus.dispatch('orderCreate', { sku: 1 }, { qty: 1 });
    await bus.dispatch('orderCreate', { sku: 1 }, { qty: 5 });
    expect(got).toHaveLength(2);
    expect(got[0]!.key).not.toBe(got[1]!.key);
  });

  it("an app's key of unreserved characters goes out without the encode, any other key is encoded on every send", async () => {
    const encode = vi.spyOn(globalThis, 'encodeURIComponent');
    try {
      for (const [k, wire, calls] of [['Az09-_.~', '"Az09-_.~"', 0], ['order:1', '"order%3A1"', 2]] as const) {
        encode.mockClear();
        got = [];
        const { bus } = wired(false, { baseDelay: 1, maxDelay: 1 });
        bus.use(idempotent({ key: () => k }));
        script = [503];
        await bus.dispatch('orderCreate', { sku: 1 });
        const sent = encode.mock.calls.filter(([s]) => s === k).length;
        // Two sends (a 503, then the re-send): the encode runs on each, or on none.
        expect({ keys: got.map((g) => g.key), sent }).toEqual({ keys: [wire, wire], sent: calls });
      }
    } finally { encode.mockRestore(); }
  });

  it("control: an app's own key is sent as given, percent-encoded", async () => {
    const { bus } = wired();
    bus.use(idempotent({ key: (cmd) => `order:${(cmd.target as { sku: number }).sku}` }));
    await bus.dispatch('orderCreate', { sku: 1 }, { qty: 1 });
    expect(got).toEqual([{ command: 'orderCreate', key: `"${encodeURIComponent('order:1')}"` }]);
  });
});

describe('the outbox: the record id alone', () => {
  /** An offline outbox over memory storage on the real transport. */
  function offline(stored: OutboxRecord[] | null = null, key?: (cmd: Command) => string) {
    let online = false;
    const mem = queueStorage(stored);
    const ob = createOutbox({ storage: mem, isOnline: () => online, autoFlush: false, key });
    const { bus } = wired(false, false, ob);
    return { bus, ob, mem, goOnline: () => { online = true; } };
  }

  it("a replay sends its record's id", async () => {
    const o = offline();
    await o.bus.dispatch('cartAdd', { id: 1 }, { qty: 2 });
    const id = o.mem.rows()[0]!.id;
    o.goOnline();
    await o.ob.flush();
    expect(got).toEqual([{ command: 'cartAdd', key: `"${id}"` }]);
  });

  it("the record's key wins over idempotent", async () => {
    const o = offline();
    // ttl 0: its memory would answer a replay unsent if the replay passed through it.
    o.bus.use(idempotent({ ttl: 0 }));
    await o.bus.dispatch('cartAdd', { id: 1 }, { qty: 2 });
    const id = o.mem.rows()[0]!.id;
    o.goOnline();
    await o.ob.flush();
    expect(got).toEqual([{ command: 'cartAdd', key: `"${id}"` }]);
  });

  it('control: two offline writes on one target are sent under two keys', async () => {
    const o = offline();
    await o.bus.dispatch('cartAdd', { id: 1 }, { qty: 2 });
    await o.bus.dispatch('cartAdd', { id: 1 }, { qty: 3 });
    o.goOnline();
    await o.ob.flush();
    expect(got).toHaveLength(2);
    expect(got[0]!.key).not.toBe(got[1]!.key);
  });

  it('control: a stored record replays its own key', async () => {
    const old = storedRecord({ id: 'r1', action: 'cartAdd', target: { id: 1 }, payload: { qty: 2 }, key: 'k-1' });
    const o = offline([old]);
    o.goOnline();
    await o.ob.flush();
    expect(got).toEqual([{ command: 'cartAdd', key: '"k-1"' }]);
  });

  it("control: an app's own key is sent as given", async () => {
    const o = offline(null, (cmd) => `cart:${(cmd.target as { id: number }).id}`);
    await o.bus.dispatch('cartAdd', { id: 1 }, { qty: 2 });
    o.goOnline();
    await o.ob.flush();
    expect(got).toEqual([{ command: 'cartAdd', key: `"${encodeURIComponent('cart:1')}"` }]);
  });
});

describe("the retry: an action declared 'idempotent'", () => {
  it("control: sends the dispatch's id, the same on every attempt", async () => {
    const { bus, ids } = wired(false, { baseDelay: 1, maxDelay: 1, actionPolicies: { save: 'idempotent' } });
    script = [503];
    expect((await bus.dispatch('save', { id: 1 })).ok).toBe(true);
    expect(got.map((g) => g.key)).toEqual([`"${ids[0]}"`, `"${ids[0]}"`]);
  });
});
