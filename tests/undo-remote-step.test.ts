/**
 * History never undoes or redoes locally a command a transport carried out.
 * Why: a transport replaces the local handler, so a local inverse would change the client for a write only the server made, and a redo would send a second request without an Idempotency-Key.
 * Shows: for http, batching and websocket transports the step reads canUndo false and undo runs no local inverse; redo sends nothing again (http); a later local step undoes as usual; without a transport the same action undoes and redoes.
 * See: log s35.159
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAsyncCommandBus, type Transport } from '../src/command-bus';
import { httpTransport, wsTransport } from '../src/transports';
import { history } from '../src/plugins-core';

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

/** A bus with history, a local `docSave` with an inverse, and `transport` sending `doc*`. */
function setup(transport?: Transport) {
  const bus = createAsyncCommandBus({ retry: false, transport: transport && { 'doc*': transport } });
  const h = history({ bus });
  let local = 0;
  // With a transport docSave has no local handler; its undo is what history would wrongly run.
  bus.register('docSave', transport ? null : async () => { local++; return 'local'; }, { undo: () => { local--; } });
  bus.register('noteAdd', async () => { local++; return 'local'; }, { undo: () => { local--; } });
  return { bus, h, local: () => local };
}

describe('a step a transport carried out', () => {
  for (const [name, make] of [
    ['http transport', () => httpTransport({ endpoint: '/api/vc' })],
    ['batching transport', () => httpTransport({ endpoint: '/api/vc/batch', batch: {} })],
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

  it('websocket transport: canUndo is false and undo runs no local inverse', async () => {
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
      const ws = wsTransport({ url: 'ws://test' });
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

  it('a local step after it undoes as usual, then the sent step reads canUndo false', async () => {
    const { bus, h, local } = setup(httpTransport({ endpoint: '/api/vc' }));
    await bus.dispatch('docSave', { id: 1 });
    await bus.dispatch('noteAdd', { id: 2 });
    expect(local()).toBe(1);
    expect(h.getState().canUndo).toBe(true);
    await h.undo();
    expect(local()).toBe(0);
    expect(h.getState().canUndo).toBe(false);
  });

  it('control: without a transport the same action undoes and redoes locally', async () => {
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
