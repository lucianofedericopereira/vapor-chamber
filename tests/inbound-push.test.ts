/**
 * A server push over SSE, Echo or WebSocket: its `stores` member writes the declared store states and the event is then emitted on the bus.
 * Why: a push is a fact the server declared, not a command; dispatching it would run every plugin and send it back to the server when a transport covers the action, and a store that keeps steps would replay it as a reducer.
 * Shows: pushed state is written before the event is emitted and nothing is sent back, `stores` naming no store or a non-object value writes nothing, a late or nameless WebSocket frame reaches no bus, a rollback and persist keep the pushed state, and a receiver that throws is logged while the fact is still emitted.
 * See: log 36.F41, docs/contract.md, docs/store.md, tests/echo-bridge.test.ts.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { EventSource } from 'undici';
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAsyncCommandBus, createCommandBus, type Command, type Transport } from '../src/command-bus';
import { defineChamberStore } from '../src/store';
import { createTestBus } from '../src/testing';
import { createEchoBridge, createSseBridge, defineTransport, wsTransport } from '../src/transports';
import { saveTo } from '../src/store-persist';

type Cart = { rev: number; items: string[] };
const useCart = defineChamberStore('cart', {
  state: (): Cart => ({ rev: 0, items: [] }),
  reducers: { add: (s: Cart, item: string) => ({ ...s, items: [...s.items, item] }) },
});
// The same store on a bus whose transport sends its action: no local change.
const useSentCart = defineChamberStore('cart', { state: (): Cart => ({ rev: 0, items: [] }), reducers: { add: null } });

let server: Server | null = null;
let wss: WebSocketServer | null = null;
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  wss?.close();
  wss = null;
  // An event stream stays open: its connections go first, or close() waits for them.
  server?.closeAllConnections();
  if (server) await new Promise((done) => server!.close(done));
  server = null;
});

/** A real server writing `bytes` as an event stream, as Laravel 13's eventStream does, then holding it open. */
async function eventStream(bytes: string): Promise<string> {
  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.write(bytes);
  });
  await new Promise<void>((done) => server!.listen(0, '127.0.0.1', done));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/events`;
}

/** Laravel's bytes for one StreamedEvent. */
const sse = (event: string, data: string): string => `event: ${event}\ndata: ${data}\n\n`;

/** An Echo with laravel-echo's channel API, one channel; `fire` delivers a broadcast. */
function echoOf() {
  const listeners: Record<string, (payload: unknown) => void> = {};
  const ch = { listen: (event: string, cb: (payload: unknown) => void) => { listeners[event] = cb; return ch; } };
  return { echo: { channel: () => ch, private: () => ch, join: () => ch, leave: () => {} }, fire: (event: string, payload: unknown) => listeners[event](payload) };
}

/** A bus whose one transport sends every action, counting what it sends. */
function sentBus() {
  const sent: string[] = [];
  const bus = createAsyncCommandBus({ retry: false, transport: defineTransport(async (cmd) => { sent.push(cmd.action); return { ok: true, value: undefined, error: undefined }; }) });
  return { bus, sent };
}

describe('SSE: a push without onEvent', () => {
  it("writes a declared store state and emits the event by its name; Laravel's end marker is ignored", async () => {
    vi.stubGlobal('EventSource', EventSource);
    const error = vi.spyOn(console, 'error');
    const url = await eventStream(
      sse('update', JSON.stringify({ stores: { cart: { rev: 2, items: ['pushed'] } } })) +
      sse('priceChanged', JSON.stringify({ sku: 'A1' })) +
      sse('update', '</stream>'),
    );
    const { bus, sent } = sentBus();
    const cart = useSentCart(bus);
    const heard: Array<[string, unknown, Cart]> = [];
    bus.on('*', (cmd) => { heard.push([cmd.action, cmd.target, cart.state.value]); });
    const bridge = createSseBridge({ url, events: ['update', 'priceChanged'] });
    bridge.install(bus);
    await vi.waitFor(() => expect(heard.length).toBe(2));
    expect(cart.state.value).toEqual({ rev: 2, items: ['pushed'] });
    // The fact is emitted after the write, so its listener reads the new state.
    expect(heard).toEqual([
      ['update', { stores: { cart: { rev: 2, items: ['pushed'] } } }, { rev: 2, items: ['pushed'] }],
      ['priceChanged', { sku: 'A1' }, { rev: 2, items: ['pushed'] }],
    ]);
    // Never dispatched: the transport covering every action sent nothing back.
    expect(sent).toEqual([]);
    expect(error).not.toHaveBeenCalled();
    bridge.dispose();
    cart.$dispose();
  });

  it('a store on a sync bus takes a pushed state', async () => {
    vi.stubGlobal('EventSource', EventSource);
    const url = await eventStream(sse('update', JSON.stringify({ stores: { cart: { rev: 1, items: ['sync'] } } })));
    const bus = createCommandBus();
    const cart = useCart(bus);
    const bridge = createSseBridge({ url, events: ['update'] });
    bridge.install(bus);
    await vi.waitFor(() => expect(cart.state.value).toEqual({ rev: 1, items: ['sync'] }));
    bridge.dispose();
    cart.$dispose();
  });

  it('control: onEvent is called for each message as released, and may dispatch', async () => {
    vi.stubGlobal('EventSource', EventSource);
    const url = await eventStream(`data: ${JSON.stringify({ command: 'cartAdd', target: 'typed' })}\n\n`);
    const bus = createCommandBus();
    const cart = useCart(bus);
    const bridge = createSseBridge({ url, onEvent: (event, b) => { const d = JSON.parse(event.data); b.dispatch(d.command, d.target); } });
    bridge.install(bus);
    await vi.waitFor(() => expect(cart.state.value.items).toEqual(['typed']));
    bridge.dispose();
    cart.$dispose();
  });
});

describe('Echo: a broadcast without onBroadcast', () => {
  it('writes its declared store state, then emits the payload as released', () => {
    const { echo, fire } = echoOf();
    const bus = createCommandBus();
    const cart = useCart(bus);
    const heard: Array<[unknown, Cart]> = [];
    bus.on('CartUpdated', (cmd) => { heard.push([cmd.target, cart.state.value]); });
    createEchoBridge({ echo, channels: [{ name: 'user.1', events: ['CartUpdated'] }] }).install(bus);
    fire('CartUpdated', { stores: { cart: { rev: 4, items: ['echo'] } } });
    expect(cart.state.value).toEqual({ rev: 4, items: ['echo'] });
    expect(heard).toEqual([[{ stores: { cart: { rev: 4, items: ['echo'] } } }, { rev: 4, items: ['echo'] }]]);
    cart.$dispose();
  });

  it('on a bus that never had a store, its `stores` write nothing and it is still emitted', () => {
    const { echo, fire } = echoOf();
    const bus = createCommandBus();
    const heard: unknown[] = [];
    bus.on('CartUpdated', (cmd) => { heard.push(cmd.target); });
    createEchoBridge({ echo, channels: [{ name: 'user.1', events: ['CartUpdated'] }] }).install(bus);
    fire('CartUpdated', { stores: { cart: { rev: 4, items: ['echo'] } } });
    expect(heard).toEqual([{ stores: { cart: { rev: 4, items: ['echo'] } } }]);
  });

  it('a `stores` that names no store on the bus writes nothing, and it is still emitted', () => {
    const { echo, fire } = echoOf();
    const bus = createCommandBus();
    const cart = useCart(bus);
    cart.add('mine');
    const heard: unknown[] = [];
    bus.on('ShopsListed', (cmd) => { heard.push(cmd.target); });
    createEchoBridge({ echo, channels: [{ name: 'shops', events: ['ShopsListed'] }] }).install(bus);
    fire('ShopsListed', { stores: [{ city: 'Rome' }, { city: 'Oslo' }] });
    fire('ShopsListed', { stores: { rome: { city: 'Rome' } } });
    expect(cart.state.value).toEqual({ rev: 0, items: ['mine'] });
    expect(heard).toHaveLength(2);
    cart.$dispose();
  });

  it('a value under a store id that is no object writes nothing, and development warns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { echo, fire } = echoOf();
    const bus = createCommandBus();
    const cart = useCart(bus);
    cart.add('mine');
    createEchoBridge({ echo, channels: [{ name: 'shops', events: ['ShopsListed'] }] }).install(bus);
    fire('ShopsListed', { stores: { cart: 'Rome' } });
    expect(cart.state.value).toEqual({ rev: 0, items: ['mine'] });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('store:invalid:state'));
    cart.$dispose();
  });

  it('control: onBroadcast replaces it, and writes nothing itself', () => {
    const { echo, fire } = echoOf();
    const bus = createCommandBus();
    const cart = useCart(bus);
    const got: unknown[] = [];
    createEchoBridge({ echo, channels: [{ name: 'user.1', events: ['CartUpdated'] }], onBroadcast: (info) => { got.push(info.payload); } }).install(bus);
    fire('CartUpdated', { stores: { cart: { rev: 4, items: ['echo'] } } });
    expect(got).toHaveLength(1);
    expect(cart.state.value).toEqual({ rev: 0, items: [] });
    cart.$dispose();
  });
});

describe('WebSocket: a frame with no id', () => {
  /** A real WebSocket server; `onFrame` answers each command frame the client sends. */
  async function wsServer(onFrame: (socket: ServerSocket, frame: { id: string; command: string }) => void) {
    const received: string[] = [];
    let client: ServerSocket | null = null;
    wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise<void>((done) => wss!.on('listening', () => done()));
    wss.on('connection', (socket) => {
      client = socket;
      socket.on('message', (raw) => { const frame = JSON.parse(String(raw)); received.push(frame.command); onFrame(socket, frame); });
    });
    return { url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`, received, push: (frame: object) => client!.send(JSON.stringify(frame)) };
  }

  it('is a push: its store state written and its event emitted, nothing sent back; a reply still resolves', async () => {
    const srv = await wsServer((socket, f) => socket.send(JSON.stringify({ id: f.id, status: 200, state: 'saved' })));
    const ws = wsTransport({ url: srv.url, reconnect: false });
    const bus = createAsyncCommandBus({ retry: false, transport: ws });
    const cart = useSentCart(bus);
    const heard: Array<[string, unknown]> = [];
    bus.on('*', (cmd) => { heard.push([cmd.action, cmd.target]); });
    ws.connect();
    await vi.waitFor(() => expect(ws.isConnected()).toBe(true));
    // A late reply (no request waits for its id) is not a push.
    srv.push({ id: 'gone', status: 200, state: 'late', event: 'late' });
    srv.push({ event: 'cartChanged', data: { stores: { cart: { rev: 5, items: ['ws'] } } } });
    await vi.waitFor(() => expect(cart.state.value).toEqual({ rev: 5, items: ['ws'] }));
    expect(heard).toEqual([['cartChanged', { stores: { cart: { rev: 5, items: ['ws'] } } }]]);
    const r = await bus.dispatch('orderSave', { id: 1 });
    expect(r).toMatchObject({ ok: true, value: 'saved' });
    expect(srv.received).toEqual(['orderSave']);
    bus.dispose();
    cart.$dispose();
  });

  it('before a bus declares the transport, and without an event name, it reaches no bus', async () => {
    // Node's own WebSocket, counting the frames it delivers, so the case knows the early one landed.
    let frames = 0;
    vi.stubGlobal('WebSocket', class extends WebSocket {
      constructor(url: string) { super(url); this.addEventListener('message', () => { frames++; }); }
    });
    const srv = await wsServer(() => {});
    const ws = wsTransport({ url: srv.url, reconnect: false });
    ws.connect();
    await vi.waitFor(() => expect(ws.isConnected()).toBe(true));
    srv.push({ event: 'early', data: { stores: { cart: { rev: 9, items: ['early'] } } } });
    await vi.waitFor(() => expect(frames).toBe(1));
    const bus = createAsyncCommandBus({ retry: false, transport: ws });
    const cart = useSentCart(bus);
    const heard: string[] = [];
    bus.on('*', (cmd) => { heard.push(cmd.action); });
    srv.push({ data: { stores: { cart: { rev: 9, items: ['nameless'] } } } });
    srv.push({ event: 'after', data: null });
    await vi.waitFor(() => expect(heard).toEqual(['after']));
    expect(cart.state.value).toEqual({ rev: 0, items: [] });
    bus.dispose();
    cart.$dispose();
  });
});

