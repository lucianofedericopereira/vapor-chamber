/**
 * `meta.request`: request-level headers a bus plugin adds, sent by `httpTransport`.
 * Why: a plugin header (a trace id) that never reaches the request, or that leaks into the bridge's shared headers, would tag the wrong requests or none.
 * Shows: a plugin header is sent next to the bridge's own, the bridge's headers object is never mutated, a batch merges in queue order, and an untouched command keeps `request` undefined.
 * See: log s35.139.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAsyncCommandBus } from '../src/command-bus';
import { httpTransport } from '../src/transports';

const sent: Record<string, string>[] = [];
const reply = (body: unknown) => ({ ok: true, status: 200, url: '', redirected: false, headers: { entries: () => [['content-type', 'application/json']], get: () => 'application/json' }, text: async () => JSON.stringify(body) });
const stubFetch = () => vi.stubGlobal('fetch', vi.fn(async (_u: string, init: RequestInit) => {
  sent.push(init.headers as Record<string, string>);
  const body = JSON.parse(init.body as string);
  return reply(body.commands ? { results: body.commands.map((c: { id: string }) => ({ id: c.id, state: 1 })) } : { state: 1 });
}));
afterEach(() => { vi.unstubAllGlobals(); sent.length = 0; });

const trace = (bus: ReturnType<typeof createAsyncCommandBus>) =>
  bus.use({ started: (cmd) => { cmd.meta!.request = { headers: { traceparent: `00-${cmd.meta!.id}` } }; } });

describe('meta.request', () => {
  it('a bus plugin puts a header on the request httpTransport sends', async () => {
    stubFetch();
    const bus = createAsyncCommandBus({ retry: false, transport: httpTransport({ endpoint: '/vc', headers: { 'x-app': '1' } }) });
    trace(bus);
    await bus.dispatch('a', 1);
    expect(sent[0]!['x-app']).toBe('1');
    expect(sent[0]!.traceparent).toMatch(/^00-/);
  });

  it("never writes into the bridge's own headers", async () => {
    stubFetch();
    const headers = { 'x-app': '1' };
    const bus = createAsyncCommandBus({ retry: false, transport: httpTransport({ endpoint: '/vc', headers }) });
    trace(bus);
    await bus.dispatch('a', 1);
    await bus.dispatch('b', 2);
    expect(headers).toEqual({ 'x-app': '1' });
    expect(sent[0]!.traceparent).not.toBe(sent[1]!.traceparent);
  });

  it('a batch merges its commands\' headers in queue order, the later winning', async () => {
    stubFetch();
    const bus = createAsyncCommandBus({ retry: false, transport: httpTransport({ endpoint: '/vc', batch: {} }) });
    bus.use({ started: (cmd) => { cmd.meta!.request = { headers: { 'x-from': cmd.action, [`x-${cmd.action}`]: '1' } }; } });
    await Promise.all([bus.dispatch('a', 1), bus.dispatch('b', 2)]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ 'x-from': 'b', 'x-a': '1', 'x-b': '1' });
  });

  it('a command no plugin touched keeps the slot undefined and sends the bridge headers only', async () => {
    stubFetch();
    const bus = createAsyncCommandBus({ retry: false, transport: httpTransport({ endpoint: '/vc', headers: { 'x-app': '1' } }) });
    let meta: any;
    bus.on('*', (cmd) => { meta = cmd.meta; });
    await bus.dispatch('a', 1);
    expect('request' in meta).toBe(true);
    expect(meta.request).toBeUndefined();
    expect(sent[0]!.traceparent).toBeUndefined();
  });
});
