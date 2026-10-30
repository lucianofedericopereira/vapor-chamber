/**
 * `wsTransport` holding a send in an outbox while its socket is down: its own in-memory one, or the app's.
 * Why: if a held command were lost, expired without a code, or held twice, a chat or realtime caller would never hear the outcome of a send made while offline.
 * Shows: a send while down answers an `Accepted` whose `done` settles with the reply after the socket opens; the held queue is bounded at 100, expires at the reply timeout and settles on `disconnect()` with outbox codes; a command already sent then torn down hears `transport:lost:reply`; a replay into a closed socket is refused unsent as `transport:limited:socket`; an app outbox holds the action durably and flushes when the socket opens.
 * See: log s36.74
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Accepted } from '../src/accepted';
import { type CommandResult, createAsyncCommandBus } from '../src/command-bus';
import { createOutbox } from '../src/outbox';
import { createTestBus } from '../src/testing';
import { wsTransport } from '../src/transports';
import { queueStorage } from './outbox-storage';

class Socket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static all: Socket[] = [];
  readyState = Socket.CLOSED;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  sent: string[] = [];
  constructor(public url: string) { Socket.all.push(this); }
  send(data: string) { this.sent.push(data); }
  close() { this.readyState = Socket.CLOSED; }
  open() { this.readyState = Socket.OPEN; this.onopen?.(); }
  /** Answer every frame sent so far with `state: <its target>`. */
  answerAll() {
    for (const raw of this.sent.splice(0)) {
      const f = JSON.parse(raw);
      this.onmessage?.({ data: JSON.stringify({ id: f.id, state: f.target }) });
    }
  }
}

const doneOf = async (r: Promise<CommandResult>): Promise<CommandResult> => ((await r).value as Accepted).done;
const socket = () => Socket.all[Socket.all.length - 1] as Socket;
const flushed = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => { Socket.all = []; vi.stubGlobal('WebSocket', Socket); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('the WS transport, its socket down', () => {
  it('answers an Accepted whose done settles with the reply once the socket opens', async () => {
    const ws = wsTransport({ url: 'ws://x', reconnect: false });
    const bus = createAsyncCommandBus({ retry: false, transport: ws });
    ws.connect();
    const r = bus.dispatch('chatSend', 'hi');
    expect((await r).value).toBeInstanceOf(Accepted);
    expect(ws.outbox.pending.value).toBe(1);
    expect(socket().sent).toHaveLength(0);
    socket().open();
    await flushed();
    socket().answerAll();
    expect(await doneOf(r)).toMatchObject({ ok: true, value: 'hi' });
    expect(ws.outbox.pending.value).toBe(0);
  });

  it('control: an open socket answers the reply itself', async () => {
    const ws = wsTransport({ url: 'ws://x', reconnect: false });
    const bus = createAsyncCommandBus({ retry: false, transport: ws });
    ws.connect();
    socket().open();
    const r = bus.dispatch('chatSend', 'hi');
    await flushed();
    socket().answerAll();
    expect(await r).toMatchObject({ ok: true, value: 'hi' });
  });

  it('a held command expires at the reply timeout, coded', async () => {
    vi.useFakeTimers();
    const ws = wsTransport({ url: 'ws://x', reconnect: false, timeout: 1000 });
    const bus = createAsyncCommandBus({ retry: false, transport: ws });
    ws.connect();
    const r = bus.dispatch('chatSend', 'hi');
    await vi.advanceTimersByTimeAsync(1001);
    expect(await doneOf(r)).toFailWith('outbox:timeout:queue');
    expect(ws.outbox.pending.value).toBe(0);
  });

  it('holds 100: the oldest past that settles coded', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ws = wsTransport({ url: 'ws://x', reconnect: false });
    const bus = createAsyncCommandBus({ retry: false, transport: ws });
    ws.connect();
    const first = bus.dispatch('chatSend', 0);
    for (let i = 1; i <= 100; i++) await bus.dispatch('chatSend', i);
    expect(await doneOf(first)).toFailWith('outbox:exceeded:queue');
    expect(ws.outbox.pending.value).toBe(100);
  });

  it('disconnect() settles a held caller', async () => {
    const ws = wsTransport({ url: 'ws://x', reconnect: false });
    const bus = createAsyncCommandBus({ retry: false, transport: ws });
    ws.connect();
    const r = bus.dispatch('chatSend', 'hi');
    await r;
    ws.disconnect();
    expect(await doneOf(r)).toFailWith('outbox:aborted:clear');
  });

  it('a held command sent, then torn down before its reply, hears lost:reply, not a clear', async () => {
    const ws = wsTransport({ url: 'ws://x', reconnect: false });
    const bus = createAsyncCommandBus({ retry: false, transport: ws });
    ws.connect();
    const r = bus.dispatch('chatSend', 'hi');
    await r;
    socket().open();
    await flushed();
    expect(socket().sent).toHaveLength(1);
    ws.disconnect();
    expect(await doneOf(r)).toFailWith('transport:lost:reply');
  });

  it('a replay into a closed socket is refused unsent, retryable', async () => {
    const ws = wsTransport({ url: 'ws://x', reconnect: false });
    const bus = createAsyncCommandBus({ retry: false, transport: ws });
    ws.connect();
    const cmd = { action: 'chatSend', target: 1, meta: { id: 'r1', ts: 0, origin: 'replay' as const } };
    expect(await ws.send(cmd as never, async () => ({ ok: true, value: 'local', error: undefined }))).toFailWith('transport:limited:socket');
    void bus;
  });
});

