/** A store orders server answers by the version the server sends; an answer with no state writes nothing (plan 1.27 D3, rev 2). Rationale at the end. */
import { describe, expect, it, vi } from 'vitest';
import { createAsyncCommandBus } from '../src/command-bus';
import { defineChamberStore } from '../src/store';
import { createHttpBridge } from '../src/transports';

type Cart = { rev: number; items: string[] };
const reducers = { add: (s: Cart, item: string) => ({ ...s, items: [...s.items, item] }) };

/**
 * A client whose replies the test releases by hand, in any order. Each reply
 * carries the state the server reached for that request: `server[item]`.
 */
function heldClient(server: Record<string, Cart | undefined>) {
  const held = new Map<string, () => void>();
  const post = vi.fn((_url: string, body: { target: string }) =>
    new Promise((resolve) => {
      held.set(body.target, () => resolve({ ok: true, status: 200, data: server[body.target] === undefined ? {} : { state: server[body.target] }, headers: {} }));
    }));
  return { client: { post } as never, release: (item: string) => held.get(item)!() };
}
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const make = (bus: ReturnType<typeof createAsyncCommandBus>, version?: (s: Cart) => number) =>
  defineChamberStore('cart', { state: (): Cart => ({ rev: 0, items: [] }), reducers, answer: (_s, v) => v as Cart, version })(bus);

describe('version orders the answers, as the server applied the writes', () => {
  it('an older answer that arrives last never replaces a newer one', async () => {
    // The server applied milk first (rev 1), then eggs (rev 2); milk's reply arrives last.
    const { client, release } = heldClient({ milk: { rev: 1, items: ['milk'] }, eggs: { rev: 2, items: ['milk', 'eggs'] } });
    const bus = createAsyncCommandBus({ retry: false });
    bus.use(createHttpBridge({ endpoint: '/vc', httpClient: client }));
    const cart = make(bus, (s) => s.rev);
    const a = cart.add('milk');
    const b = cart.add('eggs');
    await settle();
    release('eggs');
    await b;
    release('milk');
    const r = await a;
    expect(cart.state.value).toEqual({ rev: 2, items: ['milk', 'eggs'] });
    expect(r.ok).toBe(true);
    cart.$dispose();
  });

  it('control: without version the last reply to arrive wins', async () => {
    const { client, release } = heldClient({ milk: { rev: 1, items: ['milk'] }, eggs: { rev: 2, items: ['milk', 'eggs'] } });
    const bus = createAsyncCommandBus({ retry: false });
    bus.use(createHttpBridge({ endpoint: '/vc', httpClient: client }));
    const cart = make(bus);
    const a = cart.add('milk');
    const b = cart.add('eggs');
    await settle();
    release('eggs');
    await b;
    release('milk');
    await a;
    expect(cart.state.value).toEqual({ rev: 1, items: ['milk'] });
    cart.$dispose();
  });

  it('control: a newer answer that arrives last is applied', async () => {
    // The server applied eggs first (rev 1), then milk (rev 2); milk's reply arrives last.
    const { client, release } = heldClient({ eggs: { rev: 1, items: ['eggs'] }, milk: { rev: 2, items: ['eggs', 'milk'] } });
    const bus = createAsyncCommandBus({ retry: false });
    bus.use(createHttpBridge({ endpoint: '/vc', httpClient: client }));
    const cart = make(bus, (s) => s.rev);
    const a = cart.add('milk');
    const b = cart.add('eggs');
    await settle();
    release('eggs');
    await b;
    release('milk');
    await a;
    expect(cart.state.value).toEqual({ rev: 2, items: ['eggs', 'milk'] });
    cart.$dispose();
  });

  it('an equal version is not newer; a version that is not a number falls back to arrival order', async () => {
    const { client, release } = heldClient({ a: { rev: 0, items: ['a'] }, b: { rev: Number.NaN, items: ['b'] }, c: { rev: Number.NaN, items: ['b', 'c'] } });
    const bus = createAsyncCommandBus({ retry: false });
    bus.use(createHttpBridge({ endpoint: '/vc', httpClient: client }));
    const cart = make(bus, (s) => s.rev);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const a = cart.add('a');
    await settle();
    release('a');
    await a;
    expect(cart.state.value).toEqual({ rev: 0, items: [] });
    const b = cart.add('b');
    await settle();
    release('b');
    await b;
    expect(cart.state.value.items).toEqual(['b']);
    const c = cart.add('c');
    await settle();
    release('c');
    await c;
    expect(cart.state.value.items).toEqual(['b', 'c']);
    expect(warn).toHaveBeenCalledTimes(1); // once per store
    expect(String(warn.mock.calls[0]![0])).toContain('version');
    cart.$dispose();
  });
});

describe('an answer with no state writes nothing', () => {
  it('the store keeps its state and `answer` is not called', async () => {
    const { client, release } = heldClient({ milk: undefined });
    const bus = createAsyncCommandBus({ retry: false });
    bus.use(createHttpBridge({ endpoint: '/vc', httpClient: client }));
    const answer = vi.fn((_s: Cart, v: unknown) => v as Cart);
    const cart = defineChamberStore('cart', { state: (): Cart => ({ rev: 0, items: [] }), reducers, answer })(bus);
    const p = cart.add('milk');
    await settle();
    release('milk');
    const r = await p;
    expect(r.ok).toBe(true);
    expect(answer).not.toHaveBeenCalled();
    expect(cart.state.value).toEqual({ rev: 0, items: [] });
    cart.$dispose();
  });
});

/*
 * Two writes in flight can be answered in any order: the server may apply them
 * in either order (two workers), and the replies may arrive in either order.
 * Only the server knows which state is newer, so it says so with a number that
 * grows with every write; the store applies an answer only when that number is
 * higher than the one it holds, the rule `share` applies between tabs. An
 * ETag cannot do this: RFC 9110 defines it for equality, not order. A client
 * order (newest dispatch wins) was rejected: when the server reorders, it keeps
 * the stale state. Without `version` the last reply wins. A handler that
 * returned nothing sends no `state`, and a store must not become `undefined`.
 * Log s35.185.
 */
