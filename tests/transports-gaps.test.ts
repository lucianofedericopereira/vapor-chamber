/**
 * Supplemental coverage for src/transports.ts.
 *
 * Targets what transports.test.ts / transports-coverage.test.ts leave untouched:
 *
 *  - HTTP bridge error re-wrap keeping `status` AND `code` (222-223)
 *  - `csrf: 'inertia'` → csrfFlag false on both HTTP bridges (150, 288)
 *  - signal + scopeController merge via AbortSignal.any, and the per-dispatch
 *    `cmd.signal` merge (152-156, 174-178, 289-291)
 *  - batching bridge: idempotency key forwarding (316), a response with no
 *    `results` array (336), pre-flight abort (360)
 *  - WS bridge: connect() with no WebSocket global (531), pre-flight abort (614)
 *
 * The two pre-flight abort guards are only reachable by invoking the plugin
 * directly: `bus.dispatch` short-circuits an already-aborted signal before the
 * pipeline runs, so the guard exists for standalone/plugin-composed use.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Command, CommandResult } from '../src/index';
import { createAsyncCommandBus } from '../src/index';
import { createHttpBridge, createBatchingHttpBridge, createWsBridge } from '../src/transports';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** Invoke a transport plugin without a bus (bus.dispatch pre-empts aborts). */
function callPlugin(plugin: any, cmd: Partial<Command>): Promise<CommandResult> {
  const full = { action: 'x', target: {}, payload: undefined, meta: {}, ...cmd } as Command;
  return Promise.resolve(plugin(full, () => ({ ok: true, value: 'next' }) as CommandResult));
}

// ---------------------------------------------------------------------------
// createHttpBridge — error re-wrap detail
// ---------------------------------------------------------------------------

describe('createHttpBridge error re-wrap', () => {
  it('carries status, code and response through the rewrapped error (220-225)', async () => {
    const thrown = Object.assign(new Error('HTTP 422'), {
      name: 'HttpError',
      status: 422,
      code: 'VALIDATION',
      response: { data: { error: 'email is taken' } },
    });
    const httpClient = { post: vi.fn().mockRejectedValue(thrown) } as any;

    const bus = createAsyncCommandBus();
    bus.use(createHttpBridge({ endpoint: '/api/vc', httpClient }));

    const result = await bus.dispatch('save', {});
    const err = result.error as Error & { status?: number; code?: string; response?: unknown };
    expect(result.ok).toBe(false);
    expect(err.message).toBe('email is taken');
    expect(err.name).toBe('HttpError');
    expect(err.status).toBe(422);
    expect(err.code).toBe('VALIDATION');
    expect(err.response).toBe(thrown.response);
    expect((err as any).cause).toBe(thrown);
  });

  it('passes the raw error through when the body has no error/message (227)', async () => {
    const thrown = Object.assign(new Error('network down'), { response: { data: {} } });
    const httpClient = { post: vi.fn().mockRejectedValue(thrown) } as any;

    const bus = createAsyncCommandBus();
    bus.use(createHttpBridge({ endpoint: '/api/vc', httpClient }));

    const result = await bus.dispatch('save', {});
    expect(result.error).toBe(thrown);
  });
});

// ---------------------------------------------------------------------------
// csrf: 'inertia' + signal merging
// ---------------------------------------------------------------------------

