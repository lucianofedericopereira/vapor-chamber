/**
 * Tests for the transport layer: createHttpBridge, createWsBridge, createSseBridge
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { createAsyncCommandBus, createCommandBus, invalidateCsrfCache } from '../src/index';
import { createHttpBridge, createWsBridge, createSseBridge } from '../src/transports';

afterEach(() => vi.restoreAllMocks());

// ---------------------------------------------------------------------------
// createHttpBridge
// ---------------------------------------------------------------------------

describe('createHttpBridge', () => {
  it('sends command envelope to endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ state: { count: 3 } }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const bus = createAsyncCommandBus();
    bus.use(createHttpBridge({ endpoint: '/api/vc' }));

    const result = await bus.dispatch('cartAdd', { id: 1 }, { quantity: 2 });

    expect(result.ok).toBe(true);
    expect(result.value).toEqual({ count: 3 });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/vc');
    expect(init.method).toBe('POST');

    const body = JSON.parse(init.body);
    expect(body.command).toBe('cartAdd');
    expect(body.target).toEqual({ id: 1 });
    expect(body.payload).toEqual({ quantity: 2 });
  });

  it('returns error on HTTP failure status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 422,
      text: async () => 'Unprocessable',
    }));

    const bus = createAsyncCommandBus();
    bus.use(createHttpBridge({ endpoint: '/api/vc' }));

    const result = await bus.dispatch('fail', {});
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain('422');
  });

  it('reads XSRF-TOKEN cookie when csrf: true', async () => {
    invalidateCsrfCache();

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    }));
    vi.stubGlobal('document', {
      cookie: 'XSRF-TOKEN=abc123',
      querySelector: () => null,
    });

    const bus = createAsyncCommandBus();
    bus.use(createHttpBridge({ endpoint: '/api/vc', csrf: true }));
    await bus.dispatch('test', {});

    const init = (fetch as any).mock.calls[0][1];
    expect(init.headers['X-XSRF-TOKEN']).toBe('abc123');

    invalidateCsrfCache();
    vi.unstubAllGlobals();
  });

  it('actions filter skips non-matching commands', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });
    vi.stubGlobal('fetch', fetchMock);

    const bus = createAsyncCommandBus({ onMissing: 'ignore' });
    bus.use(createHttpBridge({ endpoint: '/api/vc', actions: ['cart*'] }));

    await bus.dispatch('userLogin', {});
    expect(fetchMock).not.toHaveBeenCalled();

    await bus.dispatch('cartAdd', {});
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('returns { ok: false } when backend returns ok: false in body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: false, error: 'validation failed' }),
    }));

    const bus = createAsyncCommandBus();
    bus.use(createHttpBridge({ endpoint: '/api/vc' }));

    const result = await bus.dispatch('cartAdd', {});
    expect(result.ok).toBe(false);
    expect(result.error?.message).toBe('validation failed');
  });

  it('catches fetch exceptions and returns { ok: false }', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

    const bus = createAsyncCommandBus();
    bus.use(createHttpBridge({ endpoint: '/api/vc' }));

    const result = await bus.dispatch('cartAdd', {});
    expect(result.ok).toBe(false);
    expect(result.error?.message).toBe('network down');
  });
});

// ---------------------------------------------------------------------------
// createWsBridge
// ---------------------------------------------------------------------------

// Minimal WebSocket mock
class MockWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  readyState = MockWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  sent: string[] = [];

  constructor(public url: string) {
    // Simulate open on next tick
    Promise.resolve().then(() => this.onopen?.());
  }

  send(data: string) { this.sent.push(data); }
  close() { this.readyState = MockWebSocket.CLOSED; }

  /** Helper: simulate a server response message */
  receive(data: object) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
}

