/**
 * Coverage-focused tests for src/transports.ts - drives the WebSocket bridge
 * reconnect paths and its own outbox (bound, expiry, a close mid-flush), the HTTP bridge redirect &
 * custom-httpClient error paths, the SSE bridge, and the Echo broadcast error
 * path. Reuses the same WS/SSE mock shapes as transports.test.ts.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import type { Accepted } from '../src/accepted';
import { createAsyncCommandBus, createCommandBus } from '../src/index';
import { httpTransport, wsTransport, createSseBridge, createEchoBridge } from '../src/transports';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// httpTransport - redirect handling and custom httpClient !ok
// ---------------------------------------------------------------------------

describe('httpTransport redirect & error-body paths', () => {
  it('calls onRedirect and resolves { ok:false } when body has a redirect', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ redirect: '/login' }), text: async () => JSON.stringify(({ redirect: '/login' })),
    }));

    const onRedirect = vi.fn();
    const bus = createAsyncCommandBus({ retry: false, transport: httpTransport({ endpoint: '/api/vc', onRedirect }) });

    const result = await bus.dispatch('go', {});
    expect(onRedirect).toHaveBeenCalledWith('/login');
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain('/login');
  });

  it('surfaces a redirect error when no onRedirect handler is configured', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ redirect: '/checkout' }), text: async () => JSON.stringify(({ redirect: '/checkout' })),
    }));

    const bus = createAsyncCommandBus({ retry: false, transport: httpTransport({ endpoint: '/api/vc' }) });

    const result = await bus.dispatch('go', {});
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain('/checkout');
    expect(result.error?.message).toContain('No onRedirect handler is configured');
  });

  // The boundary of the redirect contract, pinned because three docs described
  // a wider one: the JSDoc and whitepaper both promised `onRedirect` would fire
  // for "a 3xx response with a Location header" as well as a body field. It
  // never did, and structurally cannot - `fetch` defaults to
  // `redirect: 'follow'`, so a 3xx is resolved by the platform and the bridge
  // is handed the FINAL response. A status the bridge does see (one a server
  // returns without following, or a custom httpClient's) is an ordinary
  // failure, not a redirect.
  it('does not call onRedirect for a redirect STATUS without a body field', async () => {
    const httpClient = {
      post: vi.fn().mockResolvedValue({
        ok: false,
        status: 302,
        headers: { location: '/login' },
        data: {},
      }),
    } as any;

    const onRedirect = vi.fn();
    const bus = createAsyncCommandBus({ retry: false, transport: httpTransport({ endpoint: '/api/vc', httpClient, onRedirect }) });

    const result = await bus.dispatch('go', {});
    expect(onRedirect).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
  });

  it('reads the problem of a !ok response a custom httpClient resolves with', async () => {
    // postCommand throws on !res.ok, so the bridge's own !res.ok branch is only
    // reachable through a custom httpClient that returns a non-ok response.
    const httpClient = {
      post: vi.fn().mockResolvedValue({
        ok: false,
        status: 422,
        headers: {},
        data: { status: 422, code: 'validation_failed', detail: 'validation exploded' },
      }),
    } as any;

    const bus = createAsyncCommandBus({ retry: false, transport: httpTransport({ endpoint: '/api/vc', httpClient }) });

    const result = await bus.dispatch('save', {});
    expect(result).toFailWith('remote:invalid:validation_failed');
    expect(result.error?.message).toBe('validation exploded');
  });

  it('a body that is not a problem reads by its status alone', async () => {
    const httpClient = {
      post: vi.fn().mockResolvedValue({ ok: false, status: 500, headers: {}, data: '<html>oops</html>' }),
    } as any;

    const bus = createAsyncCommandBus({ retry: false, transport: httpTransport({ endpoint: '/api/vc', httpClient }) });

    const result = await bus.dispatch('save', {});
    expect(result).toFailWith('remote:failed:http');
    expect(result.error?.message).toBe('HTTP 500');
  });
});

// ---------------------------------------------------------------------------
// httpTransport with batch - same !ok-without-throwing gap as httpTransport
// above, but on the batching bridge's own flush(): postCommand() throws on a
// real HTTP failure, so this branch is likewise only reachable through a
// custom httpClient that resolves { ok: false, ... } instead.
// ---------------------------------------------------------------------------

describe('httpTransport with batch - custom httpClient !ok path', () => {
  it('fails every queued command with the extracted message when httpClient resolves !ok', async () => {
    const httpClient = {
      post: vi.fn().mockResolvedValue({
        ok: false,
        status: 422,
        headers: {},
        data: { status: 422, code: 'validation_failed', detail: 'batch validation exploded' },
      }),
    } as any;

    const bus = createAsyncCommandBus({ retry: false, transport: httpTransport({ endpoint: '/api/vc/batch', httpClient, batch: {} }) });

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

    const bus = createAsyncCommandBus({ retry: false, transport: httpTransport({ endpoint: '/api/vc/batch', httpClient, batch: {} }) });

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
  /** When false, the constructor does NOT auto-open - tests open manually. */
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

