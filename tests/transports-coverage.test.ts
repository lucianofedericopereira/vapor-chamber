/**
 * Coverage-focused tests for src/transports.ts — drives the WebSocket bridge
 * reconnect / queue-expiry / maxQueueSize paths, the HTTP bridge redirect &
 * custom-httpClient error paths, the SSE bridge, and the Echo broadcast error
 * path. Reuses the same WS/SSE mock shapes as transports.test.ts.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { createAsyncCommandBus, createCommandBus } from '../src/index';
import { createHttpBridge, createBatchingHttpBridge, createWsBridge, createSseBridge, createEchoBridge } from '../src/transports';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// createHttpBridge — redirect handling (193-197) and custom httpClient !ok (201-202)
// ---------------------------------------------------------------------------

describe('createHttpBridge redirect & error-body paths', () => {
  it('calls onRedirect and resolves { ok:false } when body has a redirect (193-195)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ redirect: '/login' }),
    }));

    const onRedirect = vi.fn();
    const bus = createAsyncCommandBus();
    bus.use(createHttpBridge({ endpoint: '/api/vc', onRedirect }));

    const result = await bus.dispatch('go', {});
    expect(onRedirect).toHaveBeenCalledWith('/login');
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain('/login');
  });

  it('surfaces a redirect error when no onRedirect handler is configured (197)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ redirect: '/checkout' }),
    }));

    const bus = createAsyncCommandBus();
    bus.use(createHttpBridge({ endpoint: '/api/vc' }));

    const result = await bus.dispatch('go', {});
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain('/checkout');
    expect(result.error?.message).toContain('no onRedirect handler');
  });

  it('extracts message/error from body on a !ok response via custom httpClient (200-202)', async () => {
    // postCommand throws on !res.ok, so the bridge's own !res.ok branch is only
    // reachable through a custom httpClient that returns a non-ok response.
    const httpClient = {
      post: vi.fn().mockResolvedValue({
        ok: false,
        status: 422,
        headers: {},
        data: { message: 'validation exploded' },
      }),
    } as any;

    const bus = createAsyncCommandBus();
    bus.use(createHttpBridge({ endpoint: '/api/vc', httpClient }));

    const result = await bus.dispatch('save', {});
    expect(result.ok).toBe(false);
    expect(result.error?.message).toBe('validation exploded');
  });

  it('falls back to error field then HTTP status when no message present (201)', async () => {
    const httpClient = {
      post: vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        headers: {},
        data: { error: 'kaboom' },
      }),
    } as any;

    const bus = createAsyncCommandBus();
    bus.use(createHttpBridge({ endpoint: '/api/vc', httpClient }));

    const result = await bus.dispatch('save', {});
    expect(result.ok).toBe(false);
    expect(result.error?.message).toBe('kaboom');
  });
});

// ---------------------------------------------------------------------------
// createBatchingHttpBridge — same !ok-without-throwing gap as createHttpBridge
// above, but on the batching bridge's own flush(): postCommand() throws on a
// real HTTP failure, so this branch is likewise only reachable through a
// custom httpClient that resolves { ok: false, ... } instead.
// ---------------------------------------------------------------------------

describe('createBatchingHttpBridge — custom httpClient !ok path (329-333)', () => {
  it('fails every queued command with the extracted message when httpClient resolves !ok', async () => {
    const httpClient = {
      post: vi.fn().mockResolvedValue({
        ok: false,
        status: 422,
        headers: {},
        data: { message: 'batch validation exploded' },
      }),
    } as any;

    const bus = createAsyncCommandBus();
    bus.use(createBatchingHttpBridge({ endpoint: '/api/vc/batch', httpClient }));

    const [a, b] = await Promise.all([bus.dispatch('a', {}), bus.dispatch('b', {})]);
    expect(a.ok).toBe(false);
    expect(b.ok).toBe(false);
    expect(a.error?.message).toBe('batch validation exploded');
    expect(b.error?.message).toBe('batch validation exploded');
  });

  it('falls back to error field then HTTP status when no message present', async () => {
    const httpClient = {
      post: vi.fn().mockResolvedValue({ ok: false, status: 500, headers: {}, data: {} }),
    } as any;

    const bus = createAsyncCommandBus();
    bus.use(createBatchingHttpBridge({ endpoint: '/api/vc/batch', httpClient }));

    const result = await bus.dispatch('a', {});
    expect(result.ok).toBe(false);
    expect(result.error?.message).toBe('HTTP 500');
  });
});

// ---------------------------------------------------------------------------
// WebSocket mock (mirrors transports.test.ts) with a manual-open variant so we
// can hold the socket CLOSED to exercise queue paths deterministically.
// ---------------------------------------------------------------------------

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  /** When false, the constructor does NOT auto-open — tests open manually. */
  static autoOpen = true;
  readyState = MockWebSocket.autoOpen ? MockWebSocket.OPEN : MockWebSocket.CLOSED;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  sent: string[] = [];
  closed = false;

  constructor(public url: string) {
    if (MockWebSocket.autoOpen) {
      this.readyState = MockWebSocket.OPEN;
      Promise.resolve().then(() => this.onopen?.());
    } else {
      this.readyState = MockWebSocket.CLOSED;
    }
  }

  send(data: string) { this.sent.push(data); }
  close() { this.closed = true; this.readyState = MockWebSocket.CLOSED; }

  open() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  receive(data: object) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
}

