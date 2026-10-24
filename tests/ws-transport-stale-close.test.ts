/**
 * wsTransport - the close of a socket already replaced is not the bridge's.
 *
 * `disconnect()` then `connect()` (a reconnect button, a new auth token) opens
 * a second socket while the first one's close event is still on its way. That
 * close event ran the bridge's teardown as if the current socket had closed:
 * `disconnect()`'s intentional mark was already reset by `connect()`, so with
 * `reconnect: false` it failed every command queued for the new socket
 * (`lost:reply`) and emptied the queue, and with `reconnect: true` it scheduled
 * a reconnect and set `connected` false under an open socket. A replaced
 * socket's close now only reports `onDisconnect`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Accepted } from '../src/accepted';
import { createAsyncCommandBus } from '../src/command-bus';
import { wsTransport } from '../src/transports';

class FakeWs {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static made: FakeWs[] = [];
  readyState = FakeWs.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  sent: string[] = [];
  constructor(public url: string) { FakeWs.made.push(this); }
  send(data: string) { this.sent.push(data); }
  close() { this.readyState = FakeWs.CLOSED; }
  open() { this.readyState = FakeWs.OPEN; this.onopen?.(); }
  reply(id: string, value: unknown) { this.onmessage?.({ data: JSON.stringify({ id, state: value }) }); }
}

beforeEach(() => { FakeWs.made = []; vi.stubGlobal('WebSocket', FakeWs); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

function setup(reconnect: boolean) {
  let disconnects = 0;
  const bridge = wsTransport({ url: 'ws://x', reconnect, reconnectDelay: 10, onDisconnect: () => { disconnects++; } });
  const bus = createAsyncCommandBus({ retry: false, transport: bridge });
  bridge.connect();
  FakeWs.made[0]!.open();
  return { bus, bridge, disconnects: () => disconnects };
}

describe('wsTransport - a replaced socket closing late', () => {
  it('does not fail the commands queued for the new socket (reconnect: false)', async () => {
    const { bus, bridge, disconnects } = setup(false);
    const [first] = FakeWs.made;
    bridge.disconnect();
    bridge.connect();
    const second = FakeWs.made[1]!;
    const held = await bus.dispatch('save', { id: 1 });
    first!.onclose?.({ code: 1000 }); // the old socket's close arrives now
    second.open();
    await new Promise((r) => setTimeout(r, 0));
    expect(second.sent).toHaveLength(1);
    second.reply(JSON.parse(second.sent[0]!).id, 'saved');
    expect(await (held.value as Accepted).done).toMatchObject({ ok: true, value: 'saved' });
    expect(disconnects()).toBe(1);
  });

  it('does not mark an open new socket disconnected or schedule a reconnect (reconnect: true)', () => {
    vi.useFakeTimers();
    const { bridge } = setup(true);
    const [first] = FakeWs.made;
    bridge.disconnect();
    bridge.connect();
    FakeWs.made[1]!.open();
    first!.onclose?.({ code: 1000 });
    expect(bridge.connected.value).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(FakeWs.made).toHaveLength(2);
  });

  it('a current socket closing still reconnects', () => {
    vi.useFakeTimers();
    const { bridge } = setup(true);
    FakeWs.made[0]!.onclose?.({ code: 1006 });
    expect(bridge.connected.value).toBe(false);
    vi.advanceTimersByTime(10);
    expect(FakeWs.made).toHaveLength(2);
  });
});

describe('wsTransport - a disconnected socket closing late', () => {
  it('reports onDisconnect and starts nothing when no new socket was opened', () => {
    vi.useFakeTimers();
    const { bridge, disconnects } = setup(true);
    const [first] = FakeWs.made;
    bridge.disconnect();
    first!.onclose?.({ code: 1000 });
    expect(bridge.connected.value).toBe(false);
    expect(disconnects()).toBe(1);
    vi.advanceTimersByTime(1000);
    expect(FakeWs.made).toHaveLength(1);
  });
});
