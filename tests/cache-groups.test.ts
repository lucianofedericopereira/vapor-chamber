/** RFC 9875 cache groups on the client and the transports (plan 1.32 step 3g). Rationale at the end. */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAsyncCommandBus } from '../src/command-bus';
import { _groupsOf, _withDefaults, createHttpClient } from '../src/http';
import { httpTransport, wsTransport } from '../src/transports';

/** GETs answer `{ v }` with their path's groups; a POST answers with `invalidate` as its header. */
const s = { gets: [] as string[], v: 1, invalidate: '' as string, batchHeaders: null as Record<string, string> | null, getInvalidation: '' };
const GROUPS: Record<string, string> = { '/cart': '"cart"', '/stock': '"stock", "cart-lines"', '/both': '"cart";p=1, "stock"' };
let server: Server;
let base = '';
beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const url = req.url as string;
      if (req.method === 'GET') {
        s.gets.push(url);
        const headers: Record<string, string> = { 'content-type': 'application/json' };
        if (GROUPS[url]) headers['cache-groups'] = GROUPS[url];
        if (s.getInvalidation) headers['cache-group-invalidation'] = s.getInvalidation;
        res.writeHead(200, headers);
        res.end(JSON.stringify({ v: s.v }));
        return;
      }
      s.v++;
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (s.invalidate && url !== '/batch') headers['cache-group-invalidation'] = s.invalidate;
      res.writeHead(200, headers);
      if (url === '/batch') {
        const { commands } = JSON.parse(body) as { commands: Array<{ id: string }> };
        res.end(JSON.stringify({ results: commands.map((c) => ({ id: c.id, status: 200, headers: s.batchHeaders ?? {}, state: 'ok' })) }));
        return;
      }
      res.end(JSON.stringify({ state: 'ok' }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => Object.assign(s, { gets: [], v: 1, invalidate: '', batchHeaders: null, getInvalidation: '' }));
afterEach(() => vi.restoreAllMocks());

const client = () => createHttpClient({ baseURL: base });
const reads = (url: string) => s.gets.filter((g) => g === url).length;
const cached = { cache: { ttl: 60_000 } };

describe('the one reader of a group field (RFC 9875 over RFC 9651)', () => {
  it('reads a List of Strings: escapes kept, parameters skipped, a non-String member ignored', () => {
    expect(_groupsOf('"cart", "stock";p=1')).toEqual(['cart', 'stock']);
    expect(_groupsOf('"a\\"b", "c\\\\d"')).toEqual(['a"b', 'c\\d']);
    expect(_groupsOf('"cart", token, ?1, "x"')).toEqual(['cart', 'x']);
    expect(_groupsOf('  "cart"  ,"x"  ')).toEqual(['cart', 'x']);
    expect(_groupsOf('"cart";q="a,b";r, "x"')).toEqual(['cart', 'x']);
  });

  it('ignores a field that does not parse, and has nothing for none', () => {
    expect(_groupsOf('"cart')).toEqual([]);
    expect(_groupsOf('"cart" "x"')).toEqual([]);
    expect(_groupsOf('"a\\x"')).toEqual([]);
    expect(_groupsOf('"cart",')).toEqual([]);
    expect(_groupsOf('"cart", ("a" "b")')).toEqual([]);
    expect(_groupsOf('"é"')).toEqual([]);
    expect(_groupsOf('')).toEqual([]);
    expect(_groupsOf(undefined)).toEqual([]);
  });
});

describe("a write's Cache-Group-Invalidation, on the client", () => {
  it('drops the cached reads in the group and keeps the others; the control keeps both', async () => {
    const http = client();
    await http.get('/cart', cached);
    await http.get('/stock', cached);
    await http.post('/vc', { command: 'noop' });
    await http.get('/cart', cached);
    await http.get('/stock', cached);
    // Control: no header, only the write's own URL goes (RFC 9111 4.4).
    expect([reads('/cart'), reads('/stock')]).toEqual([1, 1]);

    s.invalidate = '"cart"';
    await http.post('/vc', { command: 'cartAdd' });
    const after = await http.get<{ v: number }>('/cart', cached);
    await http.get('/stock', cached);
    expect([reads('/cart'), reads('/stock'), after.data.v]).toEqual([2, 1, 3]);
  });

  it('tells each group to the listeners, once each; a throwing listener is logged and the rest still hear', async () => {
    const http = client();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const heard: string[] = [];
    http.onInvalidateGroup(() => { throw new Error('listener bug'); });
    const off = http.onInvalidateGroup((g) => heard.push(g));
    s.invalidate = '"cart", "stock"';
    await http.post('/vc', {});
    expect(heard).toEqual(['cart', 'stock']);
    expect(errors).toHaveBeenCalledTimes(2);
    off();
    await http.post('/vc', {});
    expect(heard).toEqual(['cart', 'stock']);
  });

  it('a field that names no group, as one that does not parse, drops nothing and tells nobody', async () => {
    const http = client();
    const heard: string[] = [];
    http.onInvalidateGroup((g) => heard.push(g));
    await http.get('/cart', cached);
    s.invalidate = '"cart';
    await http.post('/vc', {});
    await http.get('/cart', cached);
    expect({ heard, cart: reads('/cart') }).toEqual({ heard: [], cart: 1 });
  });

  it('is ignored on a safe method (RFC 9875 3)', async () => {
    const http = client();
    const heard: string[] = [];
    http.onInvalidateGroup((g) => heard.push(g));
    await http.get('/stock', cached);
    s.getInvalidation = '"stock"';
    await http.get('/plain');
    await http.get('/stock', cached);
    expect({ heard, stock: reads('/stock') }).toEqual({ heard: [], stock: 1 });
  });

  it('a read on the wire across it is returned but not stored', async () => {
    const http = client();
    const first = http.get('/plain', cached);
    http.invalidateGroups(['anything']);
    expect((await first).data).toEqual({ v: 1 });
    await http.get('/plain', cached);
    expect(reads('/plain')).toBe(2);
  });

  it('nobody joins a read on the wire across it', async () => {
    const http = client();
    const first = http.get('/plain', cached);
    http.invalidateGroups(['anything']);
    const joiner = http.get('/plain', cached);
    await Promise.all([first, joiner]);
    await http.get('/plain', cached);
    // The joiner sent its own read (stored), so the third is a hit. Joined, there would be one.
    expect(reads('/plain')).toBe(2);
  });

  it('reaches the cached reads of a client that shares its state (`_withDefaults`), and its listeners', async () => {
    const http = client();
    const marked = _withDefaults(http, { headers: { 'X-Router': '1' } });
    const heard: string[] = [];
    marked.onInvalidateGroup((g) => heard.push(g));
    await http.get('/both', cached);
    marked.invalidateGroups(['stock']);
    await http.get('/both', cached);
    expect({ heard, both: reads('/both') }).toEqual({ heard: ['stock'], both: 2 });
  });
});

describe('the transports', () => {
  it("a single command answered through the app's client invalidates its groups", async () => {
    const http = client();
    const bus = createAsyncCommandBus({ retry: false, transport: httpTransport({ endpoint: `${base}/vc`, httpClient: http }) });
    await http.get('/cart', cached);
    s.invalidate = '"cart"';
    expect(await bus.dispatch('cartAdd', {})).toMatchObject({ ok: true });
    await http.get('/cart', cached);
    expect(reads('/cart')).toBe(2);
    bus.dispose();
  });

  it("a batched result's `headers` member invalidates its groups, in any case; a result without it, nothing", async () => {
    const http = client();
    const bus = createAsyncCommandBus({ retry: false, transport: httpTransport({ endpoint: `${base}/batch`, httpClient: http, batch: {} }) });
    const heard: string[] = [];
    http.onInvalidateGroup((g) => heard.push(g));
    await bus.dispatch('noop', {});
    expect(heard).toEqual([]);
    s.batchHeaders = { 'Cache-Group-Invalidation': '"cart"' };
    await Promise.all([bus.dispatch('cartAdd', {}), bus.dispatch('cartAdd', { n: 2 })]);
    expect(heard).toEqual(['cart', 'cart']);
    bus.dispose();
  });

  it("a WebSocket frame's `headers` member reaches the client given to wsTransport", async () => {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise<void>((done) => wss.on('listening', () => done()));
    wss.on('connection', (socket) => socket.on('message', (raw) => {
      const f = JSON.parse(String(raw)) as { id: string };
      socket.send(JSON.stringify({ id: f.id, status: 200, headers: { 'cache-group-invalidation': '"cart"' }, state: 1 }));
    }));
    const http = client();
    const heard: string[] = [];
    http.onInvalidateGroup((g) => heard.push(g));
    let opened!: () => void;
    const open = new Promise<void>((done) => { opened = done; });
    const ws = wsTransport({ url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`, reconnect: false, httpClient: http, onConnect: () => opened() });
    const bus = createAsyncCommandBus({ retry: false, transport: ws });
    ws.connect();
    await open;
    expect(await bus.dispatch('cartAdd', {})).toMatchObject({ ok: true, value: 1 });
    expect(heard).toEqual(['cart']);
    bus.dispose();
    wss.close();
  });

  it('without a client, an answer naming groups warns in development, once per transport; none, no warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bus = createAsyncCommandBus({ retry: false, transport: httpTransport({ endpoint: `${base}/vc` }) });
    await bus.dispatch('noop', {});
    expect(warn).not.toHaveBeenCalled();
    s.invalidate = '"cart"';
    await bus.dispatch('cartAdd', {});
    await bus.dispatch('cartAdd', {});
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('Cache-Group-Invalidation');
    bus.dispose();
  });
});

describe('cacheMode: the Fetch cache mode of one request', () => {
  it('reaches fetch when set, and a read in one mode never joins a read in another', async () => {
    const real = globalThis.fetch;
    const modes: Array<RequestCache | undefined> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => { modes.push(init?.cache); return real(input, init); });
    const http = client();
    await Promise.all([http.get('/plain'), http.get('/plain', { cacheMode: 'no-cache' })]);
    expect(modes.sort()).toEqual(['no-cache', undefined]);
  });
});

/*
 * The server declares, the client obeys (record revision 15, RFC 9875). A read's
 * response carries `Cache-Groups`; a write's answer names the groups it changed in
 * `Cache-Group-Invalidation`, on the response or in a batched result's or a frame's
 * `headers` member. The client drops its cached reads in those groups and tells its
 * listeners, the router's loader data among them (tests/router/cache-groups.test.ts).
 *
 * A read on the wire when a group goes has groups nobody knows yet, so none is stored
 * and none is joined: a fetch, never stale data (decisions.md 2026-10-01).
 *
 * The transport without a client (postCommand's path) has nothing to invalidate: it
 * warns once in development, so an app learns to share one client.
 */