describe('createWsBridge reconnect / queue / overflow paths', () => {
  let MockWS: typeof MockWebSocket;
  let sockets: MockWebSocket[];

  beforeEach(() => {
    sockets = [];
    MockWebSocket.autoOpen = true;
    MockWS = class extends MockWebSocket {
      constructor(url: string) {
        super(url);
        sockets.push(this);
      }
    } as any;
    vi.stubGlobal('WebSocket', MockWS);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    MockWebSocket.autoOpen = true;
  });

  it('drops the oldest queued message on maxQueueSize overflow (308-313)', async () => {
    vi.useFakeTimers();
    MockWebSocket.autoOpen = false; // hold socket CLOSED so sends queue

    const bus = createAsyncCommandBus({ onMissing: 'ignore' });
    const ws = createWsBridge({ url: 'ws://localhost', maxQueueSize: 1, reconnect: false });
    bus.use(ws);
    ws.connect(); // socket exists but stays CLOSED

    // First dispatch queues (queue length now 1 == maxQueueSize).
    const first = bus.dispatch('cartAdd', { id: 1 });
    // Second dispatch overflows → oldest is shifted out and resolved as overflow error.
    const second = bus.dispatch('cartUpdate', { id: 2 });

    const firstResult = await first;
    expect(firstResult.ok).toBe(false);
    expect(firstResult.error?.message).toContain('queue overflow');
    expect(firstResult.error?.message).toContain('cartAdd');

    // The second (newer) message is still queued — flush it via reconnect.
    sockets[0].open();
    expect(sockets[0].sent.length).toBe(1);
    const flushed = JSON.parse(sockets[0].sent[0]);
    expect(flushed.command).toBe('cartUpdate');
    sockets[0].receive({ id: flushed.id, ok: true });
    expect((await second).ok).toBe(true);
  });

  it('rejects queued messages that expired while disconnected, on reconnect (327-333)', async () => {
    vi.useFakeTimers();
    MockWebSocket.autoOpen = false; // hold CLOSED so the message queues

    const bus = createAsyncCommandBus({ onMissing: 'ignore' });
    const ws = createWsBridge({ url: 'ws://localhost', timeout: 5_000, reconnect: false });
    bus.use(ws);
    ws.connect();

    const promise = bus.dispatch('staleCmd', { id: 1 });

    // Advance past the per-message timeout while still disconnected. The
    // dispatch-level timeout fires first (also 5s) and settles the promise, so
    // assert the timeout error, then prove flushQueue's expiry branch runs.
    await vi.advanceTimersByTimeAsync(6_000);

    // Now reconnect → flushQueue sees elapsed >= timeout and rejects (no send).
    sockets[0].open();
    expect(sockets[0].sent.length).toBe(0); // expired message was NOT sent

    const result = await promise;
    expect(result.ok).toBe(false);
  });

  it('flushQueue resolves a still-pending expired queued message on reconnect (327-333)', async () => {
    // The queued item's timeout equals the dispatch-level wsTimeout, so to hit
    // the inner expiry branch (329-331) the pending entry must still be alive
    // when flushQueue runs. We advance the *wall clock* past expiry (so
    // elapsed >= timeout) WITHOUT firing the pending dispatch setTimeout, then
    // open the socket synchronously so flushQueue sees a live pending request.
    vi.useFakeTimers();
    const t0 = Date.now();
    vi.setSystemTime(t0);
    MockWebSocket.autoOpen = false;

    const bus = createAsyncCommandBus({ onMissing: 'ignore' });
    const ws = createWsBridge({ url: 'ws://localhost', timeout: 5_000, reconnect: false });
    bus.use(ws);
    ws.connect();

    const promise = bus.dispatch('expireMe', { id: 7 });

    // Move the clock past the 5s queued-message timeout without advancing the
    // timer queue — the dispatch timeout callback has NOT run, so pending still
    // holds this id.
    vi.setSystemTime(t0 + 6_000);

    sockets[0].open(); // flushQueue: elapsed (6000) >= timeout (5000) → 329-331 fire
    expect(sockets[0].sent.length).toBe(0); // expired → NOT sent

    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain('expired');
    expect(result.error?.message).toContain('expireMe');
  });

  it('schedules a reconnect and calls connect() again after backoff delay (346)', async () => {
    vi.useFakeTimers();

    const onConnect = vi.fn();
    const ws = createWsBridge({
      url: 'ws://localhost',
      reconnect: true,
      reconnectDelay: 1000,
      maxReconnects: 5,
      onConnect,
    });
    ws.connect();
    await vi.runAllTimersAsync(); // first socket opens
    expect(onConnect).toHaveBeenCalledTimes(1);
    expect(sockets.length).toBe(1);

    // Unintentional close → scheduleReconnect arms a timer.
    sockets[0].onclose?.({ code: 1006, reason: 'dropped' });

    // Backoff is reconnectDelay * reconnectCount (1000ms for the first attempt).
    await vi.advanceTimersByTimeAsync(1000); // fires the reconnect timer → connect()
    await vi.runAllTimersAsync(); // new socket opens

    expect(sockets.length).toBe(2); // connect() ran inside the reconnect timer (346)
    expect(onConnect).toHaveBeenCalledTimes(2);

    ws.disconnect();
  });

  it('disconnect() clears a pending reconnect timer (396-397)', async () => {
    vi.useFakeTimers();

    const ws = createWsBridge({
      url: 'ws://localhost',
      reconnect: true,
      reconnectDelay: 1000,
      maxReconnects: 5,
    });
    ws.connect();
    await vi.runAllTimersAsync();
    expect(sockets.length).toBe(1);

    // Unintentional close arms the reconnect timer.
    sockets[0].onclose?.({ code: 1006, reason: 'dropped' });

    // disconnect() must clear that armed timer so no reconnect socket is created.
    ws.disconnect();

    await vi.advanceTimersByTimeAsync(5000);
    await vi.runAllTimersAsync();

    expect(sockets.length).toBe(1); // reconnect timer was cleared → no second socket
    expect(ws.isConnected()).toBe(false);
  });

  it('invokes onError when the socket errors (388)', async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const ws = createWsBridge({ url: 'ws://localhost', onError });
    ws.connect();
    await vi.runAllTimersAsync();

    const evt = new Event('error');
    sockets[0].onerror?.(evt);
    expect(onError).toHaveBeenCalledWith(evt);

    ws.disconnect();
  });

  it('reconnect: false — an unintentional close never schedules a reconnect (520)', async () => {
    vi.useFakeTimers();
    const ws = createWsBridge({ url: 'ws://localhost', reconnect: false });
    ws.connect();
    await vi.runAllTimersAsync();
    expect(sockets.length).toBe(1);

    sockets[0].onclose?.({ code: 1006, reason: 'dropped' });
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.runAllTimersAsync();

    expect(sockets.length).toBe(1); // no reconnect socket ever created
    ws.disconnect();
  });

  it('stops reconnecting once maxReconnects is reached (520)', async () => {
    vi.useFakeTimers();
    // Sockets never auto-open here: onopen resets reconnectCount to 0 on any
    // successful connection, so testing the cap needs CONSECUTIVE failures
    // with no open in between.
    MockWebSocket.autoOpen = false;
    const ws = createWsBridge({
      url: 'ws://localhost',
      reconnect: true,
      reconnectDelay: 10,
      maxReconnects: 2,
    });
    ws.connect();
    expect(sockets.length).toBe(1);

    // Two consecutive unintentional closes → two reconnects (hits the cap
    // exactly). Delay is reconnectDelay * reconnectCount, so it grows each
    // attempt (10ms, then 20ms) — advance generously rather than exactly.
    sockets[0].onclose?.({ code: 1006, reason: 'dropped' });
    await vi.advanceTimersByTimeAsync(100);
    expect(sockets.length).toBe(2);

    sockets[1].onclose?.({ code: 1006, reason: 'dropped' });
    await vi.advanceTimersByTimeAsync(100);
    expect(sockets.length).toBe(3);

    // A third close must NOT schedule another reconnect — cap already reached.
    sockets[2].onclose?.({ code: 1006, reason: 'dropped' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets.length).toBe(3);

    ws.disconnect();
  });

  it('connect() is a no-op while a socket is already CONNECTING/OPEN (533)', async () => {
    vi.useFakeTimers();
    const ws = createWsBridge({ url: 'ws://localhost' });
    ws.connect();
    expect(sockets.length).toBe(1);

    // Real WebSockets start CONNECTING synchronously (the mock defaults
    // straight to OPEN) — force it to test the guard specifically.
    sockets[0].readyState = MockWebSocket.CONNECTING;
    ws.connect(); // must not create a second socket while CONNECTING
    expect(sockets.length).toBe(1);

    sockets[0].readyState = MockWebSocket.OPEN;
    ws.connect(); // still a no-op while OPEN
    expect(sockets.length).toBe(1);

    await vi.runAllTimersAsync();
    ws.disconnect();
  });

  it('re-queues the remainder of a flush if the socket closes mid-loop (495-496)', async () => {
    vi.useFakeTimers();
    MockWebSocket.autoOpen = false; // hold socket CLOSED so both dispatches queue

    const bus = createAsyncCommandBus({ onMissing: 'ignore' });
    const ws = createWsBridge({ url: 'ws://localhost', reconnect: false });
    bus.use(ws);
    ws.connect();

    const first = bus.dispatch('cartAdd', { id: 1 });
    const second = bus.dispatch('cartUpdate', { id: 2 });

    // Simulate the socket dying mid-flush: the first send "succeeds" but flips
    // the socket CLOSED as a side effect, so flushQueue's loop must re-queue
    // the second item rather than send it into a dead socket or drop it.
    const realSend = sockets[0].send.bind(sockets[0]);
    let sendCount = 0;
    sockets[0].send = (data: string) => {
      sendCount++;
      realSend(data);
      if (sendCount === 1) sockets[0].readyState = MockWebSocket.CLOSED;
    };

    sockets[0].open(); // readyState -> OPEN, fires onopen -> flushQueue()
    expect(sockets[0].sent.length).toBe(1); // only the first item got out
    const sentFirst = JSON.parse(sockets[0].sent[0]);
    expect(sentFirst.command).toBe('cartAdd');
    sockets[0].receive({ id: sentFirst.id, ok: true });
    expect((await first).ok).toBe(true);

    // The second item was re-queued, not lost — a later open flushes it.
    sockets[0].open();
    expect(sockets[0].sent.length).toBe(2);
    const sentSecond = JSON.parse(sockets[0].sent[1]);
    expect(sentSecond.command).toBe('cartUpdate');
    sockets[0].receive({ id: sentSecond.id, ok: true });
    expect((await second).ok).toBe(true);

    ws.disconnect();
  });

  it('defaults to a generic message when an error response omits data.error (560)', async () => {
    vi.useFakeTimers();
    const bus = createAsyncCommandBus({ onMissing: 'ignore' });
    const ws = createWsBridge({ url: 'ws://localhost', reconnect: false });
    bus.use(ws);
    ws.connect();
    await vi.runAllTimersAsync();

    const result = bus.dispatch('cartAdd', { id: 1 });
    const sent = JSON.parse(sockets[0].sent[0]);
    sockets[0].receive({ id: sent.id, ok: false }); // no `error` field at all

    expect((await result).error?.message).toBe('WebSocket error');
    ws.disconnect();
  });

  it('a stale close from a superseded socket does not null out the current one (574)', async () => {
    vi.useFakeTimers();
    const ws = createWsBridge({ url: 'ws://localhost', reconnect: true, reconnectDelay: 10, maxReconnects: 5 });
    ws.connect();
    await vi.runAllTimersAsync();
    expect(sockets.length).toBe(1);

    // socket[0] closes unintentionally → reconnect fires → socket[1] takes over.
    sockets[0].onclose?.({ code: 1006, reason: 'dropped' });
    await vi.advanceTimersByTimeAsync(100);
    await vi.runAllTimersAsync();
    expect(sockets.length).toBe(2);
    expect(ws.isConnected()).toBe(true);

    // A delayed/duplicate close event from the now-defunct socket[0] must not
    // clear the reference to the current, live socket[1].
    sockets[0].onclose?.({ code: 1006, reason: 'stale duplicate event' });

    // If it had wrongly nulled the reference, connect() would think nothing is
    // live and create a spurious third socket.
    ws.connect();
    expect(sockets.length).toBe(2);
    expect(ws.isConnected()).toBe(true);

    ws.disconnect();
  });

  it('pre-flight abort resolves immediately without ever sending (612)', async () => {
    vi.useFakeTimers();
    const bus = createAsyncCommandBus({ onMissing: 'ignore' });
    const ws = createWsBridge({ url: 'ws://localhost', reconnect: false });
    bus.use(ws);
    ws.connect();
    await vi.runAllTimersAsync();

    const controller = new AbortController();
    controller.abort();
    const result = await bus.dispatch('cartAdd', { id: 1 }, undefined, { signal: controller.signal });

    expect(result.ok).toBe(false);
    expect(sockets[0].sent.length).toBe(0); // never sent — aborted before dispatch
    ws.disconnect();
  });

  it('a late timeout after the response already settled is a no-op', async () => {
    vi.useFakeTimers();
    const bus = createAsyncCommandBus({ onMissing: 'ignore' });
    const ws = createWsBridge({ url: 'ws://localhost', reconnect: false, timeout: 50 });
    bus.use(ws);
    ws.connect();
    await vi.runAllTimersAsync();

    const result = bus.dispatch('cartAdd', { id: 1 });
    const sent = JSON.parse(sockets[0].sent[0]);
    // Response arrives well before the timeout — settles as a success.
    sockets[0].receive({ id: sent.id, ok: true, state: 42 });
    expect((await result).ok).toBe(true);

    // The timeout firing afterwards must not overwrite the already-settled
    // result — settle() cleared the timer, and resolve() is a no-op repeated.
    await vi.advanceTimersByTimeAsync(100);
    expect((await result).value).toBe(42);

    ws.disconnect();
  });
});

