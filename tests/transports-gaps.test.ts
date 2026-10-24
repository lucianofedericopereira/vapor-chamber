
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Command, CommandResult } from '../src/index';
import { createAsyncCommandBus } from '../src/index';
import type { Transport } from '../src/command-bus';
import { httpTransport, wsTransport } from '../src/transports';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** Call a transport's send without a bus (bus.dispatch pre-empts aborts). */
function callSend(transport: Transport, cmd: Partial<Command>): Promise<CommandResult> {
  const full = { action: 'x', target: {}, payload: undefined, meta: {}, ...cmd } as Command;
  return Promise.resolve(transport.send(full, async () => ({ ok: true, value: 'local' }) as CommandResult));
}

// ---------------------------------------------------------------------------
// csrf forwarding + signal merging ('inertia' removed, log s35.124)
// ---------------------------------------------------------------------------

describe('csrf forwarding and signal merging', () => {
  it('passes csrf through to the client, with and without batch', async () => {
    for (const [batch, data] of [[undefined, { state: 1 }], [{}, { results: [] }]] as const) {
      const httpClient = { post: vi.fn().mockResolvedValue({ ok: true, status: 200, headers: {}, data }) } as any;
      const bus = createAsyncCommandBus({ transport: httpTransport({ endpoint: '/api/vc', csrf: true, httpClient, batch }) });
      await bus.dispatch('save', {});
      expect(httpClient.post.mock.calls[0]![2].csrf).toBe(true);
    }
  });

  it('merges scopeController with the transport signal', async () => {
    const httpClient = { post: vi.fn().mockResolvedValue({ ok: true, status: 200, headers: {}, data: { ok: true } }) } as any;
    const user = new AbortController();
    const scope = new AbortController();
    const bus = createAsyncCommandBus({ transport: httpTransport({ endpoint: '/api/vc', signal: user.signal, scopeController: scope, httpClient }) });

    await bus.dispatch('save', {});
    const sent: AbortSignal = httpClient.post.mock.calls[0]![2].signal;
    expect(sent.aborted).toBe(false);
    // Either source aborting must trip the merged signal.
    scope.abort();
    expect(sent.aborted).toBe(true);
  });

  it('merges the per-dispatch signal with the transport signal', async () => {
    const httpClient = { post: vi.fn().mockResolvedValue({ ok: true, status: 200, headers: {}, data: { ok: true } }) } as any;
    const bridgeAc = new AbortController();
    const callAc = new AbortController();
    const bus = createAsyncCommandBus({ transport: httpTransport({ endpoint: '/api/vc', signal: bridgeAc.signal, httpClient }) });

    await bus.dispatch('save', {}, undefined, { signal: callAc.signal });
    const sent: AbortSignal = httpClient.post.mock.calls[0]![2].signal;
    expect(sent.aborted).toBe(false);
    callAc.abort();
    expect(sent.aborted).toBe(true);
  });

  it('merges scopeController with the transport signal, with batch', async () => {
    const httpClient = { post: vi.fn().mockResolvedValue({ ok: true, status: 200, headers: {}, data: { results: [] } }) } as any;
    const user = new AbortController();
    const scope = new AbortController();
    const bus = createAsyncCommandBus({ transport: httpTransport({ endpoint: '/api/vc/batch', signal: user.signal, scopeController: scope, httpClient, batch: {} }) });

    await bus.dispatch('save', {});
    const sent: AbortSignal = httpClient.post.mock.calls[0]![2].signal;
    expect(sent.aborted).toBe(false);
    user.abort();
    expect(sent.aborted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// httpTransport with batch
// ---------------------------------------------------------------------------

describe('httpTransport with batch', () => {
  it('forwards a stamped idempotency key per batched command', async () => {
    const httpClient = {
      post: vi.fn().mockImplementation((_url, body: any) => Promise.resolve({
        ok: true,
        status: 200,
        headers: {},
        data: { results: body.commands.map((c: any) => ({ id: c.id, ok: true, state: c.command })) },
      })),
    } as any;

    const bus = createAsyncCommandBus({ transport: httpTransport({ endpoint: '/api/vc/batch', httpClient, batch: {} }) });
    // Stamp meta ahead of the transport, the way `idempotent` does.
    bus.use({ started: (cmd) => { if (cmd.meta && cmd.action === 'pay') cmd.meta.idempotencyKey = 'key-1'; } });

    const [pay, look] = await Promise.all([bus.dispatch('pay', {}), bus.dispatch('look', {})]);
    expect(pay.ok).toBe(true);
    expect(look.ok).toBe(true);

    const commands = httpClient.post.mock.calls[0]![1].commands;
    expect(commands).toHaveLength(2);
    expect(commands.find((c: any) => c.command === 'pay').headers).toEqual({ 'Idempotency-Key': '"key-1"' });
    expect(commands.find((c: any) => c.command === 'look').headers).toBeUndefined();
  });

  it('fails every entry when the response carries no results array', async () => {
    const httpClient = { post: vi.fn().mockResolvedValue({ ok: true, status: 200, headers: {}, data: {} }) } as any;
    const bus = createAsyncCommandBus({ transport: httpTransport({ endpoint: '/api/vc/batch', httpClient, batch: {} }) });

    const result = await bus.dispatch('save', {});
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain('missing a result');
    expect(result.error?.message).toContain('save');
  });

  it('returns an aborted result without queueing when cmd.signal is already tripped', async () => {
    const httpClient = { post: vi.fn() } as any;
    const ac = new AbortController();
    ac.abort();

    const transport = httpTransport({ endpoint: '/api/vc/batch', httpClient, batch: {} });
    const result = await callSend(transport, { action: 'save', signal: ac.signal });

    expect(result).toFailWith('core:aborted:dispatch');
    expect(httpClient.post).not.toHaveBeenCalled();
  });

  it('covers its pattern only: the bus never sends another action', async () => {
    const httpClient = { post: vi.fn() } as any;
    const bus = createAsyncCommandBus({ transport: { 'cart*': httpTransport({ endpoint: '/api/vc/batch', httpClient, batch: {} }) } });
    bus.register('unrelated', async () => 'local');
    expect((await bus.dispatch('unrelated', 0)).value).toBe('local');
    expect(httpClient.post).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// wsTransport
// ---------------------------------------------------------------------------

describe('wsTransport guards', () => {
  it('connect() is a no-op when WebSocket is undefined', () => {
    vi.stubGlobal('WebSocket', undefined);
    const ws = wsTransport({ url: 'ws://localhost' });
    expect(() => ws.connect()).not.toThrow();
    expect(ws.isConnected()).toBe(false);
    expect(ws.connected.value).toBe(false);
  });

  it('returns an aborted result without opening a socket when cmd.signal is tripped', async () => {
    const ctor = vi.fn();
    vi.stubGlobal('WebSocket', ctor);
    const ac = new AbortController();
    ac.abort();

    const ws = wsTransport({ url: 'ws://localhost' });
    const result = await callSend(ws, { action: 'save', signal: ac.signal });

    expect(result).toFailWith('core:aborted:dispatch');
    expect(ctor).not.toHaveBeenCalled();
  });
});
