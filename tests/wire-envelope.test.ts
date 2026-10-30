/**
 * The command envelope on single HTTP, batched HTTP and WebSocket, with its HTTP metadata (idempotency key, Accept, status) as headers.
 * Why: a key sent in the body or `meta`, a missing Accept, or a result status that is ignored would make backends mis-read the same command differently per transport; a key no header can carry would be sent anyway.
 * Shows: single HTTP sends the key only as the `Idempotency-Key` header, while a batch item and a WebSocket frame carry it in a `headers` member; `meta` holds correlation and causation; Accept is set once and an app's own wins, and a client read keeps X-Requested-With while a command sends none; a batched result or frame status stands in for a problem with none; an unencodable key fails as `transport:failed:send` with nothing sent.
 * See: log s35.138, log s36.47, OData JSON Format 4.01 19.1 and 19.5
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAsyncCommandBus, type BusError } from '../src/command-bus';
import { createHttpClient } from '../src/http';
import { idempotent } from '../src/plugins-extra';
import { httpTransport, wsTransport } from '../src/transports';
import { MockWebSocket } from './backend-stubs';

const ACCEPT = 'application/json, application/problem+json';
const bodies: any[] = [];
const headersSent: Record<string, string>[] = [];
const reply = (body: unknown) => ({ ok: true, status: 200, url: '', redirected: false, headers: { entries: () => [['content-type', 'application/json']], get: () => 'application/json' }, text: async () => JSON.stringify(body) });
const stubFetch = (result: (c: { id: string }) => unknown = (c) => ({ id: c.id, state: 1 })) => vi.stubGlobal('fetch', vi.fn(async (_u: string, init: RequestInit) => {
  const body = init.body ? JSON.parse(init.body as string) : undefined;
  bodies.push(body); headersSent.push(init.headers as Record<string, string>);
  return reply(body?.commands ? { results: body.commands.map(result) } : { state: 1 });
}));
const keyed = (bus: ReturnType<typeof createAsyncCommandBus>) => bus.use({ started: (cmd) => { cmd.meta!.idempotencyKey = 'k1'; } });

/** A bus on a connected wsTransport; `socket` is the server end. */
async function wsBus() {
  let socket!: MockWebSocket;
  vi.stubGlobal('WebSocket', class extends MockWebSocket { constructor(u: string) { super(u); socket = this; } });
  const transport = wsTransport({ url: 'ws://x' });
  const bus = createAsyncCommandBus({ retry: false, transport });
  transport.connect();
  await Promise.resolve();
  return { bus, socket: () => socket };
}

afterEach(() => { vi.unstubAllGlobals(); bodies.length = 0; headersSent.length = 0; });

describe('the command envelope', () => {
  it('single HTTP: no id, no meta when there is nothing to send', async () => {
    stubFetch();
    const bus = createAsyncCommandBus({ retry: false, transport: httpTransport({ endpoint: '/vc' }) });
    await bus.dispatch('a', 1, { x: 1 });
    expect(bodies[0]).toEqual({ command: 'a', target: 1, payload: { x: 1 } });
  });

  it('single HTTP: the key is the Idempotency-Key header only, never in the body', async () => {
    stubFetch();
    const bus = createAsyncCommandBus({ retry: false, transport: httpTransport({ endpoint: '/vc' }) });
    keyed(bus);
    await bus.dispatch('a', 1);
    expect(bodies[0]).toEqual({ command: 'a', target: 1 });
    expect(headersSent[0]!['Idempotency-Key']).toBe('"k1"');
  });

  it('carries the command chain: a caused command sends its correlation and causation in meta', async () => {
    stubFetch();
    const bus = createAsyncCommandBus({ retry: false, transport: httpTransport({ endpoint: '/vc' }) });
    await bus.dispatch('child', 1, { __causationId: 'c1' });
    expect(bodies[0].meta).toEqual({ correlationId: 'c1', causationId: 'c1' });
  });

  it('batched HTTP: each command is the same envelope with its id; the key in its headers member', async () => {
    stubFetch();
    const bus = createAsyncCommandBus({ retry: false, transport: httpTransport({ endpoint: '/vc', batch: {} }) });
    keyed(bus);
    await Promise.all([bus.dispatch('a', 1), bus.dispatch('b', 2)]);
    expect(bodies[0].commands).toEqual([
      { id: expect.any(String), command: 'a', target: 1, headers: { 'Idempotency-Key': '"k1"' } },
      { id: expect.any(String), command: 'b', target: 2, headers: { 'Idempotency-Key': '"k1"' } },
    ]);
    // The key is the command's, not the request's.
    expect(Object.keys(headersSent[0]!).map((n) => n.toLowerCase())).not.toContain('idempotency-key');
  });

  it('batched HTTP: an unkeyed command has no headers member', async () => {
    stubFetch();
    const bus = createAsyncCommandBus({ retry: false, transport: httpTransport({ endpoint: '/vc', batch: {} }) });
    await bus.dispatch('a', 1);
    expect(bodies[0].commands).toEqual([{ id: expect.any(String), command: 'a', target: 1 }]);
  });

  it('WebSocket: the same envelope, its id, the key in its headers member', async () => {
    const { bus, socket } = await wsBus();
    keyed(bus);
    void bus.dispatch('a', 1);
    await Promise.resolve();
    expect(JSON.parse(socket().sent[0]!)).toEqual({ id: expect.any(String), command: 'a', target: 1, headers: { 'Idempotency-Key': '"k1"' } });
  });
});

