/** The library's `$` commands (`<action>$undo`, `<id>$reset`) stay local: no bridge sends them, the outbox never queues them. Log s35.114. */
import { afterEach, describe, expect, vi } from 'vitest';
import { createAsyncCommandBus } from '../src/command-bus';
import { createOutbox } from '../src/outbox';
import { history, optimisticUndo } from '../src/plugins-core';
import { defineChamberStore } from '../src/store';
import { createBatchingHttpBridge, createHttpBridge, createWsBridge } from '../src/transports';
import { it } from '../src/vitest';
import { MockWebSocket } from './backend-stubs';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const settle = () => new Promise((r) => setTimeout(r, 0));

function failingServer() {
  const posted: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body);
    for (const c of body.commands ?? [body]) posted.push(c.command);
    return { ok: false, status: 503, headers: new Headers(), text: async () => 'down' };
  }));
  return posted;
}

describe("a bridge forwarding cart* does not send the library's $ commands", () => {
  it('optimisticUndo: the rollback runs here, the server sees only the command', async () => {
    const posted = failingServer();
    const bus = createAsyncCommandBus({ retry: false });
    let undone = 0;
    bus.register('cartAdd', async () => 1, { undo: () => { undone++; } });
    bus.use(optimisticUndo(bus as never, ['cartAdd'], { onRollbackError: () => {} }));
    bus.use(createHttpBridge({ endpoint: '/api/vc', actions: ['cart*'] }));
    await bus.dispatch('cartAdd', { id: 1 });
    await settle();
    await settle();
    expect(posted).toEqual(['cartAdd']);
    expect(undone).toBe(1);
  });

  it('history undo and a store $reset go to their local handlers, through the batching bridge too', async () => {
    const posted = failingServer();
    const bus = createAsyncCommandBus({ retry: false });
    const h = history({ bus });
    bus.use(h);
    const useCart = defineChamberStore('cart', { state: () => ({ n: 0 }), actions: { set: (_s: { n: number }, n: number) => ({ n }) }, undo: true });
    const cart = useCart(bus);
    bus.use(createBatchingHttpBridge({ endpoint: '/api/vc/batch', actions: ['cartSet'] }));
    bus.use(createHttpBridge({ endpoint: '/api/vc', actions: ['cart*'] }));
    bus.register('cartLocal', async () => 1, { undo: () => {} });
    await bus.dispatch('cartLocal', null); // recorded locally: the bridge sends it and the server fails it
    expect(posted).toEqual(['cartLocal']);
    await cart.$reset();
    expect(posted).toEqual(['cartLocal']);
    expect(cart.state.value).toEqual({ n: 0 });
    cart.$dispose();
  });

  it('a batching bridge scoped by prefix still keeps a $ command local', async () => {
    const posted = failingServer();
    const bus = createAsyncCommandBus({ retry: false });
    const cart = defineChamberStore('cart', { state: () => ({ n: 1 }), actions: { set: (_s: { n: number }, n: number) => ({ n }) } })(bus);
    bus.use(createBatchingHttpBridge({ endpoint: '/api/vc/batch', actions: ['cart*'] }));
    await cart.$reset();
    expect(posted).toEqual([]);
    expect(cart.state.value).toEqual({ n: 1 });
    cart.$dispose();
  });

  it('the WebSocket bridge', async () => {
    let socket!: MockWebSocket;
    vi.stubGlobal('WebSocket', class extends MockWebSocket { constructor(url: string) { super(url); socket = this; } });
    const bus = createAsyncCommandBus({ retry: false });
    let undone = 0;
    bus.register('cartAdd', async () => 1, { undo: () => { undone++; } });
    const ws = createWsBridge({ url: 'ws://test', actions: ['cart*'] });
    bus.use(ws);
    ws.connect();
    await settle();
    await bus.dispatch('cartAdd$undo', { action: 'cartAdd', target: {} });
    expect(socket.sent).toEqual([]);
    expect(undone).toBe(1);
  });
});

describe('the outbox', () => {
  it('never queues a $ command, even matching its actions', async () => {
    const records: unknown[] = [];
    const storage = { load: async () => [], save: async (r: unknown[]) => { records.splice(0, records.length, ...r); } };
    const outbox = createOutbox({ actions: ['cart*'], storage: storage as never, isOnline: () => false, autoFlush: false });
    const bus = createAsyncCommandBus({ retry: false });
    outbox.install(bus);
    let undone = 0;
    bus.register('cartAdd', async () => 1, { undo: () => { undone++; } });
    const result = await bus.dispatch('cartAdd$undo', { action: 'cartAdd', target: {} });
    expect(result.ok).toBe(true);
    expect(undone).toBe(1);
    expect(outbox.pending.value).toBe(0);
  });
});
