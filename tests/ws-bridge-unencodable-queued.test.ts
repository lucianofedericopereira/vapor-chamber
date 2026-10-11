/**
 * createWsBridge: a command whose envelope JSON cannot encode (a BigInt in its
 * payload) fails its own dispatch, queued or not. Queued while disconnected,
 * it threw out of the flush on reconnect: the commands queued behind it were
 * already off the queue and never sent, and `onConnect` was skipped.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAsyncCommandBus } from '../src/command-bus';
import { createWsBridge } from '../src/transports';

class FakeWs {
  static CONNECTING = 0; static OPEN = 1; static CLOSED = 3;
  static made: FakeWs[] = [];
  readyState = FakeWs.CONNECTING;
  onopen: (() => void) | null = null; onmessage: any = null; onclose: any = null; onerror: any = null;
  sent: string[] = [];
  constructor(public url: string) { FakeWs.made.push(this); }
  send(d: string) { this.sent.push(d); }
  close() { this.readyState = FakeWs.CLOSED; }
}
beforeEach(() => { FakeWs.made = []; vi.stubGlobal('WebSocket', FakeWs); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('createWsBridge - an unencodable queued command', () => {
  it('does not strand the commands queued behind it', async () => {
    const bus = createAsyncCommandBus({ retry: false });
    let connects = 0;
    const bridge = createWsBridge({ url: 'ws://x', onConnect: () => { connects++; } });
    bus.use(bridge);
    bridge.connect();
    const ws = FakeWs.made[0]!;
    const bad = bus.dispatch('bad', {}, { n: 1n });
    void bus.dispatch('good', {}, { n: 1 });
    await Promise.resolve();
    ws.readyState = FakeWs.OPEN;
    ws.onopen?.();
    expect({ sentGood: ws.sent.some((s) => s.includes('"good"')), connects }).toEqual({ sentGood: true, connects: 1 });
    expect((await bad).ok).toBe(false);
    bridge.disconnect();
  });
});
