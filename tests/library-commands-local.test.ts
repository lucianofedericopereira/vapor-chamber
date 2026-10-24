/** The library's `$` commands (`<action>$undo`, `<id>$reset`) stay local: no transport sends them, the outbox never queues them. Log s35.114. */
import { afterEach, describe, expect, vi } from 'vitest';
import { createAsyncCommandBus } from '../src/command-bus';
import { createOutbox } from '../src/outbox';
import { history } from '../src/plugins-core';
import { defineChamberStore } from '../src/store';
import { defineTransport, httpTransport, wsTransport } from '../src/transports';
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

describe("a transport for cart* does not send the library's $ commands", () => {
  it('optimistic: the rollback runs here, the server sees only the command', async () => {
    const posted = failingServer();
    const bus = createAsyncCommandBus({ retry: false, transport: { 'cart*': httpTransport({ endpoint: '/api/vc' }) } });
    let undone = 0;
    bus.register('cartAdd', async () => 1, { undo: () => { undone++; }, optimistic: true });
    const r = await bus.dispatch('cartAdd', { id: 1 });
    await (r.value as { done: Promise<unknown> }).done;
    expect(posted).toEqual(['cartAdd']);
    expect(undone).toBe(1);
  });

  it('history undo and a store $reset go to their local handlers, through the batching transport too', async () => {
    const posted = failingServer();
    const bus = createAsyncCommandBus({ retry: false, transport: {
      cartSet: httpTransport({ endpoint: '/api/vc/batch', batch: {} }),
      'cart*': httpTransport({ endpoint: '/api/vc' }),
    } });
    const h = history({ bus });
    const useCart = defineChamberStore('cart', { state: () => ({ n: 0 }), reducers: { set: null }, undo: true });
    const cart = useCart(bus);
    bus.register('cartLocal', null, { undo: () => {} });
    await bus.dispatch('cartLocal', null); // recorded locally: the transport sends it and the server fails it
    expect(posted).toEqual(['cartLocal']);
    await cart.$reset();
    expect(posted).toEqual(['cartLocal']);
    expect(cart.state.value).toEqual({ n: 0 });
    cart.$dispose();
  });

  it('a batching transport for a prefix still keeps a $ command local', async () => {
    const posted = failingServer();
    const bus = createAsyncCommandBus({ retry: false, transport: { 'cart*': httpTransport({ endpoint: '/api/vc/batch', batch: {} }) } });
    const cart = defineChamberStore('cart', { state: () => ({ n: 1 }), reducers: { set: null } })(bus);
    await cart.$reset();
    expect(posted).toEqual([]);
    expect(cart.state.value).toEqual({ n: 1 });
    cart.$dispose();
  });

  it('the WebSocket transport', async () => {
    let socket!: MockWebSocket;
    vi.stubGlobal('WebSocket', class extends MockWebSocket { constructor(url: string) { super(url); socket = this; } });
    const ws = wsTransport({ url: 'ws://test' });
    const bus = createAsyncCommandBus({ retry: false, transport: { 'cart*': ws } });
    let undone = 0;
    bus.register('cartAdd', null, { undo: () => { undone++; } });
    ws.connect();
    await settle();
    await bus.dispatch('cartAdd$undo', { action: 'cartAdd', target: {} });
    expect(socket.sent).toEqual([]);
    expect(undone).toBe(1);
  });
});

describe('the outbox', () => {
  it('never queues a $ command, even matching its actions', async () => {
    const outbox = createOutbox({ actions: ['cart*'], storage: null, isOnline: () => false, autoFlush: false });
    const bus = createAsyncCommandBus({ retry: false, transport: defineTransport(async () => ({ ok: true, value: 1, error: undefined })), outbox });
    let undone = 0;
    bus.register('cartAdd', null, { undo: () => { undone++; } });
    const result = await bus.dispatch('cartAdd$undo', { action: 'cartAdd', target: {} });
    expect(result.ok).toBe(true);
    expect(undone).toBe(1);
    expect(outbox.pending.value).toBe(0);
  });
});
