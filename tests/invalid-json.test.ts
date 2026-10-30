/**
 * A request that JSON cannot encode (a BigInt, a cycle) fails as transport:invalid:json, alone, with nothing sent and no re-send.
 * Why: such a request never leaves, so reporting it as a lost reply or a plugin fault would re-send an idempotent action for nothing, fail an encodable batch neighbour, or point the developer at the wrong cause.
 * Shows: the http client, safe.post, postCommand, httpTransport (with and without an httpClient, batched or not) and wsTransport all report transport:invalid:json with the TypeError as cause, no extra POST, no attempts context, and no console error; the encodable control request still succeeds.
 * See: audit D11.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BusError, createAsyncCommandBus } from '../src/command-bus';
import { createHttpClient, postCommand } from '../src/http';
import type { Transport } from '../src/command-bus';
import { httpTransport, wsTransport } from '../src/transports';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

/** A backend that answers every POST; counts them. */
function backend() {
  const seen = { posts: 0 };
  vi.stubGlobal('fetch', async (_u: string, init: { body: string }) => {
    seen.posts++;
    const ids = (JSON.parse(init.body) as { commands?: Array<{ id: string }> }).commands?.map((c) => c.id);
    const body = ids ? { results: ids.map((id) => ({ id, state: 'ok' })) } : { state: 'ok' };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  return seen;
}

const cycle = (): Record<string, unknown> => { const o: Record<string, unknown> = {}; o.self = o; return o; };
const code = (r: { ok: boolean; error?: unknown }) => (r.ok ? 'ok' : (r.error as BusError).code);

describe('the http client', () => {
  it('post() rejects with transport:invalid:json, the TypeError its cause, nothing sent', async () => {
    const seen = backend();
    const http = createHttpClient();
    await expect(http.post('/x', { n: 1 })).resolves.toMatchObject({ status: 200 }); // control
    const error = await http.post('/x', { n: 1n }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BusError);
    expect(error).toMatchObject({ code: 'transport:invalid:json', context: { url: '/x' } });
    expect((error as BusError).cause).toBeInstanceOf(TypeError);
    expect(seen.posts).toBe(1);
  });

  it('safe.post() returns that BusError, status 0', async () => {
    backend();
    const r = await createHttpClient().safe.post('/x', cycle());
    expect(r.error).toBeInstanceOf(BusError);
    expect(r).toMatchObject({ error: { code: 'transport:invalid:json' }, status: 0 });
  });

  it('postCommand rejects the same way', async () => {
    const seen = backend();
    await expect(postCommand('/x', { n: 1n })).rejects.toMatchObject({ code: 'transport:invalid:json' });
    expect(seen.posts).toBe(0);
  });
});

describe('the transports', () => {
  /** An async bus that re-sends `save` as idempotent, through `transport`. */
  const bus = (transport: Transport) => createAsyncCommandBus({ transport, retry: { actionPolicies: { save: 'idempotent' }, baseDelay: 1 } });

  for (const [name, make] of [
    ['httpTransport', () => httpTransport({ endpoint: '/vc' })],
    ['httpTransport with an httpClient', () => httpTransport({ endpoint: '/vc', httpClient: createHttpClient() })],
  ] as const) {
    it(`${name}: invalid:json, never re-sent, nothing sent`, async () => {
      const seen = backend();
      expect(code(await bus(make()).dispatch('save', {}, { n: 1 }))).toBe('ok'); // control
      const r = await bus(make()).dispatch('save', {}, { n: 1n });
      expect(r.error).toMatchObject({ code: 'transport:invalid:json', action: 'save' });
      expect((r.error as BusError).context).not.toHaveProperty('attempts');
      expect(seen.posts).toBe(1);
    });
  }

  for (const [name, make] of [
    ['httpTransport with batch', () => httpTransport({ endpoint: '/b', batch: {} })],
    ['httpTransport with batch and an httpClient', () => httpTransport({ endpoint: '/b', httpClient: createHttpClient(), batch: {} })],
  ] as const) {
    it(`${name}: the bad command fails alone, its neighbour is sent`, async () => {
      const seen = backend();
      const b = bus(make());
      const [good, bad] = await Promise.all([b.dispatch('good', {}, { n: 1 }), b.dispatch('save', {}, { n: 1n })]);
      expect([code(good), code(bad)]).toEqual(['ok', 'transport:invalid:json']);
      expect(seen.posts).toBe(1);
      const [a, c] = await Promise.all([b.dispatch('good', {}, { n: 1 }), b.dispatch('save', {}, { n: 2 })]); // control
      expect([code(a), code(c)]).toEqual(['ok', 'ok']);
    });
  }

  it('wsTransport: invalid:json, not a send failure', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    class EchoWs {
      static CONNECTING = 0; static OPEN = 1; static CLOSED = 3;
      static last: EchoWs;
      readyState = 0;
      onopen: (() => void) | null = null; onmessage: ((e: { data: string }) => void) | null = null; onclose = null; onerror = null;
      constructor() { EchoWs.last = this; }
      send(d: string) { const { id } = JSON.parse(d) as { id: string }; queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ id, state: 'ok' }) })); }
      close() {}
    }
    vi.stubGlobal('WebSocket', EchoWs);
    const ws = wsTransport({ url: 'ws://x', reconnect: false });
    const b = bus(ws);
    ws.connect();
    EchoWs.last.readyState = 1;
    EchoWs.last.onopen!();
    expect(code(await b.dispatch('save', {}, { n: 1 }))).toBe('ok'); // control
    const r = await b.dispatch('save', {}, { n: 1n });
    expect(r.error).toMatchObject({ code: 'transport:invalid:json', action: 'save' });
    expect(errors).not.toHaveBeenCalled();
    ws.disconnect();
  });
});