describe('a transport given its bus', () => {
  for (const [name, make] of [
    ['the async bus', (t: Transport) => createAsyncCommandBus({ transport: { 'order*': t, 'stock*': t } })],
    ['the test bus', (t: Transport) => createTestBus({ transport: t })],
  ] as const) {
    it(`${name} attaches each transport once, with itself, however many patterns name it`, () => {
      const t: Transport = { send: async () => ({ ok: true, value: undefined, error: undefined }), attach: () => {} };
      const attach = vi.spyOn(t, 'attach');
      const bus = make(t);
      expect(attach.mock.calls).toEqual([[bus]]);
    });
  }
});

describe('a pushed state in a store that keeps steps', () => {
  it('a rollback keeps it, never replaying a reducer of the same name over it', async () => {
    const { echo, fire } = echoOf();
    const bus = createAsyncCommandBus({ retry: false });
    createEchoBridge({ echo, channels: [{ name: 'c', events: ['cartAdd'] }] }).install(bus);
    const push = fire;
    const cart = defineChamberStore('cart', { state: (): Cart => ({ rev: 0, items: [] }), reducers: { add: (s: Cart, item: string) => ({ ...s, items: [...s.items, item] }) }, undo: true })(bus);
    let first: Command | undefined;
    bus.onAfter((cmd) => { first ??= cmd; });
    await bus.dispatch('cartAdd', 'a');
    // Named as the store's own action: replayed, it would add its data as an item.
    push('cartAdd', { stores: { cart: { rev: 7, items: ['p'] } } });
    // A rollback, as an optimistic action's failure runs: it reverses the step and rebases the later ones.
    await bus.dispatch('cartAdd$undo', first);
    expect(cart.state.value).toEqual({ rev: 7, items: ['p'] });
    cart.$dispose();
  });

  it("the store's persist saves a pushed state at the push", async () => {
    const saved: string[] = [];
    const storage = { getItem: () => null, setItem: (_k: string, v: string) => { saved.push(v); } };
    const { echo, fire } = echoOf();
    const bus = createAsyncCommandBus({ retry: false });
    const cart = defineChamberStore('cart', {
      state: (): Cart => ({ rev: 0, items: [] }),
      reducers: { add: (s: Cart, item: string) => ({ ...s, items: [...s.items, item] }) },
      persist: saveTo({ key: 'vc:cart', storage }),
    })(bus);
    createEchoBridge({ echo, channels: [{ name: 'c', events: ['CartUpdated'] }] }).install(bus);
    fire('CartUpdated', { stores: { cart: { rev: 8, items: ['p'] } } });
    await Promise.resolve();
    expect(saved).toEqual(['{"rev":8,"items":["p"]}']);
    await bus.dispatch('cartAdd', 'b');
    await Promise.resolve();
    expect(saved).toEqual(['{"rev":8,"items":["p"]}', '{"rev":8,"items":["p","b"]}']);
    cart.$dispose();
  });

  it("a receiver's throw (an app's version) is logged, and the fact is still emitted", () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { echo, fire } = echoOf();
    const bus = createCommandBus();
    const cart = defineChamberStore('cart', { state: (): Cart => ({ rev: 0, items: [] }), reducers: {}, version: () => { throw new Error('bad version'); } })(bus);
    const heard: unknown[] = [];
    bus.on('CartUpdated', (cmd) => { heard.push(cmd.target); });
    createEchoBridge({ echo, channels: [{ name: 'c', events: ['CartUpdated'] }] }).install(bus);
    fire('CartUpdated', { stores: { cart: { rev: 1, items: [] } } });
    expect(heard).toHaveLength(1);
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/^\[vapor-chamber\] \[ FAIL \] store:failed:push: the push "CartUpdated" failed to write a store/), expect.any(Error));
    cart.$dispose();
  });
});
