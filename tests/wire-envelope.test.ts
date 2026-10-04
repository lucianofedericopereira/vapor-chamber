/** One command envelope on every transport (log s35.138). */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAsyncCommandBus } from '../src/command-bus';
import { createBatchingHttpBridge, createHttpBridge, createWsBridge } from '../src/transports';
import { MockWebSocket } from './backend-stubs';

const bodies: any[] = [];
const headersSent: Record<string, string>[] = [];
const reply = (body: unknown) => ({ ok: true, status: 200, url: '', redirected: false, headers: { entries: () => [['content-type', 'application/json']], get: () => 'application/json' }, text: async () => JSON.stringify(body) });
const stubFetch = () => vi.stubGlobal('fetch', vi.fn(async (_u: string, init: RequestInit) => {
  const body = JSON.parse(init.body as string);
  bodies.push(body); headersSent.push(init.headers as Record<string, string>);
  return reply(body.commands ? { results: body.commands.map((c: { id: string }) => ({ id: c.id, state: 1 })) } : { state: 1 });
}));
const keyed = (bus: ReturnType<typeof createAsyncCommandBus>) => bus.use((cmd, next) => { cmd.meta!.idempotencyKey = 'k1'; return next(); });
afterEach(() => { vi.unstubAllGlobals(); bodies.length = 0; headersSent.length = 0; });

describe('the command envelope', () => {
  it('single HTTP: no id, no meta when there is nothing to send', async () => {
    stubFetch();
    const bus = createAsyncCommandBus({ retry: false });
    bus.use(createHttpBridge({ endpoint: '/vc' }));
    await bus.dispatch('a', 1, { x: 1 });
    expect(bodies[0]).toEqual({ command: 'a', target: 1, payload: { x: 1 } });
  });

  it('single HTTP: the key in meta, and the Idempotency-Key header for standard tooling', async () => {
    stubFetch();
    const bus = createAsyncCommandBus({ retry: false });
    keyed(bus);
    bus.use(createHttpBridge({ endpoint: '/vc' }));
    await bus.dispatch('a', 1);
    expect(bodies[0]).toEqual({ command: 'a', target: 1, meta: { idempotencyKey: 'k1' } });
    expect(headersSent[0]!['Idempotency-Key']).toBe('"k1"');
  });

  it('carries the command chain: a caused command sends its correlation and causation', async () => {
    stubFetch();
    const bus = createAsyncCommandBus({ retry: false });
    bus.use(createHttpBridge({ endpoint: '/vc' }));
    await bus.dispatch('child', 1, { __causationId: 'c1' });
    expect(bodies[0].meta).toEqual({ correlationId: 'c1', causationId: 'c1' });
  });

  it('batched HTTP: each command is the same envelope with its id; the key inside meta', async () => {
    stubFetch();
    const bus = createAsyncCommandBus({ retry: false });
    keyed(bus);
    bus.use(createBatchingHttpBridge({ endpoint: '/vc' }));
    await Promise.all([bus.dispatch('a', 1), bus.dispatch('b', 2)]);
    expect(bodies[0].commands).toEqual([
      { id: expect.any(String), command: 'a', target: 1, meta: { idempotencyKey: 'k1' } },
      { id: expect.any(String), command: 'b', target: 2, meta: { idempotencyKey: 'k1' } },
    ]);
  });

  it('WebSocket: the same envelope, its id, and the key it never sent before', async () => {
    let ws!: MockWebSocket;
    vi.stubGlobal('WebSocket', class extends MockWebSocket { constructor(u: string) { super(u); ws = this; } });
    const bus = createAsyncCommandBus({ retry: false });
    keyed(bus);
    const bridge = createWsBridge({ url: 'ws://x' });
    bus.use(bridge);
    bridge.connect();
    await Promise.resolve();
    void bus.dispatch('a', 1);
    await Promise.resolve();
    expect(JSON.parse(ws.sent[0]!)).toEqual({ id: expect.any(String), command: 'a', target: 1, meta: { idempotencyKey: 'k1' } });
  });
});