describe('the WS transport: edges', () => {
  it('the ttl passing while the command is being sent: done settles with the reply, not an expiry', async () => {
    const ws = wsTransport({ url: 'ws://x', reconnect: false, timeout: 60 });
    const bus = createAsyncCommandBus({ retry: false, transport: ws });
    ws.connect();
    const r = bus.dispatch('chatSend', 'hi');
    await r;
    await new Promise((res) => setTimeout(res, 30));
    socket().open();
    await flushed();
    expect(socket().sent).toHaveLength(1); // in flight: held 30 ms of its 60
    await new Promise((res) => setTimeout(res, 40)); // past the ttl, still in flight
    socket().answerAll();
    expect(await doneOf(r)).toMatchObject({ ok: true, value: 'hi' });
  });

  it('a signal aborted after the dispatch and before the send: aborted, nothing sent', async () => {
    const ws = wsTransport({ url: 'ws://x', reconnect: false });
    const bus = createAsyncCommandBus({ retry: false, transport: ws });
    ws.connect();
    socket().open();
    const ac = new AbortController();
    bus.use({ id: 'late', begin: () => { ac.abort(); return undefined; } });
    const r = await bus.dispatch('chatSend', 'hi', undefined, { signal: ac.signal });
    expect(r).toFailWith('core:aborted:dispatch');
    expect(socket().sent).toHaveLength(0);
  });
});

describe('the test bus', () => {
  it('a WS command held while down is sent when the socket opens', async () => {
    const ws = wsTransport({ url: 'ws://x', reconnect: false });
    const bus = createTestBus({ transport: ws }) as unknown as { dispatch: (a: string, t: unknown) => Promise<CommandResult> };
    ws.connect();
    const r = bus.dispatch('chatSend', 'hi');
    expect((await r).value).toBeInstanceOf(Accepted);
    socket().open();
    await flushed();
    socket().answerAll();
    expect(await doneOf(r)).toMatchObject({ ok: true, value: 'hi' });
  });
});

describe("the app's outbox over a WS action", () => {
  it('control: an open socket with nothing held sends it at once', async () => {
    const outbox = createOutbox({ storage: null, isOnline: () => true });
    const ws = wsTransport({ url: 'ws://x', reconnect: false });
    const bus = createAsyncCommandBus({ retry: false, transport: ws, outbox });
    ws.connect();
    socket().open();
    await flushed();
    const r = bus.dispatch('chatSend', 'hi');
    await flushed();
    socket().answerAll();
    expect(await r).toMatchObject({ ok: true, value: 'hi' });
  });

  it('holds it durably while the socket is down and flushes when it opens', async () => {
    const storage = queueStorage();
    const outbox = createOutbox({ storage, isOnline: () => true });
    const ws = wsTransport({ url: 'ws://x', reconnect: false });
    const bus = createAsyncCommandBus({ retry: false, transport: ws, outbox });
    ws.connect();
    const r = bus.dispatch('chatSend', 'hi');
    expect((await r).value).toBeInstanceOf(Accepted);
    expect(storage.rows().map((x) => x.action)).toEqual(['chatSend']);
    expect(ws.outbox.pending.value).toBe(0);
    socket().open();
    await flushed();
    socket().answerAll();
    expect(await doneOf(r)).toMatchObject({ ok: true, value: 'hi' });
    expect(storage.rows()).toEqual([]);
  });
});