describe('Accept on the wire', () => {
  it('a command asks for JSON with Accept, single and batched, and sends no X-Requested-With', async () => {
    stubFetch();
    await createAsyncCommandBus({ retry: false, transport: httpTransport({ endpoint: '/vc' }) }).dispatch('a', 1);
    await createAsyncCommandBus({ retry: false, transport: httpTransport({ endpoint: '/vc', batch: {} }) }).dispatch('a', 1);
    for (const sent of headersSent) {
      expect(sent.Accept).toBe(ACCEPT);
      expect(Object.keys(sent).map((n) => n.toLowerCase())).not.toContain('x-requested-with');
    }
    expect(headersSent).toHaveLength(2);
  });

  it("an app's own Accept, in any spelling, goes out once and wins", async () => {
    stubFetch();
    await createAsyncCommandBus({ retry: false, transport: httpTransport({ endpoint: '/vc', headers: { accept: 'application/vnd.app+json' } }) }).dispatch('a', 1);
    expect(headersSent[0]).toMatchObject({ Accept: 'application/vnd.app+json' });
    expect(Object.keys(headersSent[0]!).filter((n) => n.toLowerCase() === 'accept')).toHaveLength(1);
  });

  it('a read through the client keeps X-Requested-With beside Accept', async () => {
    stubFetch();
    await createHttpClient().get('/items');
    expect(headersSent[0]).toMatchObject({ Accept: ACCEPT, 'X-Requested-With': 'XMLHttpRequest' });
  });
});

describe("a multiplexed answer's own status", () => {
  it('a batched problem with no status of its own reads the result status', async () => {
    stubFetch((c) => ({ id: c.id, status: 409, headers: {}, problem: { code: 'stale' } }));
    const r = await createAsyncCommandBus({ retry: false, transport: httpTransport({ endpoint: '/vc', batch: {} }) }).dispatch('a', 1);
    expect(r).toFailWith('remote:conflict:stale');
  });

  it("the problem's own status wins over the result's", async () => {
    stubFetch((c) => ({ id: c.id, status: 200, headers: {}, problem: { status: 404, code: 'gone' } }));
    const r = await createAsyncCommandBus({ retry: false, transport: httpTransport({ endpoint: '/vc', batch: {} }) }).dispatch('a', 1);
    expect(r).toFailWith('remote:missing:gone');
  });

  it('a WebSocket frame reads the same way', async () => {
    const { bus, socket } = await wsBus();
    const pending = bus.dispatch('a', 1);
    await Promise.resolve();
    socket().receive({ id: JSON.parse(socket().sent[0]!).id, status: 429, headers: { 'Retry-After': '2' }, problem: { code: 'busy' } });
    const r = await pending;
    expect(r).toFailWith('remote:limited:busy');
    expect((r.error as BusError).context?.retryIn).toBe(2000);
  });
});

describe('a key no header can carry', () => {
  it('fails the dispatch as transport:failed:send on every wire, nothing sent', async () => {
    stubFetch();
    const lone = idempotent({ key: () => '\uD800' });
    const single = createAsyncCommandBus({ retry: false, transport: httpTransport({ endpoint: '/vc' }) });
    const batched = createAsyncCommandBus({ retry: false, transport: httpTransport({ endpoint: '/vc', batch: {} }) });
    single.use(lone);
    batched.use(idempotent({ key: () => '\uD800' }));
    expect(await single.dispatch('a', 1)).toFailWith('transport:failed:send');
    expect(await batched.dispatch('a', 1)).toFailWith('transport:failed:send');
    expect(bodies).toHaveLength(0);
    const { bus, socket } = await wsBus();
    bus.use(idempotent({ key: () => '\uD800' }));
    expect(await bus.dispatch('a', 1)).toFailWith('transport:failed:send');
    expect(socket().sent).toHaveLength(0);
  });
});
