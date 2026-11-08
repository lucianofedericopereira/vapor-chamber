/**
 * An optimistic store's rollback the ring moved past is lost, and says so: the `$undo` fails with `store:lost:rollback`.
 * Why: a failed sent action whose step left the ring kept its change while the undo answered ok, so the app showed a change that failed with nothing to tell it.
 * Shows: ring - 1 later writes roll back, ring later writes report the code (with the advice in development, without it in production) and keep the change; on a full ring a sent or local reducer that threw, and a step already undone, report nothing; a store with persist on an async storage does the same.
 * See: src/store-base.ts (`running`, `threw`), docs/store.md.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Accepted } from '../src/accepted';
import { type Command, createAsyncCommandBus } from '../src/command-bus';
import { defineChamberStore } from '../src/store';
import { _UNDO_RING as RING } from '../src/store-base';
import { saveTo } from '../src/store-persist';
import { defineTransport } from '../src/transports';

type Cart = { items: number[]; n: number };
const reducers = {
  add: (s: Cart, x: number) => {
    if (x < 0) throw new Error('bad item');
    return { ...s, items: [...s.items, x] };
  },
  bump: (s: Cart) => ({ ...s, n: s.n + 1 }),
  fail: (): Cart => { throw new Error('local refusal'); },
};
const tick = () => new Promise((r) => setTimeout(r, 0));
const doneOf = async (r: unknown) => ((await r) as { value: Accepted }).value.done;
type Mods = { defineChamberStore: typeof defineChamberStore; createAsyncCommandBus: typeof createAsyncCommandBus; defineTransport: typeof defineTransport };

let disposers: Array<() => void> = [];
afterEach(() => { for (const d of disposers) d(); disposers = []; vi.restoreAllMocks(); vi.resetModules(); });

/** An optimistic cart whose `cartAdd` the server holds until `refuse(k)`, and what was reported. */
function setup(opts: { m?: Mods; persist?: boolean } = {}) {
  const m = opts.m ?? { defineChamberStore, createAsyncCommandBus, defineTransport };
  // A second setup in one test gets the same spy: start it empty.
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  error.mockClear();
  const waiting: Array<(r: unknown) => void> = [];
  const t = m.defineTransport(() => new Promise((a) => waiting.push(a as (r: unknown) => void)));
  const bus = m.createAsyncCommandBus({ retry: false, transport: { cartAdd: t } as never });
  disposers.push(() => bus.dispose());
  // `persist` on an async storage: the store's handlers keep each write for the replay (the kept path).
  const persist = opts.persist ? saveTo<Cart>({ key: 'vc:cart', storage: { getItem: async () => null, setItem: async () => {} } }) : undefined;
  const cart = m.defineChamberStore('cart', { state: (): Cart => ({ items: [], n: 0 }), reducers, optimistic: true, ...(persist ? { persist } : {}) })(bus);
  const bumps = async (k: number) => { for (let i = 0; i < k; i++) await cart.bump(); };
  const refuse = (k: number) => waiting[k]?.({ ok: false, error: new Error('no stock') });
  const reported = () => error.mock.calls.flat().map((x) => (x instanceof Error ? `${x.message} ${String(x.cause ?? '')}` : String(x))).join('\n');
  const lost = () => /is lost, the ring moved past it/.test(reported());
  return { bus, cart, bumps, refuse, reported, lost };
}

/** `before` writes, `add(item)` held, `later` writes, then the server refuses it. */
async function run(later: number, opts: { before?: number; item?: number; m?: Mods; persist?: boolean } = {}) {
  const s = setup(opts);
  await s.bumps(opts.before ?? 0);
  const r = s.cart.add(opts.item ?? 1);
  await tick();
  await s.bumps(later);
  s.refuse(0);
  const done = await doneOf(r);
  return { ok: done.ok, items: s.cart.state.value.items, lost: s.lost(), advised: /keep fewer writes pending/.test(s.reported()) };
}

describe('store:lost:rollback', () => {
  it('rolls back while the ring still holds the step (ring - 1 later writes)', async () => {
    expect(await run(RING - 1)).toEqual({ ok: false, items: [], lost: false, advised: false });
  });

  it('at ring later writes the undo fails with the code and its advice, and the change stays', async () => {
    expect(await run(RING)).toEqual({ ok: false, items: [1], lost: true, advised: true });
  });

  it('production keeps the code without the advice', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.resetModules();
    try {
      const m = { ...(await import('../src/store')), ...(await import('../src/command-bus')), ...(await import('../src/transports')) };
      expect(await run(RING, { m })).toEqual({ ok: false, items: [1], lost: true, advised: false });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('on a full ring, a sent action whose reducer threw showed nothing and reports nothing', async () => {
    expect(await run(10, { before: RING, item: -1 })).toMatchObject({ ok: false, items: [], lost: false });
  });

  it('on a full ring, a local action whose reducer threw reports nothing', async () => {
    const s = setup();
    await s.bumps(RING);
    expect((await doneOf(s.cart.fail())).ok).toBe(false);
    expect(s.lost()).toBe(false);
  });

  it('on a full ring, a second undo of a step already rolled back answers ok', async () => {
    const s = setup();
    let sent: Command | undefined;
    s.bus.use({ id: 'seen', settled: (cmd: Command) => { if (cmd.action === 'cartAdd') sent = cmd; } });
    await s.bumps(RING);
    const r = s.cart.add(1);
    await tick();
    s.refuse(0);
    await doneOf(r);
    expect((await s.bus.dispatch('cartAdd$undo', sent as Command)).ok).toBe(true);
    expect(s.cart.state.value.items).toEqual([]);
  });

  it('a lost rollback is reported while another step is already undone', async () => {
    const s = setup();
    await s.bumps(RING);
    const first = s.cart.add(1);
    await tick();
    s.refuse(0);
    await doneOf(first);
    const second = s.cart.add(2);
    await tick();
    await s.bumps(RING);
    s.refuse(1);
    await doneOf(second);
    expect(s.cart.state.value.items).toEqual([2]);
    expect(s.lost()).toBe(true);
  });

  it('a store with persist on an async storage rolls back and reports the same', async () => {
    expect(await run(3, { persist: true })).toMatchObject({ ok: false, items: [], lost: false });
    expect(await run(RING, { persist: true })).toMatchObject({ ok: false, items: [1], lost: true });
    expect(await run(10, { persist: true, before: RING, item: -1 })).toMatchObject({ ok: false, items: [], lost: false });
  });
});