describe('createWsBridge', () => {
  let MockWS: typeof MockWebSocket;
  let lastWs: MockWebSocket;

  beforeEach(() => {
    MockWS = class extends MockWebSocket {
      constructor(url: string) {
        super(url);
        lastWs = this;
      }
    } as any;
    vi.stubGlobal('WebSocket', MockWS);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('skips non-matching actions (actions filter)', async () => {
    const bus = createAsyncCommandBus({ onMissing: 'ignore' });
    const ws = createWsBridge({ url: 'ws://localhost', actions: ['cart*'] });
    bus.use(ws);
    ws.connect();

    // Wait for open
    await Promise.resolve();

    const result = await bus.dispatch('userLogin', {});
    expect(result.ok).toBe(true); // fell through to onMissing: ignore
    expect(lastWs.sent).toHaveLength(0);
  });

  it('sends command envelope and resolves on server response', async () => {
    vi.useFakeTimers();
    const bus = createAsyncCommandBus();
    const ws = createWsBridge({ url: 'ws://localhost' });
    bus.use(ws);
    bus.register('cartAdd', async () => null);
    ws.connect();

    await vi.runAllTimersAsync(); // let onopen fire

    const promise = bus.dispatch('cartAdd', { id: 1 }, { qty: 2 });

    // Get the id from the sent message and simulate server response
    const msg = JSON.parse(lastWs.sent[0]);
    expect(msg.command).toBe('cartAdd');
    expect(msg.target).toEqual({ id: 1 });

    lastWs.receive({ id: msg.id, ok: true, state: { added: true } });

    const result = await promise;
    expect(result.ok).toBe(true);
    expect(result.value).toEqual({ added: true });
  });

  it('resolves { ok: false } when server returns ok: false', async () => {
    vi.useFakeTimers();
    const bus = createAsyncCommandBus();
    const ws = createWsBridge({ url: 'ws://localhost' });
    bus.use(ws);
    bus.register('fail', async () => null);
    ws.connect();

    await vi.runAllTimersAsync();

    const promise = bus.dispatch('fail', {});
    const msg = JSON.parse(lastWs.sent[0]);
    lastWs.receive({ id: msg.id, ok: false, error: 'server-error' });

    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.error?.message).toBe('server-error');
  });

  it('times out if server never responds', async () => {
    vi.useFakeTimers();
    const bus = createAsyncCommandBus();
    const ws = createWsBridge({ url: 'ws://localhost' });
    bus.use(ws);
    bus.register('slow', async () => null);
    ws.connect();

    await vi.runAllTimersAsync();

    const promise = bus.dispatch('slow', {});
    await vi.advanceTimersByTimeAsync(11_000); // past the 10s WS timeout

    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain('timed out');
  });

  it('queues commands while disconnected and sends on reconnect', async () => {
    vi.useFakeTimers();
    const bus = createAsyncCommandBus({ onMissing: 'ignore' });
    const ws = createWsBridge({ url: 'ws://localhost' });
    bus.use(ws);
    ws.connect();

    // Don't await open — WS is not yet OPEN; stub readyState
    lastWs.readyState = 3; // CLOSED

    const promise = bus.dispatch('cartAdd', { id: 99 });

    // Simulate reconnect: mark open and trigger onopen
    lastWs.readyState = MockWebSocket.OPEN;
    lastWs.onopen?.();

    // Message should now be flushed from queue
    expect(lastWs.sent.length).toBeGreaterThan(0);

    // Respond so promise resolves
    const msg = JSON.parse(lastWs.sent[0]);
    lastWs.receive({ id: msg.id, ok: true });

    const result = await promise;
    expect(result.ok).toBe(true);
  });

  it('calls onConnect and onDisconnect callbacks', async () => {
    vi.useFakeTimers();
    const onConnect = vi.fn();
    const onDisconnect = vi.fn();
    const ws = createWsBridge({ url: 'ws://localhost', onConnect, onDisconnect });
    ws.connect();

    await vi.runAllTimersAsync();
    expect(onConnect).toHaveBeenCalledTimes(1);

    lastWs.onclose?.({ code: 1000, reason: '' });
    expect(onDisconnect).toHaveBeenCalledTimes(1);
  });

  it('isConnected() reflects WebSocket state', async () => {
    vi.useFakeTimers();
    const ws = createWsBridge({ url: 'ws://localhost' });
    ws.connect();

    await vi.runAllTimersAsync();
    expect(ws.isConnected()).toBe(true);

    ws.disconnect();
    expect(ws.isConnected()).toBe(false);
  });

  it('connected signal reflects WebSocket state reactively', async () => {
    vi.useFakeTimers();
    const ws = createWsBridge({ url: 'ws://localhost' });

    expect(ws.connected.value).toBe(false);

    ws.connect();
    await vi.runAllTimersAsync();
    expect(ws.connected.value).toBe(true);

    ws.disconnect();
    expect(ws.connected.value).toBe(false);
  });

  it('ignores malformed JSON frames without crashing', async () => {
    vi.useFakeTimers();
    const bus = createAsyncCommandBus();
    const ws = createWsBridge({ url: 'ws://localhost' });
    bus.use(ws);
    bus.register('ping', async () => null);
    ws.connect();

    await vi.runAllTimersAsync();

    const promise = bus.dispatch('ping', {});
    // Malformed frame — should be ignored silently
    lastWs.onmessage?.({ data: 'not-json{{' });

    // Respond with a valid frame so the promise resolves
    const msg = JSON.parse(lastWs.sent[0]);
    lastWs.receive({ id: msg.id, ok: true });

    const result = await promise;
    expect(result.ok).toBe(true);
  });

  it('does nothing when WebSocket is unavailable', () => {
    vi.unstubAllGlobals(); // remove WebSocket global
    const ws = createWsBridge({ url: 'ws://localhost' });
    expect(() => ws.connect()).not.toThrow();
    expect(ws.isConnected()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createSseBridge
// ---------------------------------------------------------------------------

class MockEventSource {
  static OPEN = 1;
  static CLOSED = 2;
  readyState = MockEventSource.OPEN;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(public url: string, public options?: { withCredentials?: boolean }) {}
  close() { this.closed = true; this.readyState = MockEventSource.CLOSED; }
}

describe('createSseBridge', () => {
  let lastEs: MockEventSource;

  beforeEach(() => {
    const MockES = class extends MockEventSource {
      constructor(url: string, opts?: { withCredentials?: boolean }) {
        super(url, opts);
        lastEs = this;
      }
    } as any;
    vi.stubGlobal('EventSource', MockES);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('install opens EventSource and calls onEvent for each message', () => {
    const received: string[] = [];
    const bus = createCommandBus();
    const sse = createSseBridge({
      url: '/api/stream',
      onEvent: (e) => received.push((e as any).data),
    });

    sse.install(bus);
    expect(sse.isConnected()).toBe(true);

    lastEs.onmessage?.({ data: 'hello' } as MessageEvent);
    lastEs.onmessage?.({ data: 'world' } as MessageEvent);

    expect(received).toEqual(['hello', 'world']);
  });

  it('teardown closes the EventSource', () => {
    const bus = createCommandBus();
    const sse = createSseBridge({ url: '/api/stream', onEvent: () => {} });

    sse.install(bus);
    expect(sse.isConnected()).toBe(true);

    sse.teardown();
    expect(sse.isConnected()).toBe(false);
    expect(lastEs.closed).toBe(true);
  });

  it('onEvent errors are caught and logged', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bus = createCommandBus();
    const sse = createSseBridge({
      url: '/api/stream',
      onEvent: () => { throw new Error('handler boom'); },
    });

    sse.install(bus);
    lastEs.onmessage?.({ data: '{}' } as MessageEvent);

    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('SSE'), expect.any(Error));
    consoleError.mockRestore();
  });

  it('does nothing when EventSource is unavailable', () => {
    vi.unstubAllGlobals();
    const bus = createCommandBus();
    const sse = createSseBridge({ url: '/api/stream', onEvent: () => {} });

    expect(() => sse.install(bus)).not.toThrow();
    expect(sse.isConnected()).toBe(false);
  });
});
