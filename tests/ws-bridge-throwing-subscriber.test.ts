/**
 * FIXTURE - a synchronous subscriber that THROWS on `createWsBridge`'s
 * `connected` signal must not stop the bookkeeping behind the write: the queue
 * flush on open, the reconnect on close, the teardown in `disconnect()`. Real
 * Vue `effect`s. The long note is at the end.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { effect, isRef } from 'vue';
import { waitForVueDetection } from '../src/chamber';
import { createAsyncCommandBus } from '../src/command-bus';
import { createWsBridge } from '../src/transports';

const boom = new Error('subscriber threw');
let events: string[] = [];

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
  constructor(public url: string) {
    FakeWs.made.push(this);
    events.push('socket');
  }
  send(data: string) {
    this.sent.push(data);
    events.push('send');
  }
  close() {
    this.readyState = FakeWs.CLOSED;
    events.push('close');
  }
}

/** Call something that may throw; keep what escaped. */
function escapedFrom(run: () => void): unknown {
  try {
    run();
    return undefined;
  } catch (e) {
    return e;
  }
}

/** A bridge on a bus, connected to a FakeWs that has not opened yet. */
function setup() {
  const bus = createAsyncCommandBus({ retry: false });
  const counts = { onConnect: 0, onDisconnect: 0 };
  const bridge = createWsBridge({
    url: 'ws://x',
    reconnectDelay: 10,
    onConnect: () => {
      counts.onConnect++;
      events.push('onConnect');
    },
    onDisconnect: () => {
      counts.onDisconnect++;
      events.push('onDisconnect');
    },
  });
  bus.use(bridge);
  bridge.connect();
  const socket = FakeWs.made[0];
  let settled = 'pending';
  const dispatch = () =>
    void bus.dispatch('save', {}).then((r) => {
      settled = r.ok ? 'ok' : `failed ${(r.error as { code?: string }).code}`;
      events.push(`settled:${settled}`);
    });
  return { bridge, socket, counts, dispatch, settled: () => settled };
}

function open(socket: FakeWs): unknown {
  socket.readyState = FakeWs.OPEN;
  return escapedFrom(() => socket.onopen?.());
}

describe('createWsBridge: a throwing sync subscriber on `connected`', () => {
  beforeAll(async () => {
    await waitForVueDetection();
  });
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeWs);
    FakeWs.made = [];
    events = [];
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('on open: the queued message is still sent and onConnect still runs', async () => {
    const { bridge, socket, counts, dispatch } = setup();
    // Control: the signal is Vue's, so the effect below is a real subscriber.
    expect(isRef(bridge.connected)).toBe(true);
    dispatch();
    await Promise.resolve();
    let threw = 0;
    const runner = effect(() => {
      if (bridge.connected.value) {
        threw++;
        throw boom;
      }
    });

    const escaped = open(socket);

    expect(threw).toBe(1);
    // Unchanged: the error still leaves the socket's `onopen` handler.
    expect(escaped).toBe(boom);
    expect({ connected: bridge.connected.value, sent: socket.sent.length, onConnect: counts.onConnect }).toEqual({
      connected: true,
      sent: 1,
      onConnect: 1,
    });
    runner.effect.stop();
    bridge.disconnect();
  });

  it('on close: onDisconnect still runs and the bridge still reconnects', async () => {
    const { bridge, socket, counts } = setup();
    open(socket);
    let threw = 0;
    let armed = false;
    const runner = effect(() => {
      if (!bridge.connected.value && armed) {
        threw++;
        throw boom;
      }
    });
    armed = true;

    socket.readyState = FakeWs.CLOSED;
    const escaped = escapedFrom(() => socket.onclose?.({}));
    armed = false;
    await vi.advanceTimersByTimeAsync(50);

    expect(threw).toBe(1);
    expect(escaped).toBe(boom);
    expect({ connected: bridge.connected.value, onDisconnect: counts.onDisconnect, sockets: FakeWs.made.length }).toEqual({
      connected: false,
      onDisconnect: 1,
      sockets: 2,
    });
    runner.effect.stop();
    bridge.disconnect();
  });

  it('in disconnect(): the in-flight request still fails at once and the socket is still closed', async () => {
    const { bridge, socket, dispatch, settled } = setup();
    open(socket);
    dispatch();
    await Promise.resolve();
    expect(socket.sent.length).toBe(1);
    let threw = 0;
    let armed = false;
    const runner = effect(() => {
      if (!bridge.connected.value && armed) {
        threw++;
        throw boom;
      }
    });
    armed = true;

    const escaped = escapedFrom(() => bridge.disconnect());
    await vi.advanceTimersByTimeAsync(0);

    expect(threw).toBe(1);
    expect(escaped).toBe(boom);
    expect({ settled: settled(), socketState: socket.readyState, isConnected: bridge.isConnected() }).toEqual({
      settled: 'failed transport:lost:reply',
      socketState: FakeWs.CLOSED,
      isConnected: false,
    });
    // No reconnect follows an intentional disconnect.
    await vi.advanceTimersByTimeAsync(50);
    expect(FakeWs.made.length).toBe(1);
    runner.effect.stop();
  });

  it('control, no throwing subscriber: the order of the write and the bookkeeping is unchanged', async () => {
    const { bridge, socket, dispatch } = setup();
    const runner = effect(() => void events.push(`connected:${bridge.connected.value}`));
    dispatch();
    await Promise.resolve();
    events.length = 0;

    expect(open(socket)).toBeUndefined();
    expect(events).toEqual(['connected:true', 'send', 'onConnect']);
    events.length = 0;

    socket.readyState = FakeWs.CLOSED;
    socket.onclose?.({});
    await vi.advanceTimersByTimeAsync(50);
    expect(events).toEqual(['connected:false', 'onDisconnect', 'socket']);
    events.length = 0;

    const second = FakeWs.made[1];
    open(second);
    expect(events).toEqual(['connected:true', 'onConnect']);
    events.length = 0;

    bridge.disconnect();
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toEqual(['connected:false', 'close', 'settled:failed transport:lost:reply']);
    runner.effect.stop();
  });
});

/*
 * Why this file exists. Found by reading `transports.ts` against Vue
 * `ef5ff106` (log s35.18) and fixed in s35.23: the shape `runDispatch` had.
 *
 * `connected.value = ...` was the first statement of the socket's `onopen`
 * and `onclose` handlers and the second of `disconnect()`, with the
 * bookkeeping after it. A Vue effect runs inside the write that triggers it,
 * so a subscriber that throws there skipped the bookkeeping:
 *
 *   onopen       the queue was not flushed (a command dispatched while the
 *                socket was connecting was never sent, and sat until its own
 *                timeout) and `onConnect` did not run.
 *   onclose      `onDisconnect` did not run and no reconnect was scheduled:
 *                the bridge stayed down.
 *   disconnect   in-flight requests were not failed and the socket was not
 *                closed.
 *
 * Each write now sits in a `try` whose `finally` holds the bookkeeping. The
 * subscriber's error still leaves the handler (or `disconnect()`), as before;
 * each test pins that too. The last test is the control: the order of the
 * subscriber's run against sends, callbacks, the reconnect socket, the close
 * and the settled request. The lists are the ones this test produced before
 * the move.
 */
