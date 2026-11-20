/**
 * `request()` and a WebSocket send settle without an async frame of their own.
 * Why: both were `async` functions whose body awaited nothing and returned a promise, so every call paid a promise and the thenable-resolve job (V8-RULES rule 20). The local dispatch on the same bus is the path without that step; a reply frame and a responder are the work that stays.
 * Shows: a request's turns stay within one of a local dispatch (the joiner promise), and a WS dispatch's within two (the reply frame). A control adds one microtask to each and must cost one more.
 * See: docs/V8-RULES.md rule 20, log 36.F59, scripts/ab/workloads/ws-reply.mjs
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAsyncCommandBus } from '../src/command-bus';
import { wsTransport } from '../src/transports';

/** Microtask turns between the call and its promise settling. */
async function turns(p: Promise<unknown>): Promise<number> {
  let done = false;
  p.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  let n = 0;
  while (!done && n < 1_000) {
    await null;
    n++;
  }
  return n;
}

class FakeWs {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  readyState = FakeWs.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  send(data: string): void {
    const { id } = JSON.parse(data) as { id: string };
    queueMicrotask(() => this.onmessage?.({ data: `{"id":"${id}","status":200,"state":1}` }));
  }
  close(): void {
    this.readyState = FakeWs.CLOSED;
  }
}

beforeEach(() => {
  vi.stubGlobal('WebSocket', FakeWs);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('async frames on request and a WebSocket send', () => {
  it('a request costs one turn over a local dispatch', async () => {
    const bus = createAsyncCommandBus({ retry: false });
    bus.register('local', () => 1);
    bus.respond('priceGet', () => 1);
    const local = await turns(Promise.resolve(bus.dispatch('local', {})));
    const request = await turns(bus.request('priceGet', {}));
    expect({ local, request }).toEqual({ local: 2, request: 4 });
  });

  it('control: one more await in the responder costs one more turn', async () => {
    const bus = createAsyncCommandBus({ retry: false });
    bus.respond('priceGet', () => 1);
    bus.respond('slowGet', async () => {
      await null;
      return 1;
    });
    const quick = await turns(bus.request('priceGet', {}));
    const slow = await turns(bus.request('slowGet', {}));
    expect(slow).toBe(quick + 1);
  });

  it('a WebSocket dispatch costs two turns over a local dispatch', async () => {
    const localBus = createAsyncCommandBus({ retry: false });
    localBus.register('local', () => 1);
    const bridge = wsTransport({ url: 'ws://fake', reconnect: false });
    const bus = createAsyncCommandBus({ retry: false, transport: bridge });
    bridge.connect();
    await new Promise((r) => setTimeout(r, 0));
    const local = await turns(Promise.resolve(localBus.dispatch('local', {})));
    const sent = await turns(Promise.resolve(bus.dispatch('chatSend', { i: 1 })));
    expect({ local, sent }).toEqual({ local: 2, sent: 4 });
    bridge.disconnect();
  });
});
