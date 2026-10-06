/** A store applies a bridged action's answer, opt-in, through `RegisterOptions.answer` (plan 1.27 D3). Rationale at the end. */
import { describe, expect, it, vi } from 'vitest';
import { type Command, createAsyncCommandBus } from '../src/command-bus';
import { history } from '../src/plugins-core';
import { persist } from '../src/plugins-io';
import { defineChamberStore } from '../src/store';
import { createBatchingHttpBridge, createHttpBridge } from '../src/transports';

type List = { items: string[] };
const reducers = { add: (s: List, item: string) => ({ items: [...s.items, item] }) };
const serverState = (item: string): List => ({ items: [`server:${item}`] });

/** An http client whose post answers `{ state }` for one command, or fails with 500. */
const client = (status = 200) => ({
  post: vi.fn(async (_url: string, body: { target: string }) =>
    status === 200
      ? { ok: true, status, data: { state: serverState(body.target) }, headers: {} }
      : { ok: false, status, data: { title: 'down' }, headers: {} }),
});
const memoryStorage = () => {
  let stored: string | null = null;
  return { getItem: () => stored, setItem: (_k: string, v: string) => { stored = v; }, removeItem: () => { stored = null; }, read: () => stored };
};

describe('a store with `answer` takes a bridged action answer as its state', () => {
  it('createHttpBridge: the state is the answer, and so is the result', async () => {
    const bus = createAsyncCommandBus({ retry: false });
    bus.use(createHttpBridge({ endpoint: '/vc', httpClient: client() as never }));
    const cart = defineChamberStore('cart', { state: (): List => ({ items: [] }), reducers, answer: (_s, answer) => answer as List })(bus);
    const r = await cart.add('milk');
    expect(cart.state.value).toEqual(serverState('milk'));
    expect(r.value).toEqual(serverState('milk'));
    cart.$dispose();
  });

  it('createBatchingHttpBridge: each answer lands in the store', async () => {
    const post = vi.fn(async (_url: string, body: { commands: Array<{ id: string; target: string }> }) =>
      ({ ok: true, status: 200, data: { results: body.commands.map((c) => ({ id: c.id, state: serverState(c.target) })) }, headers: {} }));
    const bus = createAsyncCommandBus({ retry: false });
    bus.use(createBatchingHttpBridge({ endpoint: '/vc', httpClient: { post } as never }));
    const cart = defineChamberStore('cart', { state: (): List => ({ items: [] }), reducers, answer: (_s, answer) => answer as List })(bus);
    await cart.add('tea');
    expect(cart.state.value).toEqual(serverState('tea'));
    cart.$dispose();
  });

  it('persist outside the bridge saves the answered state', async () => {
    const storage = memoryStorage();
    const bus = createAsyncCommandBus({ retry: false });
    const cart = defineChamberStore('cart', { state: (): List => ({ items: [] }), reducers, answer: (_s, answer) => answer as List })(bus);
    bus.use(persist({ key: 'vc:cart', storage, getState: () => cart.state.value }), { priority: 10 });
    bus.use(createHttpBridge({ endpoint: '/vc', httpClient: client() as never }));
    await cart.add('milk');
    expect(JSON.parse(storage.read() as string)).toEqual(serverState('milk'));
    cart.$dispose();
  });

  it('a rollback rebase keeps the state the server answered, never re-running the reducer', async () => {
    const bus = createAsyncCommandBus({ retry: false });
    let localRuns = 0;
    const cart = defineChamberStore('cart', {
      state: (): List => ({ items: [] }),
      reducers: { add: (s: List, item: string) => { localRuns++; return { items: [...s.items, item] }; }, save: (s: List) => s },
      answer: (_s, answer) => answer as List,
      undo: true,
    })(bus);
    bus.use(createHttpBridge({ endpoint: '/vc', httpClient: client() as never, actions: ['cartSave'] }));
    let first: Command | undefined;
    bus.on('cartAdd', (cmd) => { first ??= cmd; });
    await cart.add('a');
    await cart.save('x');
    const runs = localRuns;
    await bus.dispatch('cartAdd$undo', first);
    expect(cart.state.value).toEqual(serverState('x'));
    expect(localRuns).toBe(runs);
    cart.$dispose();
  });
});