describe('csrf: inertia and signal merging', () => {
  it('sends csrf:false for csrf:"inertia" on the HTTP bridge (150)', async () => {
    const httpClient = { post: vi.fn().mockResolvedValue({ ok: true, status: 200, headers: {}, data: { ok: true, state: 1 } }) } as any;
    const bus = createAsyncCommandBus();
    bus.use(createHttpBridge({ endpoint: '/api/vc', csrf: 'inertia', httpClient }));

    await bus.dispatch('save', {});
    expect(httpClient.post.mock.calls[0]![2].csrf).toBe(false);
  });

  it('sends csrf:false for csrf:"inertia" on the batching bridge (288)', async () => {
    const httpClient = { post: vi.fn().mockResolvedValue({ ok: true, status: 200, headers: {}, data: { results: [] } }) } as any;
    const bus = createAsyncCommandBus();
    bus.use(createBatchingHttpBridge({ endpoint: '/api/vc/batch', csrf: 'inertia', httpClient }));

    await bus.dispatch('save', {});
    expect(httpClient.post.mock.calls[0]![2].csrf).toBe(false);
  });

  it('merges scopeController with the bridge signal (152-156)', async () => {
    const httpClient = { post: vi.fn().mockResolvedValue({ ok: true, status: 200, headers: {}, data: { ok: true } }) } as any;
    const user = new AbortController();
    const scope = new AbortController();
    const bus = createAsyncCommandBus();
    bus.use(createHttpBridge({ endpoint: '/api/vc', signal: user.signal, scopeController: scope, httpClient }));

    await bus.dispatch('save', {});
    const sent: AbortSignal = httpClient.post.mock.calls[0]![2].signal;
    expect(sent.aborted).toBe(false);
    // Either source aborting must trip the merged signal.
    scope.abort();
    expect(sent.aborted).toBe(true);
  });

  it('merges the per-dispatch signal with the bridge signal (174-178)', async () => {
    const httpClient = { post: vi.fn().mockResolvedValue({ ok: true, status: 200, headers: {}, data: { ok: true } }) } as any;
    const bridgeAc = new AbortController();
    const callAc = new AbortController();
    const bus = createAsyncCommandBus();
    bus.use(createHttpBridge({ endpoint: '/api/vc', signal: bridgeAc.signal, httpClient }));

    await bus.dispatch('save', {}, undefined, { signal: callAc.signal });
    const sent: AbortSignal = httpClient.post.mock.calls[0]![2].signal;
    expect(sent.aborted).toBe(false);
    callAc.abort();
    expect(sent.aborted).toBe(true);
  });

  it('merges scopeController with the bridge signal on the batching bridge (289-291)', async () => {
    const httpClient = { post: vi.fn().mockResolvedValue({ ok: true, status: 200, headers: {}, data: { results: [] } }) } as any;
    const user = new AbortController();
    const scope = new AbortController();
    const bus = createAsyncCommandBus();
    bus.use(createBatchingHttpBridge({ endpoint: '/api/vc/batch', signal: user.signal, scopeController: scope, httpClient }));

    await bus.dispatch('save', {});
    const sent: AbortSignal = httpClient.post.mock.calls[0]![2].signal;
    expect(sent.aborted).toBe(false);
    user.abort();
    expect(sent.aborted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// createBatchingHttpBridge
// ---------------------------------------------------------------------------

describe('createBatchingHttpBridge', () => {
  it('forwards a stamped idempotency key per batched command (316)', async () => {
    const httpClient = {
      post: vi.fn().mockImplementation((_url, body: any) => Promise.resolve({
        ok: true,
        status: 200,
        headers: {},
        data: { results: body.commands.map((c: any) => ({ id: c.id, ok: true, state: c.command })) },
      })),
    } as any;

    const bus = createAsyncCommandBus();
    // Stamp meta ahead of the transport, the way `idempotent` does.
    bus.use((cmd, next) => {
      if (cmd.meta && cmd.action === 'pay') cmd.meta.idempotencyKey = 'key-1';
      return next();
    }, { priority: 100 });
    bus.use(createBatchingHttpBridge({ endpoint: '/api/vc/batch', httpClient }));

    const [pay, look] = await Promise.all([bus.dispatch('pay', {}), bus.dispatch('look', {})]);
    expect(pay.ok).toBe(true);
    expect(look.ok).toBe(true);

    const commands = httpClient.post.mock.calls[0]![1].commands;
    expect(commands).toHaveLength(2);
    expect(commands.find((c: any) => c.command === 'pay').idempotencyKey).toBe('key-1');
    expect(commands.find((c: any) => c.command === 'look').idempotencyKey).toBeUndefined();
  });

  it('fails every entry when the response carries no results array (336, 339-340)', async () => {
    const httpClient = { post: vi.fn().mockResolvedValue({ ok: true, status: 200, headers: {}, data: {} }) } as any;
    const bus = createAsyncCommandBus();
    bus.use(createBatchingHttpBridge({ endpoint: '/api/vc/batch', httpClient }));

    const result = await bus.dispatch('save', {});
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain('missing a result');
    expect(result.error?.message).toContain('save');
  });

  it('returns an aborted result without queueing when cmd.signal is already tripped (360)', async () => {
    const httpClient = { post: vi.fn() } as any;
    const ac = new AbortController();
    ac.abort();

    const plugin = createBatchingHttpBridge({ endpoint: '/api/vc/batch', httpClient });
    const result = await callPlugin(plugin, { action: 'save', signal: ac.signal });

    expect(result.ok).toBe(false);
    expect(httpClient.post).not.toHaveBeenCalled();
  });

  it('passes non-matching actions straight to next() (359)', async () => {
    const httpClient = { post: vi.fn() } as any;
    const plugin = createBatchingHttpBridge({ endpoint: '/api/vc/batch', actions: ['cart*'], httpClient });

    const result = await callPlugin(plugin, { action: 'unrelated' });
    expect(result).toEqual({ ok: true, value: 'next' });
    expect(httpClient.post).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// createWsBridge
// ---------------------------------------------------------------------------

describe('createWsBridge guards', () => {
  it('connect() is a no-op when WebSocket is undefined (531)', () => {
    vi.stubGlobal('WebSocket', undefined);
    const ws = createWsBridge({ url: 'ws://localhost' });
    expect(() => ws.connect()).not.toThrow();
    expect(ws.isConnected()).toBe(false);
    expect(ws.connected.value).toBe(false);
  });

  it('returns an aborted result without opening a socket when cmd.signal is tripped (614)', async () => {
    const ctor = vi.fn();
    vi.stubGlobal('WebSocket', ctor);
    const ac = new AbortController();
    ac.abort();

    const ws = createWsBridge({ url: 'ws://localhost' });
    const result = await callPlugin(ws, { action: 'save', signal: ac.signal });

    expect(result.ok).toBe(false);
    expect(ctor).not.toHaveBeenCalled();
  });
});
