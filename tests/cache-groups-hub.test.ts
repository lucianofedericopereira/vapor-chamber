/** One group hub per bus: every source reaches cache(), the client's store and the router, once (audit M2). Rationale at the end. */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Accepted } from '../src/accepted';
import { createAsyncCommandBus, createCommandBus, inspectBus, type CommandResult } from '../src/command-bus';
import { createHttpClient, type HttpClient } from '../src/http';
import { cache } from '../src/plugins-extra';
import { fetchLoaders } from '../src/router-fetch/index';
import { httpTransport } from '../src/transports';
import { createMemoryHistory } from '@router/history';
import { createRouter } from '@router/index';

/** GETs answer `{ v }`, `/users` and `/team` in the group "users"; a POST answers with `invalidate`, a batch with `batchHeaders` per result. */
const s = { gets: [] as string[], invalidate: '', batchHeaders: {} as Record<string, string> };
let server: Server;
let base = '';
beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const url = req.url as string;
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (req.method === 'GET') {
        s.gets.push(url);
        headers['cache-groups'] = '"users"';
        res.writeHead(200, headers);
        res.end(JSON.stringify({ v: s.gets.length }));
        return;
      }
      if (url === '/batch') {
        const { commands } = JSON.parse(body) as { commands: Array<{ id: string }> };
        res.writeHead(200, headers);
        res.end(JSON.stringify({ results: commands.map((c) => ({ id: c.id, status: 200, headers: s.batchHeaders, state: 'ok' })) }));
        return;
      }
      if (s.invalidate) headers['cache-group-invalidation'] = s.invalidate;
      res.writeHead(200, headers);
      res.end('{"state":"ok"}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => Object.assign(s, { gets: [], invalidate: '', batchHeaders: {} }));
afterEach(() => vi.restoreAllMocks());

const got = (url: string) => s.gets.filter((g) => g === url).length;
const cached = { cache: { ttl: 60_000 } };

/** The three readers on one client: cache() on the bus, the client's store (`/users`), the router (`/team`). */
async function world(http: HttpClient | undefined) {
  const transport = httpTransport({ endpoint: `${base}/batch`, httpClient: http, batch: {} });
  const bus = createAsyncCommandBus({ retry: false, transport: { 'api*': transport } });
  let runs = 0;
  bus.register('userGet', async () => ++runs, { cacheGroups: ['users'] });
  bus.register('userSave', async () => 'ok', { cacheGroupInvalidation: ['users'] });
  bus.use(cache({ actions: ['userGet'] }));
  await bus.dispatch('userGet', {});
  await bus.dispatch('userGet', {});
  const heard: string[] = [];
  let router: ReturnType<typeof createRouter> | undefined;
  if (http) {
    http.onInvalidateGroup((g) => heard.push(g));
    await http.get('/users', cached);
    router = createRouter({
      history: createMemoryHistory('/'),
      routes: [{ name: 'team', path: '/', component: 'P', load: '/team' }] as never,
      components: { P: { name: 'P' } },
      http,
      loaders: fetchLoaders(),
      scroll: false,
      links: false,
      announce: false,
      onError: () => {},
    });
    await router.isReady();
  }
  return { bus, http, router, heard, runs: () => runs };
}

type World = Awaited<ReturnType<typeof world>>;

const SOURCES: Array<[string, (w: World) => Promise<unknown>]> = [
  ['a local write declared on register', (w) => w.bus.dispatch('userSave', {})],
  ["a transport's answer (a batched result's header)", (w) => { s.batchHeaders = { 'Cache-Group-Invalidation': '"users"' }; return w.bus.dispatch('apiSave', {}); }],
  ["the client's own write header", (w) => { s.invalidate = '"users"'; return w.http!.post('/vc', {}); }],
  ['an app calling client.invalidateGroups()', async (w) => w.http!.invalidateGroups(['users'])],
];

describe.each(SOURCES)('%s', (_name, source) => {
  it('reaches cache(): the cached result is dropped, heard once', async () => {
    const w = await world(createHttpClient({ baseURL: base }));
    expect(w.runs()).toBe(1);
    await source(w);
    await w.bus.dispatch('userGet', {});
    expect({ runs: w.runs(), heard: w.heard }).toEqual({ runs: 2, heard: ['users'] });
    w.router!.dispose();
  });

  it("reaches the client's store: the stored read is dropped, heard once", async () => {
    const w = await world(createHttpClient({ baseURL: base }));
    await source(w);
    await w.http!.get('/users', cached);
    expect({ users: got('/users'), heard: w.heard }).toEqual({ users: 2, heard: ['users'] });
    w.router!.dispose();
  });

  it('reaches the router: the record in the group refreshes once', async () => {
    const w = await world(createHttpClient({ baseURL: base }));
    expect(got('/team')).toBe(1);
    await source(w);
    await vi.waitFor(() => expect(got('/team')).toBe(2));
    await vi.waitFor(() => expect(w.router!.isRevalidating.value).toBe(false));
    expect({ team: got('/team'), heard: w.heard }).toEqual({ team: 2, heard: ['users'] });
    w.router!.dispose();
  });
});

describe('a bus with no client', () => {
  it('a local write and a transport answer reach cache(), with no warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const w = await world(undefined);
    await w.bus.dispatch('userSave', {});
    await w.bus.dispatch('userGet', {});
    s.batchHeaders = { 'Cache-Group-Invalidation': '"users"' };
    await w.bus.dispatch('apiSave', {});
    await w.bus.dispatch('userGet', {});
    expect({ runs: w.runs(), warned: warn.mock.calls.length }).toEqual({ runs: 3, warned: 0 });
  });

  it('the sync bus: a local write drops the cached result of an action in the group; another group keeps it', () => {
    const bus = createCommandBus();
    let runs = 0;
    bus.register('userGet', () => ++runs, { cacheGroups: ['users'] });
    bus.register('orderSave', () => 'ok', { cacheGroupInvalidation: ['orders'] });
    bus.register('userSave', () => 'ok', { cacheGroupInvalidation: ['users'] });
    bus.use(cache({ actions: ['userGet'] }));
    bus.dispatch('userGet', {});
    bus.dispatch('orderSave', {});
    bus.dispatch('userGet', {});
    expect(runs).toBe(1);
    bus.dispatch('userSave', {});
    bus.dispatch('userGet', {});
    expect(runs).toBe(2);
  });
});