// ---------------------------------------------------------------------------
// createSseBridge — extra coverage alongside transports.test.ts
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

describe('createSseBridge routing & reconnect noop', () => {
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

  it('routes server-sent events into bus.dispatch via onEvent and tolerates onerror', () => {
    const dispatched: Array<[string, any]> = [];
    const bus = createCommandBus({ onMissing: 'ignore' });
    bus.on('*', (cmd) => dispatched.push([cmd.action, cmd.target]));

    const sse = createSseBridge({
      url: '/api/vc/events',
      withCredentials: true,
      onEvent: (event, b) => {
        const data = JSON.parse((event as any).data);
        b.dispatch(data.command, data.target);
      },
    });

    sse.install(bus);
    expect(sse.isConnected()).toBe(true);
    expect(lastEs.options?.withCredentials).toBe(true);

    lastEs.onmessage?.({ data: JSON.stringify({ command: 'priceChanged', target: { sku: 'A1' } }) } as MessageEvent);
    expect(dispatched).toEqual([['priceChanged', { sku: 'A1' }]]);

    // EventSource native reconnect handler is a no-op — just must not throw.
    expect(() => lastEs.onerror?.()).not.toThrow();

    sse.teardown();
    expect(sse.isConnected()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createEchoBridge — broadcast handler error path (623)
// ---------------------------------------------------------------------------

describe('createEchoBridge broadcast error logging', () => {
  function makeMockEcho() {
    const channels: Record<string, any> = {};
    function chan(name: string, kind: string) {
      const listeners: Record<string, (p: any) => void> = {};
      const ch = {
        kind,
        listen(event: string, cb: (p: any) => void) { listeners[event] = cb; return ch; },
        _fire(event: string, payload: any) { listeners[event]?.(payload); },
      };
      channels[name] = ch;
      return ch;
    }
    return {
      channel: (n: string) => chan(n, 'public'),
      private: (n: string) => chan(n, 'private'),
      join: (n: string) => chan(n, 'presence'),
      leave: () => {},
      _channels: channels,
    };
  }

  it('logs and swallows errors thrown inside onBroadcast (623)', () => {
    const echo = makeMockEcho();
    const bus = createCommandBus();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    createEchoBridge({
      echo,
      channels: [{ name: 'orders', events: ['OrderShipped'] }],
      onBroadcast: () => { throw new Error('broadcast boom'); },
    }).install(bus);

    expect(() => echo._channels.orders._fire('OrderShipped', { id: 1 })).not.toThrow();
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('Echo broadcast error'),
      expect.any(Error),
    );
  });
});
