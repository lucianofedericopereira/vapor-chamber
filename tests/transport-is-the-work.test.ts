/** A transport is declared at the bus and is the work for its actions, never a plugin. The long note is at the end. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBuffer } from '../src/buffer';
import { createAsyncCommandBus, inspectBus } from '../src/command-bus';
import { _asLibrary } from '../src/library-names';
import { createTestBus } from '../src/testing';
import * as transports from '../src/transports';
import { history } from '../src/plugins-core';

type Anyfn = (...a: any[]) => any;
const httpTransport = (o: unknown) => (transports as unknown as Record<string, Anyfn>).httpTransport(o);
const wsTransport = (o: unknown) => (transports as unknown as Record<string, Anyfn>).wsTransport(o);
const defineTransport = (f: unknown, o?: unknown) => (transports as unknown as Record<string, Anyfn>).defineTransport(f, o);
const opts = (o: Record<string, unknown>) => o as never;

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': status < 300 ? 'application/json' : 'application/problem+json', ...headers } });

/** fetch answering `{ state: <url>:<command> }`, recording each request body. */
function server(answer?: (n: number) => Response) {
  const sent: Array<{ url: string; body: any }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    sent.push({ url, body });
    return answer ? answer(sent.length) : json(200, { state: `${url}:${body?.command ?? body?.commands?.length}` });
  }));
  return sent;
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('the transport is the work', () => {
  it('declared at the bus, it sends a command and answers its state', async () => {
    const sent = server();
    const bus = createAsyncCommandBus(opts({ retry: false, transport: httpTransport({ endpoint: '/vc' }) }));
    const r = await bus.dispatch('cartAdd', { id: 1 });
    expect(r).toMatchObject({ ok: true, value: '/vc:cartAdd' });
    expect(sent).toHaveLength(1);
  });

  it('a map by action pattern: the most specific wins, whatever the written order', async () => {
    server();
    const bus = createAsyncCommandBus(opts({ retry: false, transport: {
      '*': httpTransport({ endpoint: '/all' }),
      'chat*': httpTransport({ endpoint: '/chat' }),
      chatPin: httpTransport({ endpoint: '/pin' }),
    } }));
    expect((await bus.dispatch('cartAdd', {})).value).toBe('/all:cartAdd');
    expect((await bus.dispatch('chatSend', {})).value).toBe('/chat:chatSend');
    expect((await bus.dispatch('chatPin', {})).value).toBe('/pin:chatPin');
  });

  it("a `$` action is the library's: it runs locally, never sent", async () => {
    const sent = server();
    const bus = createAsyncCommandBus(opts({ retry: false, transport: httpTransport({ endpoint: '/vc' }) }));
    _asLibrary(() => bus.register('cart$reset', async () => 'local'));
    expect((await bus.dispatch('cart$reset', {})).value).toBe('local');
    expect(sent).toHaveLength(0);
  });

  it('history records the sent command', async () => {
    server();
    const bus = createAsyncCommandBus(opts({ retry: false, transport: httpTransport({ endpoint: '/vc' }) }));
    const h = history({ bus });
    await bus.dispatch('cartAdd', { id: 1 });
    expect(h.getState().past.map((c) => c.action)).toEqual(['cartAdd']);
  });

  it('bus.use refuses a transport with a code, one with an `attach` too, on the async bus and the test bus', () => {
    const codeOf = (f: () => unknown) => { try { f(); } catch (e) { return (e as { code?: string }).code; } return 'no throw'; };
    for (const bus of [createAsyncCommandBus(), createTestBus()]) {
      expect(codeOf(() => bus.use(httpTransport({ endpoint: '/vc' }) as never))).toBe('core:invalid:plugin');
      expect(codeOf(() => bus.use(transports.wsTransport({ url: 'ws://localhost:1', reconnect: false }) as never))).toBe('core:invalid:plugin');
      // Control: a plugin whose only part is `attach` installs.
      expect(codeOf(() => bus.use({ attach: () => {} }))).toBe('no throw');
    }
  });

  it("the bus's retry re-sends through the transport; a listener hears one dispatch", async () => {
    const sent = server((n) => (n === 1 ? json(503, { status: 503, code: 'busy', detail: 'busy' }) : json(200, { state: 'ok' })));
    const bus = createAsyncCommandBus(opts({ retry: { baseDelay: 1 }, transport: httpTransport({ endpoint: '/vc' }) }));
    const heard: string[] = [];
    bus.on('*', (cmd) => { heard.push(cmd.action); });
    expect((await bus.dispatch('cartAdd', {})).ok).toBe(true);
    expect(sent).toHaveLength(2);
    expect(heard).toEqual(['cartAdd']);
  });

  it("the answer is written where the work is: the action's `answer` hears the state", async () => {
    server(() => json(200, { state: { count: 2 } }));
    const bus = createAsyncCommandBus(opts({ retry: false, transport: httpTransport({ endpoint: '/vc' }) }));
    const answered: unknown[] = [];
    bus.register('cartAdd', null, { answer: (_cmd, value) => { answered.push(value); } });
    await bus.dispatch('cartAdd', {});
    expect(answered).toEqual([{ count: 2 }]);
  });

  it('query() sends through the transport as dispatch() does', async () => {
    const sent = server();
    const bus = createAsyncCommandBus(opts({ retry: false, transport: httpTransport({ endpoint: '/vc' }) }));
    expect((await bus.query('cartLoad', {})).value).toBe('/vc:cartLoad');
    expect(sent).toHaveLength(1);
  });

  it('a buffer sends an action a transport covers instead of holding it', async () => {
    const sent = server();
    const bus = createAsyncCommandBus(opts({ retry: false, buffer: createBuffer(), transport: httpTransport({ endpoint: '/vc' }) }));
    expect((await bus.dispatch('cartAdd', {})).ok).toBe(true);
    expect(sent).toHaveLength(1);
  });

  it("request(): the call's own responder answers, not the transport", async () => {
    const sent = server();
    const bus = createAsyncCommandBus(opts({ retry: false, transport: httpTransport({ endpoint: '/vc' }) }));
    bus.respond('price', async () => 42);
    expect((await bus.request('price', {})).value).toBe(42);
    expect(sent).toHaveLength(0);
  });

  it("defineTransport(send): an app's own, with the local handler as its fallback", async () => {
    const bus = createAsyncCommandBus(opts({ retry: false, transport: defineTransport(async (cmd: { action: string }, local: () => Promise<unknown>) => (cmd.action === 'offline' ? local() : { ok: true, value: 'remote' }), { localFallback: true }) }));
    bus.register('offline', async () => 'local');
    expect((await bus.dispatch('online', {})).value).toBe('remote');
    expect((await bus.dispatch('offline', {})).value).toBe('local');
  });

  it("a plain { send } object with no id: reported and failing as 'transport'", async () => {
    const bus = createAsyncCommandBus(opts({ retry: false, transport: { send: () => { throw new Error('bug'); } } }));
    expect((inspectBus(bus) as unknown as { transports: unknown }).transports).toEqual([{ pattern: '*', id: 'transport' }]);
    expect((await bus.dispatch('cartAdd', {})).error).toMatchObject({ code: 'transport:failed:send' });
  });

  it('production: the refusal carries the fact, the advice is DEV only', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.resetModules();
    const fresh = await import('../src/command-bus');
    let message = '';
    try { fresh.createAsyncCommandBus().use({} as never); } catch (e) { message = (e as Error).message; }
    expect(message).toBe("use() takes a plugin's parts: an object with a part the bus places.");
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("inspectBus reports the transports apart from the plugins; dispose() disposes them", () => {
    let disposed = 0;
    const t = Object.assign(defineTransport(async () => ({ ok: true })), { dispose: () => { disposed++; } });
    const bus = createAsyncCommandBus(opts({ transport: { 'cart*': t, '*': httpTransport({ endpoint: '/vc' }) } }));
    const seen = inspectBus(bus) as unknown as { transports?: unknown; plugins: unknown[] };
    expect(seen.transports).toEqual([{ pattern: 'cart*', id: 'transport' }, { pattern: '*', id: 'transport' }]);
    expect(seen.plugins).toEqual([]);
    bus.dispose();
    expect(disposed).toBe(1);
  });

  it('the test bus takes the same option and runs it as the work', async () => {
    const sent = server();
    const bus = createTestBus(opts({ transport: httpTransport({ endpoint: '/vc' }) })) as unknown as { dispatch: (a: string, t: unknown) => Promise<{ value?: unknown }> };
    expect((await bus.dispatch('cartAdd', {})).value).toBe('/vc:cartAdd');
    expect(sent).toHaveLength(1);
  });

  it('batching is an option of the one HTTP transport: one tick, one request', async () => {
    const sent = server(() => json(200, { results: [{ id: '1', state: 'a' }, { id: '2', state: 'b' }] }));
    const bus = createAsyncCommandBus(opts({ retry: false, transport: httpTransport({ endpoint: '/vc/batch', batch: {} }) }));
    await Promise.all([bus.dispatch('a', {}), bus.dispatch('b', {})]);
    expect(sent).toHaveLength(1);
    expect(sent[0].body.commands).toHaveLength(2);
  });

  it('the WebSocket transport keeps its connection controls', () => {
    const t = wsTransport({ url: 'wss://example.test/vc' });
    expect([typeof t.connect, typeof t.disconnect, typeof t.send]).toEqual(['function', 'function', 'function']);
  });
});

/*
 * Step 3a of .probes/plan-1.32.md (plan-transport-owned.md F1 and R1-R9; the
 * prototype 18c6326 proved the shape on the 23 built-ins). The bus runs the
 * action's transport where it runs a local handler: inside every plugin,
 * under the retry, with the answer written there. A transport is declared
 * once at the bus, one or a map by action pattern resolved by the most
 * specific match, and `use()` refuses one. The names follow a collision grep:
 * `httpTransport`, `wsTransport`, `defineTransport` (the router's `http` option
 * is an HTTP client, a second meaning for `http`). Each test is red before:
 * the factories do not exist, the option is ignored, `use()` accepts a bridge.
 */
