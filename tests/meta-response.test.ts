/** `meta.response`: the Fetch response that answered a bridged command (log s35.136). */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAsyncCommandBus } from '../src/command-bus';
import { createBatchingHttpBridge, createHttpBridge } from '../src/transports';

const reply = (status: number, body: unknown, headers: Record<string, string> = {}) => {
  const h: Record<string, string> = { 'content-type': 'application/json', ...headers };
  return { ok: status < 300, status, url: 'https://api.test/vc', redirected: true, headers: { entries: () => Object.entries(h), get: (k: string) => h[k.toLowerCase()] ?? null }, text: async () => JSON.stringify(body) };
};
afterEach(() => { vi.unstubAllGlobals(); });

describe('meta.response', () => {
  it('a bridged reply fills it: status, lowercase headers, url, redirected', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply(202, {}, { Location: '/jobs/7', 'Retry-After': '3' })));
    const bus = createAsyncCommandBus({ retry: false });
    bus.use(createHttpBridge({ endpoint: '/vc' }));
    let meta: any;
    bus.on('*', (cmd) => { meta = cmd.meta; });
    expect((await bus.dispatch('orderExport', {})).ok).toBe(true);
    expect(meta.response).toEqual({ status: 202, headers: { 'content-type': 'application/json', location: '/jobs/7', 'retry-after': '3' }, url: 'https://api.test/vc', redirected: true });
  });

  it('a command a local handler answers keeps it undefined', async () => {
    const bus = createAsyncCommandBus();
    let meta: any;
    bus.register('local', async (cmd) => { meta = cmd.meta; return 1; });
    await bus.dispatch('local', 1);
    expect('response' in meta).toBe(true);
    expect(meta.response).toBeUndefined();
  });

  it('every command of a batch holds the one response that answered it', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: RequestInit) => reply(200, { results: JSON.parse(init.body as string).commands.map((c: { id: string }) => ({ id: c.id, state: 1 })) })));
    const bus = createAsyncCommandBus({ retry: false });
    bus.use(createBatchingHttpBridge({ endpoint: '/vc' }));
    const metas: any[] = [];
    bus.on('*', (cmd) => { metas.push(cmd.meta); });
    await Promise.all([bus.dispatch('a', 1), bus.dispatch('b', 2)]);
    expect(metas).toHaveLength(2);
    expect(metas[0].response.status).toBe(200);
    expect(metas[1].response).toBe(metas[0].response);
  });

  it('an answered failure keeps its answer in the error, not in meta', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply(409, { status: 409, code: 'stale' })));
    const bus = createAsyncCommandBus({ retry: false });
    bus.use(createHttpBridge({ endpoint: '/vc' }));
    let meta: any;
    bus.on('*', (cmd) => { meta = cmd.meta; });
    const r = await bus.dispatch('orderSave', {});
    expect((r.error as any).context.status).toBe(409);
    expect(meta.response).toBeUndefined();
  });

  it("a custom client's response without headers fills headers as empty", async () => {
    const bus = createAsyncCommandBus({ retry: false });
    bus.use(createHttpBridge({ endpoint: '/vc', httpClient: { post: async () => ({ ok: true, status: 200, data: { state: 1 } }) } as never }));
    let meta: any;
    bus.on('*', (cmd) => { meta = cmd.meta; });
    await bus.dispatch('a', 1);
    expect(meta.response).toEqual({ status: 200, headers: {}, url: undefined, redirected: undefined });
  });

  it('a bridge called outside a bus, on a command with no meta, still answers', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      return reply(200, body.commands ? { results: body.commands.map((c: { id: string }) => ({ id: c.id, state: 1 })) } : { state: 1 });
    }));
    const next = async () => ({ ok: true, value: 0 }) as never;
    expect(await createHttpBridge({ endpoint: '/vc' })({ action: 'a', target: 1 } as never, next, undefined as never)).toMatchObject({ ok: true, value: 1 });
    expect(await createBatchingHttpBridge({ endpoint: '/vc' })({ action: 'a', target: 1 } as never, next, undefined as never)).toMatchObject({ ok: true, value: 1 });
  });
});
