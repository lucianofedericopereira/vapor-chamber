/** `meta.request`: request-level headers a plugin adds, sent by the HTTP bridges (log s35.139). */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAsyncCommandBus } from '../src/command-bus';
import { createBatchingHttpBridge, createHttpBridge } from '../src/transports';

const sent: Record<string, string>[] = [];
const reply = (body: unknown) => ({ ok: true, status: 200, url: '', redirected: false, headers: { entries: () => [['content-type', 'application/json']], get: () => 'application/json' }, text: async () => JSON.stringify(body) });
const stubFetch = () => vi.stubGlobal('fetch', vi.fn(async (_u: string, init: RequestInit) => {
  sent.push(init.headers as Record<string, string>);
  const body = JSON.parse(init.body as string);
  return reply(body.commands ? { results: body.commands.map((c: { id: string }) => ({ id: c.id, state: 1 })) } : { state: 1 });
}));
afterEach(() => { vi.unstubAllGlobals(); sent.length = 0; });

// A tracing plugin, as an app writes it: an ordinary bus plugin.
const trace = (bus: ReturnType<typeof createAsyncCommandBus>) =>
  bus.use((cmd, next) => { cmd.meta!.request = { headers: { traceparent: `00-${cmd.meta!.id}` } }; return next(); });

describe('meta.request', () => {
  it('a bus plugin puts a header on the request createHttpBridge sends', async () => {
    stubFetch();
    const bus = createAsyncCommandBus({ retry: false });
    trace(bus);
    bus.use(createHttpBridge({ endpoint: '/vc', headers: { 'x-app': '1' } }));
    await bus.dispatch('a', 1);
    expect(sent[0]!['x-app']).toBe('1');
    expect(sent[0]!.traceparent).toMatch(/^00-/);
  });

  it("never writes into the bridge's own headers", async () => {
    stubFetch();
    const headers = { 'x-app': '1' };
    const bus = createAsyncCommandBus({ retry: false });
    trace(bus);
    bus.use(createHttpBridge({ endpoint: '/vc', headers }));
    await bus.dispatch('a', 1);
    await bus.dispatch('b', 2);
    expect(headers).toEqual({ 'x-app': '1' });
    expect(sent[0]!.traceparent).not.toBe(sent[1]!.traceparent);
  });

  it('a batch merges its commands\' headers in queue order, the later winning', async () => {
    stubFetch();
    const bus = createAsyncCommandBus({ retry: false });
    bus.use((cmd, next) => { cmd.meta!.request = { headers: { 'x-from': cmd.action, [`x-${cmd.action}`]: '1' } }; return next(); });
    bus.use(createBatchingHttpBridge({ endpoint: '/vc' }));
    await Promise.all([bus.dispatch('a', 1), bus.dispatch('b', 2)]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ 'x-from': 'b', 'x-a': '1', 'x-b': '1' });
  });

  it('a command no plugin touched keeps the slot undefined and sends the bridge headers only', async () => {
    stubFetch();
    const bus = createAsyncCommandBus({ retry: false });
    let meta: any;
    bus.on('*', (cmd) => { meta = cmd.meta; });
    bus.use(createHttpBridge({ endpoint: '/vc', headers: { 'x-app': '1' } }));
    await bus.dispatch('a', 1);
    expect('request' in meta).toBe(true);
    expect(meta.request).toBeUndefined();
    expect(sent[0]!.traceparent).toBeUndefined();
  });
});