describe('the local write', () => {
  it('a failure invalidates nothing', async () => {
    const http = createHttpClient({ baseURL: base });
    const bus = createAsyncCommandBus({ retry: false, transport: { 'api*': httpTransport({ endpoint: `${base}/vc`, httpClient: http }) } });
    const heard: string[] = [];
    http.onInvalidateGroup((g) => heard.push(g));
    bus.register('userSave', async () => { throw new Error('refused'); }, { cacheGroupInvalidation: ['users'] });
    expect((await bus.dispatch('userSave', {})).ok).toBe(false);
    expect(heard).toEqual([]);
  });

  it("an Accepted invalidates once its done settles ok, never when it fails", async () => {
    const http = createHttpClient({ baseURL: base });
    const bus = createAsyncCommandBus({ retry: false, transport: { 'api*': httpTransport({ endpoint: `${base}/vc`, httpClient: http }) } });
    const heard: string[] = [];
    http.onInvalidateGroup((g) => heard.push(g));
    let finish!: (r: CommandResult) => void;
    bus.register('reportRun', async () => new Accepted(() => new Promise((r) => { finish = r; })), { cacheGroupInvalidation: ['users'] });
    const first = await bus.dispatch('reportRun', {});
    void (first.value as Accepted).done;
    expect(heard).toEqual([]);
    finish({ ok: true });
    await vi.waitFor(() => expect(heard).toEqual(['users']));
    const second = await bus.dispatch('reportRun', {});
    void (second.value as Accepted).done;
    finish({ ok: false, error: new Error('job failed') });
    await new Promise((r) => setTimeout(r, 10));
    expect(heard).toEqual(['users']);
  });

  it('unregister takes both declarations out', async () => {
    const http = createHttpClient({ baseURL: base });
    const bus = createAsyncCommandBus({ retry: false, transport: { 'api*': httpTransport({ endpoint: `${base}/vc`, httpClient: http }) } });
    const heard: string[] = [];
    http.onInvalidateGroup((g) => heard.push(g));
    let runs = 0;
    bus.register('userGet', async () => ++runs, { cacheGroups: ['users'] })();
    bus.register('userGet', async () => ++runs);
    bus.register('userSave', async () => 'ok', { cacheGroupInvalidation: ['users'] })();
    bus.register('userSave', async () => 'ok');
    bus.use(cache({ actions: ['userGet'] }));
    await bus.dispatch('userGet', {});
    await bus.dispatch('userSave', {});
    http.invalidateGroups(['users']);
    await bus.dispatch('userGet', {});
    // The app's call is heard; the write declares nothing now, and userGet is in no group.
    expect({ runs, heard }).toEqual({ runs: 1, heard: ['users'] });
  });

  it('bus.clear() takes the declarations out with the registrations', () => {
    const bus = createCommandBus();
    let runs = 0;
    bus.register('userGet', () => ++runs, { cacheGroups: ['users'] });
    bus.register('userSave', () => 'ok', { cacheGroupInvalidation: ['users'] });
    bus.clear();
    bus.register('userGet', () => ++runs);
    bus.register('userSave', () => 'ok');
    bus.register('teamSave', () => 'ok', { cacheGroupInvalidation: ['users'] });
    bus.use(cache({ actions: ['userGet'] }));
    bus.dispatch('userGet', {});
    bus.dispatch('userSave', {});
    bus.dispatch('teamSave', {});
    bus.dispatch('userGet', {});
    expect(runs).toBe(1);
  });
});