describe('RegisterOptions.answer', () => {
  it('is called with the command and the answer; the handler does not run', async () => {
    const bus = createAsyncCommandBus({ retry: false });
    const handler = vi.fn(async () => 'local');
    const answer = vi.fn();
    bus.register('docSave', handler, { answer });
    bus.use(createHttpBridge({ endpoint: '/vc', httpClient: client() as never }));
    await bus.dispatch('docSave', 'd1');
    expect(handler).not.toHaveBeenCalled();
    expect(answer).toHaveBeenCalledWith(expect.objectContaining({ action: 'docSave', target: 'd1' }), serverState('d1'));
  });

  it('a throwing answer fails the dispatch with its error', async () => {
    const bus = createAsyncCommandBus({ retry: false });
    bus.register('docSave', async () => 'local', { answer: () => { throw new Error('cannot apply'); } });
    bus.use(createHttpBridge({ endpoint: '/vc', httpClient: client() as never }));
    const r = await bus.dispatch('docSave', 'd1');
    expect(r.ok).toBe(false);
    expect(r.error?.message).toBe('cannot apply');
  });
});

describe('controls', () => {
  it('a store without `answer` stays as released when a bridge answers', async () => {
    const bus = createAsyncCommandBus({ retry: false });
    bus.use(createHttpBridge({ endpoint: '/vc', httpClient: client() as never }));
    const cart = defineChamberStore('cart', { state: (): List => ({ items: [] }), reducers })(bus);
    const r = await cart.add('milk');
    expect([r.value, cart.state.value]).toEqual([serverState('milk'), { items: [] }]);
    cart.$dispose();
  });

  it('a local action runs its reducer and never calls `answer`', async () => {
    const bus = createAsyncCommandBus({ retry: false });
    const answer = vi.fn((_s: List, a: unknown) => a as List);
    const cart = defineChamberStore('cart', { state: (): List => ({ items: [] }), reducers, answer })(bus);
    await cart.add('milk');
    expect(cart.state.value).toEqual({ items: ['milk'] });
    expect(answer).not.toHaveBeenCalled();
    cart.$dispose();
  });

  it('a failed bridged action writes nothing', async () => {
    const bus = createAsyncCommandBus({ retry: false });
    const answer = vi.fn((_s: List, a: unknown) => a as List);
    bus.use(createHttpBridge({ endpoint: '/vc', httpClient: client(500) as never }));
    const cart = defineChamberStore('cart', { state: (): List => ({ items: [] }), reducers, answer })(bus);
    const r = await cart.add('milk');
    expect(r.ok).toBe(false);
    expect(answer).not.toHaveBeenCalled();
    expect(cart.state.value).toEqual({ items: [] });
    cart.$dispose();
  });

  it('history cannot undo the answered step: only the server reverses it (item 1 R9)', async () => {
    const bus = createAsyncCommandBus({ retry: false });
    const h = history({ bus });
    bus.use(h);
    bus.use(createHttpBridge({ endpoint: '/vc', httpClient: client() as never }));
    const cart = defineChamberStore('cart', { state: (): List => ({ items: [] }), reducers, answer: (_s, a) => a as List, undo: true })(bus);
    await cart.add('milk');
    expect(h.getState().canUndo).toBe(false);
    expect(h.getState().past).toHaveLength(1);
    cart.$dispose();
  });
});

/*
 * A bridge replaces the handler of the actions it forwards, so a store's
 * reducer never ran for them and the store never changed, though the dispatch
 * was `ok` with the server's state as its value (probe p-d3, plan entry D3).
 * TanStack Query, Apollo and Pinia Colada all write a mutation's answer into
 * local state through code the app declares. The store's `answer` is that
 * code, opt-in. The bus calls `RegisterOptions.answer` at the transport's
 * level, inside the chain, so a plugin outside the bridge (persist) sees the
 * written state. The write is a step of the same command: history records it
 * once and cannot undo it (R9), and a rollback rebase keeps the server's
 * state as it keeps a tab's `$sync`. Log s35.184.
 */