describe('wsTransport reconnect / queue / overflow paths', () => {
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

  it("the transport's own outbox holds 100: the oldest past that settles coded, the rest go out in order", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    MockWebSocket.autoOpen = false; // hold the socket CLOSED so sends are held

    const ws = wsTransport({ url: 'ws://localhost', reconnect: false });
    const bus = createAsyncCommandBus({ onMissing: 'ignore', retry: false, transport: ws });
    ws.connect();

    const first = await bus.dispatch('cartAdd', { id: 0 });
    for (let i = 1; i <= 100; i++) await bus.dispatch('cartUpdate', { id: i });
    expect(await (first.value as Accepted).done).toFailWith('outbox:exceeded:queue');

    sockets[0].open();
    for (let i = 1; i <= 100; i++) {
      await vi.advanceTimersByTimeAsync(0);
      const frame = JSON.parse(sockets[0].sent[i - 1]);
      expect([frame.command, frame.target.id]).toEqual(['cartUpdate', i]);
      sockets[0].receive({ id: frame.id, state: null });
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(ws.outbox.pending.value).toBe(0);
  });

  it('a command held past the reply timeout settles once, coded, and is never sent', async () => {
    vi.useFakeTimers();
    MockWebSocket.autoOpen = false;

    const ws = wsTransport({ url: 'ws://localhost', timeout: 50, reconnect: false });
    const bus = createAsyncCommandBus({ onMissing: 'ignore', retry: false, transport: ws });
    ws.connect();

    const held = await bus.dispatch('cartAdd', { id: 1 });
    let settledCount = 0;
    const done = (held.value as Accepted).done.then((r) => { settledCount++; return r; });
    await vi.advanceTimersByTimeAsync(60);
    expect(await done).toFailWith('outbox:timeout:queue');
    expect(ws.outbox.pending.value).toBe(0); // its slot is free

    // A live command held after it is the one sent when the socket opens.
    const live = await bus.dispatch('cartUpdate', { id: 2 });
    sockets[0].open();
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets[0].sent.map((raw: string) => JSON.parse(raw).command)).toEqual(['cartUpdate']);
    sockets[0].receive({ id: JSON.parse(sockets[0].sent[0]).id, state: null });
    expect((await (live.value as Accepted).done).ok).toBe(true);
    expect(settledCount).toBe(1);
  });

  it('schedules a reconnect and calls connect() again after backoff delay', async () => {
    vi.useFakeTimers();

    const onConnect = vi.fn();
    const ws = wsTransport({
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

    // Unintentional close -> scheduleReconnect arms a timer.
    sockets[0].onclose?.({ code: 1006, reason: 'dropped' });

    // Backoff is reconnectDelay * reconnectCount (1000ms for the first attempt).
    await vi.advanceTimersByTimeAsync(1000); // fires the reconnect timer -> connect()
    await vi.runAllTimersAsync(); // new socket opens

    expect(sockets.length).toBe(2); // connect() ran inside the reconnect timer (346)
    expect(onConnect).toHaveBeenCalledTimes(2);

    ws.disconnect();
  });

  it('disconnect() clears a pending reconnect timer', async () => {
    vi.useFakeTimers();

    const ws = wsTransport({
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

    expect(sockets.length).toBe(1); // reconnect timer was cleared -> no second socket
    expect(ws.isConnected()).toBe(false);
  });

  it('invokes onError when the socket errors', async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const ws = wsTransport({ url: 'ws://localhost', onError });
    ws.connect();
    await vi.runAllTimersAsync();

    const evt = new Event('error');
    sockets[0].onerror?.(evt);
    expect(onError).toHaveBeenCalledWith(evt);

    ws.disconnect();
  });

  it('reconnect: false - an unintentional close never schedules a reconnect', async () => {
    vi.useFakeTimers();
    const ws = wsTransport({ url: 'ws://localhost', reconnect: false });
    ws.connect();
    await vi.runAllTimersAsync();
    expect(sockets.length).toBe(1);

    sockets[0].onclose?.({ code: 1006, reason: 'dropped' });
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.runAllTimersAsync();

    expect(sockets.length).toBe(1); // no reconnect socket ever created
    ws.disconnect();
  });

  it('stops reconnecting once maxReconnects is reached', async () => {
    vi.useFakeTimers();
    // Sockets never auto-open here: onopen resets reconnectCount to 0 on any
    // successful connection, so testing the cap needs CONSECUTIVE failures
    // with no open in between.
    MockWebSocket.autoOpen = false;
    const ws = wsTransport({
      url: 'ws://localhost',
      reconnect: true,
      reconnectDelay: 10,
      maxReconnects: 2,
    });
    ws.connect();
    expect(sockets.length).toBe(1);

    // Two consecutive unintentional closes -> two reconnects (hits the cap
    // exactly). Delay is reconnectDelay * reconnectCount, so it grows each
    // attempt (10ms, then 20ms) - advance generously rather than exactly.
    sockets[0].onclose?.({ code: 1006, reason: 'dropped' });
    await vi.advanceTimersByTimeAsync(100);
    expect(sockets.length).toBe(2);

    sockets[1].onclose?.({ code: 1006, reason: 'dropped' });
    await vi.advanceTimersByTimeAsync(100);
    expect(sockets.length).toBe(3);

    // A third close must NOT schedule another reconnect - cap already reached.
    sockets[2].onclose?.({ code: 1006, reason: 'dropped' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets.length).toBe(3);

    ws.disconnect();
  });

  it('connect() is a no-op while a socket is already CONNECTING/OPEN', async () => {
    vi.useFakeTimers();
    const ws = wsTransport({ url: 'ws://localhost' });
    ws.connect();
    expect(sockets.length).toBe(1);

    // Real WebSockets start CONNECTING synchronously (the mock defaults
    // straight to OPEN) - force it to test the guard specifically.
    sockets[0].readyState = MockWebSocket.CONNECTING;
    ws.connect(); // must not create a second socket while CONNECTING
    expect(sockets.length).toBe(1);

    sockets[0].readyState = MockWebSocket.OPEN;
    ws.connect(); // still a no-op while OPEN
    expect(sockets.length).toBe(1);

    await vi.runAllTimersAsync();
    ws.disconnect();
  });

  it('a socket closing mid-flush keeps the rest held, sent on the next open', async () => {
    vi.useFakeTimers();
    MockWebSocket.autoOpen = false; // hold the socket CLOSED so both are held

    const ws = wsTransport({ url: 'ws://localhost', reconnect: false });
    const bus = createAsyncCommandBus({ onMissing: 'ignore', retry: false, transport: ws });
    ws.connect();

    const first = await bus.dispatch('cartAdd', { id: 1 });
    const second = await bus.dispatch('cartUpdate', { id: 2 });

    // The first send "succeeds" but flips the socket CLOSED as a side effect:
    // the second is refused unsent (`transport:limited:socket`), and the
    // outbox keeps it rather than send it into a dead socket or drop it.
    const realSend = sockets[0].send.bind(sockets[0]);
    let sendCount = 0;
    sockets[0].send = (data: string) => {
      sendCount++;
      realSend(data);
      if (sendCount === 1) sockets[0].readyState = MockWebSocket.CLOSED;
    };

    sockets[0].open();
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets[0].sent.length).toBe(1);
    const sentFirst = JSON.parse(sockets[0].sent[0]);
    expect(sentFirst.command).toBe('cartAdd');
    sockets[0].receive({ id: sentFirst.id, state: null });
    expect((await (first.value as Accepted).done).ok).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(ws.outbox.pending.value).toBe(1);

    sockets[0].open();
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets[0].sent.length).toBe(2);
    const sentSecond = JSON.parse(sockets[0].sent[1]);
    expect(sentSecond.command).toBe('cartUpdate');
    sockets[0].receive({ id: sentSecond.id, state: null });
    expect((await (second.value as Accepted).done).ok).toBe(true);

    ws.disconnect();
  });

  it('a problem with no detail says its status', async () => {
    vi.useFakeTimers();
    const ws = wsTransport({ url: 'ws://localhost', reconnect: false });
    const bus = createAsyncCommandBus({ onMissing: 'ignore', retry: false, transport: ws });
    ws.connect();
    await vi.runAllTimersAsync();

    const result = bus.dispatch('cartAdd', { id: 1 });
    const sent = JSON.parse(sockets[0].sent[0]);
    sockets[0].receive({ id: sent.id, problem: { status: 503, code: 'unavailable' } }); // no `detail`

    const r = await result;
    expect(r).toFailWith('remote:limited:unavailable');
    expect(r.error?.message).toBe('HTTP 503');
    ws.disconnect();
  });

  it('a stale close from a superseded socket does not null out the current one', async () => {
    vi.useFakeTimers();
    const ws = wsTransport({ url: 'ws://localhost', reconnect: true, reconnectDelay: 10, maxReconnects: 5 });
    ws.connect();
    await vi.runAllTimersAsync();
    expect(sockets.length).toBe(1);

    // socket[0] closes unintentionally -> reconnect fires -> socket[1] takes over.
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

  it('pre-flight abort resolves immediately without ever sending', async () => {
    vi.useFakeTimers();
    const ws = wsTransport({ url: 'ws://localhost', reconnect: false });
    const bus = createAsyncCommandBus({ onMissing: 'ignore', retry: false, transport: ws });
    ws.connect();
    await vi.runAllTimersAsync();

    const controller = new AbortController();
    controller.abort();
    const result = await bus.dispatch('cartAdd', { id: 1 }, undefined, { signal: controller.signal });

    expect(result).toFailWith('core:aborted:dispatch');
    expect(sockets[0].sent.length).toBe(0); // never sent - aborted before dispatch
    ws.disconnect();
  });

  it('a late timeout after the response already settled is a no-op', async () => {
    vi.useFakeTimers();
    const ws = wsTransport({ url: 'ws://localhost', reconnect: false, timeout: 50 });
    const bus = createAsyncCommandBus({ onMissing: 'ignore', retry: false, transport: ws });
    ws.connect();
    await vi.runAllTimersAsync();

    const result = bus.dispatch('cartAdd', { id: 1 });
    const sent = JSON.parse(sockets[0].sent[0]);
    // Response arrives well before the timeout - settles as a success.
    sockets[0].receive({ id: sent.id, state: 42 });
    expect((await result).ok).toBe(true);

    // The timeout firing afterwards must not overwrite the already-settled
    // result - settle() cleared the timer, and resolve() is a no-op repeated.
    await vi.advanceTimersByTimeAsync(100);
    expect((await result).value).toBe(42);

    ws.disconnect();
  });
});

// ---------------------------------------------------------------------------
// createSseBridge - extra coverage alongside transports.test.ts
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

    // EventSource native reconnect handler is a no-op - just must not throw.
    expect(() => lastEs.onerror?.()).not.toThrow();

    sse.dispose();
    expect(sse.isConnected()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createEchoBridge - broadcast handler error path
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

  it('logs and swallows errors thrown inside onBroadcast', () => {
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
      expect.stringContaining('transport:failed:onBroadcast'),
      expect.any(Error),
    );
  });
});

// ---------------------------------------------------------------------------
// Signal-merging fallbacks + the per-dispatch header/retry arms
//
// Every merge site goes through http.ts's _combineSignals, `AbortSignal.any`
// or its fallback. Node has AbortSignal.any, so the fallback - the one that runs
// on older Safari/Firefox - had no coverage. Removed the same way
// tests/plugins-extra-gaps.test.ts drives supersede's equivalent branch.
// ---------------------------------------------------------------------------

describe('bridge signal merging - AbortSignal.any fallbacks', () => {
  const okFetch = () =>
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ state: 1 }) , text: async () => JSON.stringify(({ state: 1 }))}));

  it('combines the bridge signal and the scope when AbortSignal.any is missing', async () => {
    const origAny = AbortSignal.any;
    // @ts-expect-error deliberate removal to drive the fallback arm
    AbortSignal.any = undefined;
    try {
      okFetch();
      const bus = createAsyncCommandBus({
        retry: false,
        transport: httpTransport({
          endpoint: '/api',
          scopeController: new AbortController(),
          signal: new AbortController().signal, // both present -> merge site
        }),
      });
      const result = await bus.dispatch('act', {});
      expect(result.ok).toBe(true);
    } finally {
      AbortSignal.any = origAny;
    }
  });

  it('combines the bridge signal and the dispatch signal when AbortSignal.any is missing', async () => {
    const origAny = AbortSignal.any;
    // @ts-expect-error deliberate removal to drive the fallback arm
    AbortSignal.any = undefined;
    try {
      okFetch();
      const bus = createAsyncCommandBus({ retry: false, transport: httpTransport({ endpoint: '/api', signal: new AbortController().signal }) });
      // cmd.signal AND effectiveSignal both present -> the second merge site.
      const result = await bus.dispatch('act', {}, undefined, { signal: new AbortController().signal });
      expect(result.ok).toBe(true);
    } finally {
      AbortSignal.any = origAny;
    }
  });

  it('batching bridge combines the same way', async () => {
    const origAny = AbortSignal.any;
    // @ts-expect-error deliberate removal to drive the fallback arm
    AbortSignal.any = undefined;
    try {
      // The batch endpoint answers `{ results: [{ id, ok, state }] }` - a bare
      // array never matched, so every dispatch through this mock failed and the
      // swallowed `.catch()` hid it. The id is echoed from the request so the
      // bridge can pair the reply to its caller.
      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
          const sent = JSON.parse(String(init.body)) as { commands: Array<{ id: string }> };
          return {
            ok: true,
            json: async () => ({ results: sent.commands.map((c) => ({ id: c.id, state: 1 })) }), text: async () => JSON.stringify(({ results: sent.commands.map((c) => ({ id: c.id, state: 1 })) })),
          };
        }),
      );
      const bus = createAsyncCommandBus({
        retry: false,
        transport: httpTransport({
          endpoint: '/api/batch',
          scopeController: new AbortController(),
          signal: new AbortController().signal,
          batch: {},
        }),
      });
      // Assert the RESULT, not merely that we got here. The previous form was
      // `.catch(() => {})` followed by `expect(true).toBe(true)`: if the
      // fallback merge threw, the catch swallowed it, the assertion still
      // passed, and the coverage line was still counted - a test that drove a
      // branch without checking it.
      const result = await bus.dispatch('act', {});
      expect(result.ok).toBe(true);
    } finally {
      AbortSignal.any = origAny;
    }
  });

  it('forwards the Idempotency-Key the idempotent plugin stamps', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ state: 1 }) , text: async () => JSON.stringify(({ state: 1 }))});
    vi.stubGlobal('fetch', fetchMock);

    const bus = createAsyncCommandBus({ retry: false, transport: httpTransport({ endpoint: '/api' }) });
    // Stamp the key the `idempotent` plugin would normally set, so the bridge
    // takes the `idemKey ? {...} : headers` TRUE arm.
    bus.use({ started: (cmd) => { if (cmd.meta) cmd.meta.idempotencyKey = 'key-123'; } });

    const result = await bus.dispatch('act', {});
    expect(result.ok).toBe(true);

    const [, init] = fetchMock.mock.calls[0];
    // A Structured Field String, as the draft requires
    // (tests/idempotency-header.test.ts).
    expect(init.headers['Idempotency-Key']).toBe('"key-123"');
  });
});
