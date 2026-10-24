/**
 * wsTransport: a command whose envelope JSON cannot encode (a BigInt in its
 * payload) fails alone. Held while disconnected, its `done` settles with
 * `transport:invalid:json` when the outbox sends it, and the commands held
 * behind it still go. Once it threw out of the flush on reconnect: the
 * commands behind it were never sent, and `onConnect` was skipped.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Accepted } from '../src/accepted';
import { createAsyncCommandBus } from '../src/command-bus';
import { wsTransport } from '../src/transports';

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

describe('wsTransport - an unencodable queued command', () => {
  it('does not strand the commands queued behind it', async () => {
    let connects = 0;
    const bridge = wsTransport({ url: 'ws://x', onConnect: () => { connects++; } });
    const bus = createAsyncCommandBus({ retry: false, transport: bridge });
    bridge.connect();
    const ws = FakeWs.made[0]!;
    const bad = await bus.dispatch('bad', {}, { n: 1n });
    await bus.dispatch('good', {}, { n: 1 });
    ws.readyState = FakeWs.OPEN;
    ws.onopen?.();
    expect(await (bad.value as Accepted).done).toFailWith('transport:invalid:json');
    await new Promise((r) => setTimeout(r, 0));
    expect({ sentGood: ws.sent.some((s) => s.includes('"good"')), connects }).toEqual({ sentGood: true, connects: 1 });
    bridge.disconnect();
  });
});
