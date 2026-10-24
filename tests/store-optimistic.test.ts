/** A store's `optimistic` and `exclusive`: a sent action shows at once, rolls back on a failure, is replaced by the answer; its server commands go one at a time. The long note is at the end. */
import { afterEach, describe, expect, it } from 'vitest';
import type { Accepted } from '../src/accepted';
import { type CommandResult, createAsyncCommandBus } from '../src/command-bus';
import { history } from '../src/plugins-core';
import { defineChamberStore } from '../src/store';
import { defineTransport, httpTransport } from '../src/transports';

type Cart = { items: number[] };
const state = (): Cart => ({ items: [] });
const reducers = {
  add: (s: Cart, n: number) => ({ items: [...s.items, n] }),
  clear: () => ({ items: [] as number[] }),
};
const doneOf = async (r: CommandResult | Promise<CommandResult>): Promise<CommandResult> => ((await r).value as Accepted).done;
const tick = () => new Promise((r) => setTimeout(r, 0));

/** A transport that answers each send when the test says, ok or not. */
function server() {
  const waiting: Array<{ target: number; answer: (r: { ok: boolean; value?: unknown; error?: Error }) => void }> = [];
  const t = defineTransport((cmd: { target: number }) => new Promise((answer) => waiting.push({ target: cmd.target, answer: answer as never })));
  return { t, waiting };
}

let buses: Array<{ dispose(): void }> = [];
afterEach(() => { for (const b of buses) b.dispose(); buses = []; });
const busWith = (t: unknown) => { const b = createAsyncCommandBus({ retry: false, transport: { 'cart*': t } as never }); buses.push(b); return b; };

describe('a store with optimistic: true', () => {
  it('a sent action shows at once, before the server answers', async () => {
    const { t, waiting } = server();
    const cart = defineChamberStore('cart', { state, reducers, optimistic: true })(busWith(t));
    const r = cart.add(1);
    await tick();
    expect(cart.state.value.items).toEqual([1]);
    expect(waiting).toHaveLength(1);
    waiting[0]?.answer({ ok: true, value: undefined });
    expect((await doneOf(r)).ok).toBe(true);
    expect(cart.state.value.items).toEqual([1]);
  });

  it('a failure rolls the change back; a later step stays, rebased', async () => {
    const { t, waiting } = server();
    const cart = defineChamberStore('cart', { state, reducers, optimistic: true })(busWith(t));
    const first = cart.add(1);
    const second = cart.add(2);
    await tick();
    expect(cart.state.value.items).toEqual([1, 2]);
    waiting[0]?.answer({ ok: false, error: new Error('refused') });
    expect((await doneOf(first)).ok).toBe(false);
    expect(cart.state.value.items).toEqual([2]);
    waiting[1]?.answer({ ok: true, value: undefined });
    expect((await doneOf(second)).ok).toBe(true);
  });

  it("the answer replaces the change shown", async () => {
    let answer!: () => void;
    const post = async () => { await new Promise<void>((r) => { answer = r; }); return { ok: true, status: 200, data: { state: { items: [1, 99] } }, headers: {} }; };
    const cart = defineChamberStore('cart', { state, reducers, optimistic: true, answer: (_s, value) => value as Cart })(busWith(httpTransport({ endpoint: '/vc', httpClient: { post } as never })));
    const r = cart.add(1);
    await tick();
    expect(cart.state.value.items).toEqual([1]);
    answer();
    await doneOf(r);
    expect(cart.state.value.items).toEqual([1, 99]);
  });

  it('a refused command never shows', async () => {
    const { t } = server();
    const bus = busWith(t);
    bus.use({ id: 'gate', authorize: () => async () => ({ ok: false, value: undefined, error: new Error('no') }) });
    const cart = defineChamberStore('cart', { state, reducers, optimistic: true })(bus);
    const seen: number[][] = [];
    cart.$onField('items', (v) => { seen.push(v); });
    expect((await cart.add(1)).ok).toBe(false);
    expect(seen).toEqual([]);
    expect(cart.state.value.items).toEqual([]);
  });

  it('history cannot undo it unless the store declares undo', async () => {
    const { t, waiting } = server();
    const bus = busWith(t);
    const cart = defineChamberStore('cart', { state, reducers, optimistic: true })(bus);
    const h = history({ bus });
    const r = cart.add(1);
    await tick();
    waiting[0]?.answer({ ok: true, value: undefined });
    await doneOf(r);
    await h.undo();
    expect(cart.state.value.items).toEqual([1]);
  });
});

describe('a store with exclusive: true', () => {
  it('its sent commands go one at a time, in order; the change still shows at once', async () => {
    const { t, waiting } = server();
    const cart = defineChamberStore('cart', { state, reducers, optimistic: true, exclusive: true })(busWith(t));
    const a = cart.add(1);
    const b = cart.add(2);
    await tick();
    expect(cart.state.value.items).toEqual([1, 2]);
    expect(waiting.map((w) => w.target)).toEqual([1]);
    waiting[0]?.answer({ ok: true, value: undefined });
    await doneOf(a);
    await tick();
    expect(waiting.map((w) => w.target)).toEqual([1, 2]);
    waiting[1]?.answer({ ok: true, value: undefined });
    expect((await doneOf(b)).ok).toBe(true);
  });

  it('a local action of the store does not wait for the sent ones', async () => {
    const { t, waiting } = server();
    const bus = createAsyncCommandBus({ retry: false, transport: { cartAdd: t } as never });
    buses.push(bus);
    const cart = defineChamberStore('cart', { state, reducers: { ...reducers, add: null }, exclusive: true })(bus);
    void cart.add(1);
    await tick();
    expect(waiting).toHaveLength(1);
    expect((await cart.clear()).ok).toBe(true);
  });
});

describe('refused with coalesce', () => {
  it('optimistic and coalesce do not go together, coded and named', () => {
    let error: { code?: string; message: string } | undefined;
    try { defineChamberStore('cart', { state, reducers, optimistic: true, coalesce: true }); } catch (e) { error = e as never; }
    expect(error?.code).toBe('store:invalid:coalesce');
    expect(error?.message).toContain('coalesce and optimistic');
  });
});

describe('control: a store with neither', () => {
  it('a sent action leaves the state until an answer writes it', async () => {
    const { t, waiting } = server();
    const cart = defineChamberStore('cart', { state, reducers: { add: null } })(busWith(t));
    const r = cart.add(1);
    await tick();
    expect(cart.state.value.items).toEqual([]);
    waiting[0]?.answer({ ok: true, value: undefined });
    expect((await r).ok).toBe(true);
  });
});

/*
 * Plan 1.32 4.2 and step 4k, owner 2026-10-20: "the same two words on the store". With
 * `optimistic`, a store action a transport sends applies its reducer when the plugins hand
 * on, before any turn is waited for, so the change shows at dispatch (plan-architecture row
 * 112). A failure rolls it back through the store's ring, rebasing the later steps; the
 * answer replaces it; a plugin's refusal never shows it (row 5). With `exclusive`, the
 * store's sent commands share one key, the store's id, so the server applies and answers
 * them in order (the `serialize` lane docs/store.md described). A local action keys to null:
 * a reducer queued behind a server command would wait on itself.
 */