describe('the group listener only with a hub', () => {
  const declared = () => {
    const bus = createCommandBus();
    let runs = 0;
    bus.register('userGet', () => ++runs, { cacheGroups: ['users'] });
    const off = bus.register('userSave', () => 'ok', { cacheGroupInvalidation: ['users'] });
    return { bus, off, runs: () => runs };
  };

  it('a declared bus with no hub carries no listener, so it keeps the bare path; cache() puts it on', () => {
    const { bus } = declared();
    expect(inspectBus(bus).listenerPatterns).toEqual([]);
    bus.use(cache({ actions: ['userGet'] }));
    expect(inspectBus(bus).listenerPatterns).toEqual(['userSave']);
  });

  it.each([
    ['register, then cache()', false],
    ['cache(), then register', true],
  ])('%s: the local write drops the cached result', (_name, cacheFirst) => {
    const bus = createCommandBus();
    let runs = 0;
    if (cacheFirst) bus.use(cache({ actions: ['userGet'] }));
    bus.register('userGet', () => ++runs, { cacheGroups: ['users'] });
    bus.register('userSave', () => 'ok', { cacheGroupInvalidation: ['users'] });
    if (!cacheFirst) bus.use(cache({ actions: ['userGet'] }));
    bus.dispatch('userGet', {});
    bus.dispatch('userSave', {});
    bus.dispatch('userGet', {});
    expect({ runs, listeners: inspectBus(bus).listenerPatterns }).toEqual({ runs: 2, listeners: ['userSave'] });
  });

  it('a declaration taken out before the hub is made, by unregister or clear(), puts no listener on', () => {
    const a = declared();
    a.off();
    a.bus.use(cache());
    const b = declared();
    b.bus.clear();
    b.bus.use(cache());
    expect([inspectBus(a.bus).listenerPatterns, inspectBus(b.bus).listenerPatterns]).toEqual([[], []]);
  });
});

describe('cache() across an invalidation', () => {
  it('a result in flight across it answers its caller and is not stored', async () => {
    const bus = createAsyncCommandBus({ retry: false });
    let runs = 0;
    let release!: () => void;
    bus.register('userGet', async () => { const n = ++runs; if (n === 1) await new Promise<void>((r) => { release = r; }); return n; }, { cacheGroups: ['users'] });
    bus.register('userSave', async () => 'ok', { cacheGroupInvalidation: ['users'] });
    bus.use(cache({ actions: ['userGet'] }));
    const first = bus.dispatch('userGet', {});
    await bus.dispatch('userSave', {});
    release();
    expect((await first).value).toBe(1);
    expect((await bus.dispatch('userGet', {})).value).toBe(2);
  });

  it('control: with no invalidation the second read is a hit', async () => {
    const bus = createAsyncCommandBus({ retry: false });
    let runs = 0;
    bus.register('userGet', async () => ++runs, { cacheGroups: ['users'] });
    bus.use(cache({ actions: ['userGet'] }));
    await bus.dispatch('userGet', {});
    expect((await bus.dispatch('userGet', {})).value).toBe(1);
  });
});

describe('one bus, one client for its groups', () => {
  it('a second, different client warns in development; the same client twice does not', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const a = createHttpClient({ baseURL: base });
    createAsyncCommandBus({ transport: { 'a*': httpTransport({ endpoint: '/a', httpClient: a }), 'b*': httpTransport({ endpoint: '/b', httpClient: a }) } });
    expect(warn).not.toHaveBeenCalled();
    createAsyncCommandBus({ transport: { 'a*': httpTransport({ endpoint: '/a', httpClient: a }), 'b*': httpTransport({ endpoint: '/b', httpClient: createHttpClient() }) } });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('transport:conflict:client');
  });
});

/*
 * One group namespace (RFC 9875 Cache-Groups and Cache-Group-Invalidation, the
 * coordinator's ruling of 2026-10-21): a group name means one set, local or
 * server. The client already was the lane (revision 23 item 3), so its pair
 * `invalidateGroups` / `onInvalidateGroup` is the hub, and a bus's transport
 * client is that bus's hub. A bus with no client gets an own hub from its
 * first reader (cache()).
 *
 * Sources call the hub; readers listen. No reader emits, so nothing loops and
 * no marker is needed. The counting listener in `world` hears each group once
 * per source: that is the "once" of every cell.
 *
 * The side that knows declares, once, at register: `cacheGroups` (a cached
 * result joins them) and `cacheGroupInvalidation` (a success makes them stale).
 * The local write is one exact listener for its action alone, so an action that
 * declares nothing runs the code it ran. An Accepted invalidates on its done, as
 * revalidateRoutes refreshes.
 */
