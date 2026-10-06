/** History never undoes or redoes locally a command a bridge carried out (plan 1.27 item 1, R9). Rationale at the end. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAsyncCommandBus } from '../src/command-bus';
import { history } from '../src/plugins-core';
import { createBatchingHttpBridge, createHttpBridge, createWsBridge } from '../src/transports';

const realFetch = globalThis.fetch;
let requests = 0;
beforeEach(() => {
  requests = 0;
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    requests++;
    const body = JSON.parse(init.body);
    const json = body.commands ? { results: body.commands.map((c: { id: string }) => ({ id: c.id, state: 'saved' })) } : { state: 'saved' };
    return new Response(JSON.stringify(json), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
});
afterEach(() => { globalThis.fetch = realFetch; });

/** A bus with history, a local `docSave` with an inverse, and `bridge` forwarding `doc*`. */
function setup(bridge?: unknown) {
  const bus = createAsyncCommandBus({ retry: false });
  const h = history({ bus });
  bus.use(h);
  if (bridge) bus.use(bridge as never);
  let local = 0;
  bus.register('docSave', async () => { local++; return 'local'; }, { undo: () => { local--; } });
  bus.register('noteAdd', async () => { local++; return 'local'; }, { undo: () => { local--; } });
  return { bus, h, local: () => local };
}

describe('a step a bridge carried out', () => {
  for (const [name, make] of [
    ['http bridge', () => createHttpBridge({ endpoint: '/api/vc', actions: ['doc*'] })],
    ['batching bridge', () => createBatchingHttpBridge({ endpoint: '/api/vc/batch', actions: ['doc*'] })],
  ] as const) {
    it(`${name}: canUndo is false, undo runs no local inverse, nothing is sent again`, async () => {
      const { bus, h, local } = setup(make());
      const r = await bus.dispatch('docSave', { id: 1 });
      expect(r.ok).toBe(true);
      expect(local()).toBe(0);
      expect(requests).toBe(1);
      expect(h.getState().canUndo).toBe(false);
      expect(h.undo()).toBeUndefined();
      await new Promise((res) => setTimeout(res, 5));
      expect(local()).toBe(0);
      h.redo();
      await new Promise((res) => setTimeout(res, 5));
      expect(requests).toBe(1);
    });
  }

  it('websocket bridge: canUndo is false and undo runs no local inverse', async () => {
    class FakeWebSocket {
      static OPEN = 1;
      readyState = 1;
      onopen: any = null;
      onmessage: any = null;
      onclose: any = null;
      onerror: any = null;
      constructor(public url: string) { queueMicrotask(() => this.onopen?.()); }
      send(data: string) {
        const { id } = JSON.parse(data);
        queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ id, state: 'saved' }) }));
      }
      close() { this.readyState = 3; }
    }
    const original = (globalThis as any).WebSocket;
    (globalThis as any).WebSocket = FakeWebSocket;
    try {
      const ws = createWsBridge({ url: 'ws://test', actions: ['doc*'] });
      ws.connect();
      const { bus, h, local } = setup(ws);
      await new Promise((res) => queueMicrotask(() => res(null)));
      const r = await bus.dispatch('docSave', { id: 1 });
      expect(r.ok).toBe(true);
      expect(h.getState().canUndo).toBe(false);
      expect(h.undo()).toBeUndefined();
      expect(local()).toBe(0);
      ws.disconnect();
    } finally {
      (globalThis as any).WebSocket = original;
    }
  });

  it('a local step after it undoes as usual, then the bridged step reads canUndo false', async () => {
    const { bus, h, local } = setup(createHttpBridge({ endpoint: '/api/vc', actions: ['doc*'] }));
    await bus.dispatch('docSave', { id: 1 });
    await bus.dispatch('noteAdd', { id: 2 });
    expect(local()).toBe(1);
    expect(h.getState().canUndo).toBe(true);
    await h.undo();
    expect(local()).toBe(0);
    expect(h.getState().canUndo).toBe(false);
  });

  it('control: without a bridge the same action undoes and redoes locally', async () => {
    const { bus, h, local } = setup();
    await bus.dispatch('docSave', { id: 1 });
    expect(h.getState().canUndo).toBe(true);
    h.undo();
    await new Promise((res) => setTimeout(res, 5));
    expect(local()).toBe(0);
    h.redo();
    await new Promise((res) => setTimeout(res, 5));
    expect(local()).toBe(1);
  });
});

/*
 * A bridge replaces the local handler for the actions it matches: the server
 * applies the command, the local handler never runs. History still recorded
 * it, so undo ran the LOCAL inverse of a change that happened only on the
 * server, and redo dispatched it again: a second request, with no
 * Idempotency-Key (plan P1). The client was then off by one and the server
 * held the write twice.
 *
 * Undo is local (plan item 1, R8): undoing a remote write is the app's
 * compensating command, sent with the write's identity. So a step a bridge
 * carried out reads canUndo false, undo() does nothing, and with nothing
 * undone there is nothing to redo. The bridges mark such a command where they
 * turn the server's answer into a result (`answerOf`); history reads the mark
 * only when it asks canUndo or undoes, never per dispatch.
 */
